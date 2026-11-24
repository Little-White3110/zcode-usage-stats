// zcode-usage-stats —— 使用统计(宿主侧)
// 扫描会话存储,回放事件聚合 Token 用量:
//   - 按天聚合(趋势图 + 热力图素材)
//   - 按小时聚合到天(单日窗口"按小时"趋势图素材)
//   - 按模型聚合(仪表盘)
//   - 额外统计:会话数、消息数、活跃天数、当前连续天数、最常用模型
// 暴露 GET /api/usage-stats
//   (无参数) 返回缓存;过期则后台异步增量刷新(SWR)
//   ?refresh=1 校验会话指纹,只重读有变化的会话
//   ?rebuild=1 丢弃每会话缓存,强制全量重解
//
// 性能要点(实测见 README):
//   1. 每会话聚合缓存 + 指纹(sizeBytes:mtimeMs)。旧会话指纹不变 → 零读取,
//      不再每轮全量重解 297MB;暖刷新实测 ~250ms。
//   2. 部分扫描结果按会话"合并"进上一份完整缓存,永不把残缺数据当权威。
//   3. 并发 2(实测吞吐 26.6MB/s,并发 8 反而只有 16.9MB/s)。
//   4. 从 handle.inheritedEventCount 起读,避免 fork 会话重复计继承前缀。
//   5. 逐会话让出事件循环,扫描期间不饿死宿主。
import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const inject = ["sessionPersistence", "webServer"];

// 缓存结构版本:读到不匹配的版本视为无缓存,自动重建一次。
const CACHE_SCHEMA = 2;

// 过期后触发后台增量刷新(SWR)
const CACHE_TTL = 60_000;

// 实测:并发 1→24.2MB/s、2→26.6MB/s、8→16.9MB/s。取 2 同时把峰值内存压到最低。
const SCAN_CONCURRENCY = 2;

// 扫描时间预算:按"这一轮真正要重读多少个会话"给,而不是按缓存是否为空。
// 暖刷新只需读 1~2 个会话时几毫秒就结束;首次/重建需要读几百个时才给到大值。
const MIN_BUDGET_MS = 6_000;
const MAX_BUDGET_MS = 30_000;
const BUDGET_BASE_MS = 8_000;
const BUDGET_PER_SESSION_MS = 60;

// 允许用环境变量压小预算,便于测试"部分扫描"路径与本地排障。
function budgetFor(pendingCount) {
  const override = Number(process.env.ZCODE_USAGE_STATS_BUDGET_MS);
  if (Number.isFinite(override) && override > 0) return override;
  const scaled = BUDGET_BASE_MS + pendingCount * BUDGET_PER_SESSION_MS;
  return Math.max(MIN_BUDGET_MS, Math.min(MAX_BUDGET_MS, scaled));
}

// warnings 只保留有限条,避免 350 个坏会话把响应撑大。
const MAX_WARNINGS = 6;

// 已知模型 → 固定颜色(与「使用统计子组件库」视觉一致);其余按名称散列取调色板
const MODEL_COLORS = {
  "GLM-5.2": "#3d91e7",
  "jiaorong-deepseek-v4-pro": "#41b87b",
  "glm-5.2": "#8c64ef",
  "deepseek-v4-flash": "#ff4d4f",
  "deepseek-v4-pro": "#faad14",
};
const FALLBACK_PALETTE = [
  "#4da6ff", "#50d682", "#a684ff", "#ff7a9e", "#f2b95b",
  "#5ad0ce", "#e07bd0", "#7ac04f", "#e28a5a", "#6d8ef2",
];

function modelColor(model) {
  if (MODEL_COLORS[model]) return MODEL_COLORS[model];
  let h = 0;
  for (let i = 0; i < model.length; i++) h = (h * 31 + model.charCodeAt(i)) >>> 0;
  return FALLBACK_PALETTE[h % FALLBACK_PALETTE.length];
}

// 把 UNIX 毫秒时间戳折叠成本地日期键 YYYY-MM-DD
function dateKey(ms) {
  try {
    const d = new Date(ms);
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  } catch {
    return null;
  }
}

// 本地小时 0-23
function hourOf(ms) {
  try {
    return new Date(ms).getHours();
  } catch {
    return null;
  }
}

// 每会话扫描期间的日期/小时解析缓存。
// 同一个小时桶内的任意时间戳,其本地"日期 + 小时"必然相同(DST 回拨的那一小时
// 两个瞬间的 getHours() 也相同),所以按小时桶记忆是精确的,不是近似。
// 这消除了每个事件构造 Date 的开销(46k assistant/message + 46k step/end)。
function makeClock() {
  let bucket = -1;
  let day = null;
  let hour = null;
  return (ms) => {
    const b = Math.floor(ms / 3_600_000);
    if (b !== bucket) {
      bucket = b;
      day = dateKey(ms);
      hour = hourOf(ms);
    }
    return { day, hour };
  };
}

// ---------- 每会话聚合(紧凑结构,可直接 JSON 序列化) ----------
// { d: { "YYYY-MM-DD": { t: turns, m: { model: [in,out,cacheRead,cacheWrite] } } },
//   h: { "YYYY-MM-DD": { "0".."23": { model: [in,out,cacheRead,cacheWrite] } } },
//   n: messageCount }
// 实测 350 个会话合计约 78KB,最大单会话 0.7KB。
function emptyAgg() {
  return { d: {}, h: {}, n: 0 };
}

function bump(map, model, usage) {
  let arr = map[model];
  if (!arr) {
    arr = [0, 0, 0, 0];
    map[model] = arr;
  }
  arr[0] += typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
  arr[1] += typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
  arr[2] += typeof usage.cacheReadTokens === "number" ? usage.cacheReadTokens : 0;
  arr[3] += typeof usage.cacheWriteTokens === "number" ? usage.cacheWriteTokens : 0;
}

// 把一个会话的事件流折叠成该会话独有的聚合
function foldEvents(events) {
  const agg = emptyAgg();
  const clock = makeClock();
  let currentModel = "other";
  let lastTurn = null;
  const seenSteps = new Set();

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev || typeof ev !== "object") continue;
    const type = ev.type;

    if (type === "assistant/message") {
      agg.n += 1;
      const data = ev.data;
      // usage 只在每步一次的全量 assistant/message 上取;assistant/chunk 的 usage
      // 是同一步的相同全量值,再计会重复,故不再消费。
      if (!data || data.usage === undefined) continue;
      // 优先从消息 source 取模型(v4,实测 100% 存在),再退到消息自身 model 字段,
      // 最后兜底 currentModel。因此无需再解析体积巨大的 request/header(占 5.8% 字节)。
      const src = data.message && data.message.source;
      const model = (src && typeof src.model === "string" && src.model)
        || (typeof data.model === "string" && data.model)
        || currentModel;
      // 同一步可能重复上报全量 usage,按 turn:step 去重
      const turn = data.turn;
      const step = data.step;
      if (typeof turn === "number" && typeof step === "number") {
        const key = `${turn}:${step}`;
        if (seenSteps.has(key)) continue;
        seenSteps.add(key);
      }
      const { day, hour } = clock(ev.time);
      if (!day) continue;
      let d = agg.d[day];
      if (!d) {
        d = { t: 0, m: {} };
        agg.d[day] = d;
      }
      bump(d.m, model, data.usage);
      if (typeof hour === "number") {
        let hd = agg.h[day];
        if (!hd) {
          hd = {};
          agg.h[day] = hd;
        }
        let hm = hd[hour];
        if (!hm) {
          hm = {};
          hd[hour] = hm;
        }
        bump(hm, model, data.usage);
      }
      continue;
    }

    if (type === "step/end") {
      // turns 官方口径:一个新 turn 记 1 次。以 step/end 为权威——每个 step 必然发出,
      // 覆盖 completed/failed/cancelled/max-tokens;而 assistant/message 会漏 cancelled、
      // 多算 max-tokens。
      const data = ev.data;
      if (!data || typeof data.turn !== "number" || data.turn === lastTurn) continue;
      lastTurn = data.turn;
      const { day } = clock(ev.time);
      if (!day) continue;
      let d = agg.d[day];
      if (!d) {
        d = { t: 0, m: {} };
        agg.d[day] = d;
      }
      d.t += 1;
      continue;
    }

    if (type === "request/context") {
      // 轻量兜底(137B/次),仅用于极少数 source.model 缺失的消息
      const data = ev.data;
      if (data && typeof data.model === "string") currentModel = data.model;
    }
  }

  return agg;
}

// 把多个会话的聚合折叠成全局聚合
function foldSessions(sessions, sessionCount) {
  const days = new Map(); // dateKey -> { total, turns, byModel: Map(model->metrics) }
  const hourly = new Map(); // dateKey -> Map<hour, { total, byModel: Map }>
  const modelTotals = new Map();
  let messageCount = 0;

  const ensureDay = (key) => {
    let d = days.get(key);
    if (!d) {
      d = { total: 0, turns: 0, byModel: new Map() };
      days.set(key, d);
    }
    return d;
  };
  const ensureModel = (map, model) => {
    let m = map.get(model);
    if (!m) {
      m = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      map.set(model, m);
    }
    return m;
  };
  const add = (target, arr) => {
    target.input += arr[0] || 0;
    target.output += arr[1] || 0;
    target.cacheRead += arr[2] || 0;
    target.cacheWrite += arr[3] || 0;
    target.total += (arr[0] || 0) + (arr[1] || 0) + (arr[2] || 0) + (arr[3] || 0);
  };

  for (const entry of sessions.values()) {
    const agg = entry && entry.agg;
    if (!agg) continue;
    messageCount += agg.n || 0;

    const ds = agg.d || {};
    for (const date of Object.keys(ds)) {
      const src = ds[date];
      const day = ensureDay(date);
      day.turns += src.t || 0;
      const models = src.m || {};
      for (const model of Object.keys(models)) {
        const arr = models[model];
        add(ensureModel(day.byModel, model), arr);
        add(ensureModel(modelTotals, model), arr);
        day.total += (arr[0] || 0) + (arr[1] || 0) + (arr[2] || 0) + (arr[3] || 0);
      }
    }

    const hs = agg.h || {};
    for (const date of Object.keys(hs)) {
      const hourSrc = hs[date];
      let hm = hourly.get(date);
      if (!hm) {
        hm = new Map();
        hourly.set(date, hm);
      }
      for (const hourKey of Object.keys(hourSrc)) {
        const hour = Number(hourKey);
        let hb = hm.get(hour);
        if (!hb) {
          hb = { total: 0, byModel: new Map() };
          hm.set(hour, hb);
        }
        const models = hourSrc[hourKey] || {};
        for (const model of Object.keys(models)) {
          const arr = models[model];
          add(ensureModel(hb.byModel, model), arr);
          hb.total += (arr[0] || 0) + (arr[1] || 0) + (arr[2] || 0) + (arr[3] || 0);
        }
      }
    }
  }

  // 计算当前连续活跃天数
  let currentStreak = 0;
  const sortedDates = [...days.keys()].sort();
  if (sortedDates.length > 0) {
    const todayKey = dateKey(Date.now());
    const lastActive = sortedDates[sortedDates.length - 1];
    if (lastActive === todayKey) {
      currentStreak = 1;
      const d = new Date();
      while (true) {
        d.setDate(d.getDate() - 1);
        if (days.has(dateKey(d.getTime()))) {
          currentStreak += 1;
        } else {
          break;
        }
      }
    }
  }

  return { days, hourly, modelTotals, sessionCount, messageCount, currentStreak };
}

// ---------- 扫描 ----------

// 让出事件循环:每个会话之间主动 yield,避免长同步块饿死宿主。
function yieldToLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

// 有限并发池:支持截止时间与取消。返回已处理的条数。
async function pool(items, limit, ctx, fn) {
  let i = 0;
  const n = Math.max(1, Math.min(limit || 1, items.length) || 1);
  const workers = Array.from({ length: n }, async () => {
    for (;;) {
      if (ctx.stopped()) return;
      const cur = i++;
      if (cur >= items.length) return;
      try {
        await fn(items[cur], cur);
      } catch (e) {
        ctx.fail(items[cur], e);
      }
      await yieldToLoop();
    }
  });
  await Promise.all(workers);
}

// 解析单个会话的指纹。返回 null 表示"无法便宜判定",调用方必须重读。
// 指纹 = sizeBytes:mtimeMs。宿主 revision 的契约是"仅同一 service 实例内可比",
// 不能跨重启复用,故只用它做进程内快速路径。
async function fingerprintOf(snapshot, prev) {
  const rev = snapshot.revision;
  if (prev && prev.rev && rev && prev.rev === rev && prev.fp) return prev.fp; // 进程内快速路径
  const sizeBytes = typeof snapshot.sizeBytes === "number" ? snapshot.sizeBytes : null;
  const path = snapshot.location && snapshot.location.path;
  if (sizeBytes === null || !path) return null;
  try {
    const st = await stat(path);
    return `${sizeBytes}:${Math.round(st.mtimeMs)}`;
  } catch {
    // 文件刚消失/无权限:交给调用方重读,读取失败会自然被记录
    return null;
  }
}

// 从会话日志读取事件。优先用 DSH 0.2 的 open/read seam,并跳过 fork 继承前缀。
async function readSessionEvents(sessionPersistence, id, signal) {
  if (typeof sessionPersistence.open === "function") {
    const handle = await sessionPersistence.open(id, "read", { signal });
    try {
      const start = typeof handle.inheritedEventCount === "number" ? handle.inheritedEventCount : 0;
      // 一次性读完:宿主每次 read 都会解码整个文件(内部有 2 条 memo),
      // 分块读会在并发下反复触发全量重解码,反而更慢。
      const { events } = await handle.read(start, Number.MAX_SAFE_INTEGER, { signal });
      return events || [];
    } finally {
      try { await handle.close(); } catch { /* 忽略关闭失败 */ }
    }
  }
  // 旧版(0.1.x)seam:readFrom(id, from)
  const { events } = await sessionPersistence.readFrom(id, 0);
  return events || [];
}

// 增量扫描:只重读指纹变化的会话,复用其余会话上一次的聚合。
// force=true 表示"忽略指纹、全部重读"(rebuild),但仍保留旧聚合作为读取失败时的兜底,
// 因此强制重建不会让统计暂时归零。
// budgetOf(pendingCount) 在指纹比对之后才调用——预算按"这一轮真正要读几个会话"给,
// 而不是按缓存是否为空给,否则暖刷新会被误判成冷启动。
// 返回合并后的会话表 + 诚实的状态统计。部分扫描不会丢失已完成的进度。
async function scanSessions(sessionPersistence, { prev, force, budgetOf }) {
  const warnings = [];
  const warn = (msg) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(msg);
  };

  // 基线:沿用已有聚合(force 时也保留,仅读取失败的会话继续用旧值兜底)
  const sessions = new Map();
  if (prev) {
    for (const [id, entry] of prev) sessions.set(id, entry);
  }

  let snapshots;
  try {
    snapshots = sessionPersistence.list ? await sessionPersistence.list() : [];
  } catch (e) {
    snapshots = [];
    warn("无法枚举会话:" + (e && e.message ? e.message : e));
    return {
      sessions,
      warnings,
      stats: { total: 0, done: 0, reused: 0, pending: 0, failed: 0 },
    };
  }

  // 归一化快照:新版返回 {header,...},旧版直接返回 header。
  // 同一 session id 可能出现在多个项目目录里(复制/迁移残留),这类会话宿主自己也
  // 无法 open(会报 duplicate),只保留第一条,避免重复计数与无谓重试。
  const items = [];
  const seenId = new Set();
  let duplicates = 0;
  for (const snap of snapshots || []) {
    const header = snap && typeof snap === "object" && snap.header ? snap.header : snap;
    const id = header && header.id;
    if (!id) continue;
    if (seenId.has(id)) {
      duplicates += 1;
      continue;
    }
    seenId.add(id);
    items.push({ id, snapshot: snap });
  }
  if (duplicates > 0) warn(`${duplicates} 个重复的会话 id 已忽略`);

  // 先完整登记本次存储里存在的会话 id,再决定要重读哪些。
  // 顺序很重要:指纹阶段如果中途到点退出,不能把"还没轮到的会话"误判成已删除。
  const seen = seenId;
  for (const id of [...sessions.keys()]) {
    if (!seen.has(id)) sessions.delete(id);
  }

  // 第一遍:廉价指纹比对,挑出确实需要重读的会话。
  // 指纹阶段本身只是 stat,350 个会话约 230ms,用 MIN_BUDGET_MS 兜底足够。
  const fingerprintDeadline = Date.now() + MIN_BUDGET_MS;
  const todo = [];
  let reused = 0;
  let examined = 0;
  let fingerprintTruncated = false;
  for (const item of items) {
    const prevEntry = sessions.get(item.id);
    // 即使 rebuild 也照常算指纹:只是"不拿它做复用判断",算出来存起来,
    // 这样紧接着的下一次刷新就能立即命中,不会白读一轮。
    const fp = await fingerprintOf(item.snapshot, prevEntry);
    examined += 1;
    if (!force && fp && prevEntry && prevEntry.fp === fp && prevEntry.agg) {
      reused += 1;
      continue;
    }
    todo.push({ ...item, fp, prevEntry });
    if (Date.now() > fingerprintDeadline) {
      fingerprintTruncated = true;
      break;
    }
  }
  if (fingerprintTruncated) warn("会话指纹校验超出时间预算,剩余会话沿用上次结果");

  // 预算按本轮到实际要读的会话数决定
  const budgetMs = budgetOf(todo.length);
  const deadline = Date.now() + budgetMs;
  const controller = new AbortController();
  const signal = controller.signal;
  let failed = 0;
  // 到点就取消在途读取:宿主 zstd 解码会在帧间检查 signal,能及时中断,
  // 不会像以前那样等一个大会话慢慢跑完。
  const abortTimer = setTimeout(() => { try { controller.abort(); } catch { /* 已结束 */ } }, budgetMs);
  abortTimer.unref?.();

  const ctx = {
    stopped: () => signal.aborted || Date.now() > deadline,
    fail: (item, e) => {
      // 到点取消算"还没轮到",不是失败——不要拿它污染 warnings
      if (signal.aborted) return;
      failed += 1;
      warn("会话读取失败 " + item.id + ":" + (e && e.message ? e.message : e));
    },
  };

  let done = 0;
  try {
    await pool(todo, SCAN_CONCURRENCY, ctx, async (item) => {
      const events = await readSessionEvents(sessionPersistence, item.id, signal);
      const agg = foldEvents(events);
      // 读到新内容就替换该会话的聚合与指纹;失败则保留旧值(见 ctx.fail)
      sessions.set(item.id, { fp: item.fp, rev: item.snapshot.revision, agg });
      done += 1;
    });
  } finally {
    clearTimeout(abortTimer);
  }

  const pending = todo.length - done;
  // 指纹阶段被截断时,还没被检查的会话同样属于"未完成",必须计入 pending,
  // 否则会误报 complete=true(这正是旧版把 48% 覆盖率标成 ok 的那类错误)。
  const unexamined = items.length - examined;
  const totalPending = pending + unexamined;
  if (pending > 0) {
    warn(`已完成 ${done}/${todo.length} 个会话,剩余将在后台继续`);
  }
  if (unexamined > 0) {
    warn(`另有 ${unexamined} 个会话本轮未做指纹校验,将在后台继续`);
  }

  return {
    sessions,
    warnings,
    stats: { total: items.length, done, reused, pending: totalPending, failed },
  };
}

// ---------- 缓存 ----------
// 内存 + 磁盘双层缓存;SWR:过期后先返回旧数据、后台异步刷新,首屏不因全量扫描阻塞。
let cache = null;            // 给前端的 payload(含 warnings / scanState)
let sessionAggs = new Map(); // 每会话聚合:id -> { fp, rev, agg }
let lastCompleteAt = 0;      // 最近一次"真正扫完全部会话"的时间
let inflight = null;         // 并发重扫互斥:并发期间共享同一份结果

function cacheFilePath() {
  return join(homedir(), ".dsh", "profiles", "web", "usage-stats-cache.json");
}

async function loadDiskCache() {
  try {
    const s = await readFile(cacheFilePath(), "utf8");
    const j = JSON.parse(s);
    if (!j || typeof j !== "object") return null;
    // 旧版本(无 schema 或 schema 不匹配)视为无缓存,自动重建一次
    if (j.schema !== CACHE_SCHEMA) return null;
    return j;
  } catch {
    return null;
  }
}

async function persistDiskCache(data) {
  const p = cacheFilePath();
  const tmp = p + ".tmp";
  try {
    await mkdir(dirname(p), { recursive: true });
    const text = JSON.stringify(data);
    await writeFile(tmp, text, "utf8");
    await rename(tmp, p).catch(() => writeFile(p, text, "utf8"));
  } catch {
    // 写盘失败不影响主流程(下次启动退化回全量扫描)
  }
}

// 把全局聚合转成可序列化、可直接返回给前端的响应结构
function buildCache(s) {
  const dayList = [...s.days.entries()]
    .map(([date, d]) => {
      const hours = [...(s.hourly.get(date) || new Map()).entries()]
        .map(([hour, o]) => ({
          hour,
          total: o.total,
          byModel: [...o.byModel.entries()].map(([model, m]) => ({ model, color: modelColor(model), ...m })),
        }))
        .sort((a, b) => a.hour - b.hour);
      return {
        date,
        total: d.total,
        turns: d.turns,
        byModel: [...d.byModel.entries()].map(([model, m]) => ({ model, color: modelColor(model), ...m })),
        hours: hours.length > 0 ? hours : undefined,
      };
    })
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const totals = [...s.modelTotals.entries()]
    .map(([model, m]) => ({ model, color: modelColor(model), ...m }))
    .sort((a, b) => b.total - a.total);
  const grandTotal = totals.reduce((sum, m) => sum + m.total, 0);
  const top = totals[0];
  const topModel = top
    ? { name: top.model, color: top.color, tokens: top.total, percent: grandTotal > 0 ? Math.round((top.total / grandTotal) * 100) : 0 }
    : null;
  return {
    ok: true,
    generatedAt: Date.now(),
    sessionCount: s.sessionCount,
    messageCount: s.messageCount,
    dayCount: dayList.length,
    currentStreak: s.currentStreak,
    grandTotal,
    topModel,
    totals,
    days: dayList,
  };
}

// 给纯数据 payload 挂上本轮扫描的提示与进度(不写入磁盘,避免下次恢复出过期文案)
function decorate(payload, warnings, stats, lastCompleteAt) {
  return {
    ...payload,
    warnings: warnings || [],
    scanState: {
      total: stats ? stats.total : 0,
      done: stats ? stats.done : 0,
      reused: stats ? stats.reused : 0,
      pending: stats ? stats.pending : 0,
      failed: stats ? stats.failed : 0,
      complete: !!stats && stats.pending === 0 && stats.failed === 0,
      lastCompleteAt,
    },
  };
}

export function apply(ctx) {
  const { sessionPersistence, webServer } = ctx;
  if (!webServer) return;

  // 启动时异步加载磁盘缓存,回填内存(不阻塞 apply)
  loadDiskCache().then((j) => {
    if (!j || !j.payload) return;
    if (cache) return;
    // 恢复每会话聚合。宿主 revision 仅在同一个 service 实例内可比,载入时丢弃,
    // 首轮扫描会改用 sizeBytes:mtimeMs 指纹重新判定。
    const restored = new Map();
    for (const [id, entry] of Object.entries(j.sessions || {})) {
      if (entry && entry.agg) restored.set(id, { fp: entry.fp || null, rev: undefined, agg: entry.agg });
    }
    sessionAggs = restored;
    cache = decorate(j.payload, [], j.stats, j.lastCompleteAt || 0);
    lastCompleteAt = j.lastCompleteAt || 0;
    // 载入后做一次廉价校验:若已过期,后台补一次增量扫描(只读有变化的会话)
    if (Date.now() - (j.payload.generatedAt || 0) > CACHE_TTL) {
      setTimeout(() => { ensureScan({ force: false }).catch(() => {}); }, 2000);
    }
  }).catch(() => {});

  const ensureScan = ({ force = false } = {}) => {
    if (inflight) {
      if (!force) return inflight;
      // rebuild:等当前轮结束,避免复用到按旧口径算出的结果
      return inflight.catch(() => {}).then(() => ensureScan({ force: true }));
    }
    inflight = (async () => {
      const result = await scanSessions(sessionPersistence, {
        prev: sessionAggs,
        force,
        budgetOf: budgetFor,
      });
      sessionAggs = result.sessions;
      // 只有"确实全部扫完"才更新 lastCompleteAt,避免把残缺数据标成完整
      const complete = result.stats.pending === 0 && result.stats.failed === 0;
      if (complete) lastCompleteAt = Date.now();

      // 部分扫描也照常合并:已扫的会话是新鲜的,未扫的保留旧聚合,结果永不降级
      const payload = buildCache(foldSessions(sessionAggs, result.stats.total));
      cache = decorate(payload, result.warnings, result.stats, lastCompleteAt);

      try {
        await persistDiskCache({
          schema: CACHE_SCHEMA,
          lastCompleteAt,
          sessions: Object.fromEntries(
            [...sessionAggs.entries()].map(([id, e]) => [id, { fp: e.fp, agg: e.agg }]),
          ),
          payload,
          stats: result.stats,
        });
      } catch { /* 忽略写盘失败 */ }
      return cache;
    })().catch((e) => {
      cache = { ok: false, error: String(e && e.message ? e.message : e), generatedAt: Date.now() };
    }).finally(() => { inflight = null; });
    return inflight;
  };

  webServer.register({
    kind: "exact",
    path: "/api/usage-stats",
    handler: async (req, res) => {
      const url = new URL(req.url, "http://x");
      const refresh = url.searchParams.get("refresh") === "1";
      const rebuild = url.searchParams.get("rebuild") === "1";
      if (rebuild) {
        // 排障用:忽略指纹全部重读。旧聚合仍作为读取失败时的兜底,不会清零。
        await ensureScan({ force: true });
      } else if (refresh) {
        // 「刷新」:重新校验指纹,只重读有变化的会话
        await ensureScan({ force: false });
      } else if (!cache) {
        // 首次访问且无缓存:必须等一次扫描
        await ensureScan({ force: false });
      } else {
        // 有缓存:立即返回;若过期则后台异步刷新,不阻塞本次响应(SWR)
        if (Date.now() - (cache.generatedAt || 0) > CACHE_TTL) ensureScan({ force: false }).catch(() => {});
      }
      res.writeHead(cache && cache.ok ? 200 : 500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(cache));
    },
  });
}
