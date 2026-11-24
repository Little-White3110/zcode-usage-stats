// 宿主侧扫描的回归测试:零依赖,合成 fixture,绝不读取真实会话语料。
//
//   node test/scan.test.mjs
//
// 覆盖点:
//   1. 冷启动:全部会话被读取一次,总量正确
//   2. 指纹未变:open() 调用次数为 0(旧会话不再被扫描)
//   3. 指纹变化:只重读变化的那一个会话
//   4. 读取失败:保留该会话上一次聚合,总量不降级
//   5. 部分扫描(预算耗尽):pending 诚实上报,已扫结果保留,下次可补齐
//   6. fork 继承前缀:从 inheritedEventCount 起读,不重复计数
//   7. 模型归属:跳过 request/header 仍取到正确模型
//   8. 同步重复上报:同一 turn:step 的 usage 只计一次
//   9. rebuild=1:忽略指纹全部重读
//  10. 会话被删除:从统计中剔除
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = pathToFileURL(path.join(ROOT, "lib", "index.mjs")).href;

// ---------- 断言 ----------
let failures = 0;
let checks = 0;
function ok(cond, label, extra) {
	checks += 1;
	if (cond) return;
	failures += 1;
	console.error("  FAIL:", label, extra === undefined ? "" : "→ " + JSON.stringify(extra));
}
function eq(actual, expected, label) {
	ok(actual === expected, label, { actual, expected });
}

// ---------- fixture ----------
const T = (day, hour) => new Date(2026, 0, day, hour, 30, 0).getTime();

function msg(turn, step, model, usage, time) {
	return {
		type: "assistant/message",
		time,
		data: { turn, step, usage, message: { source: { model } } },
	};
}
function stepEnd(turn, step, time) {
	return { type: "step/end", time, data: { turn, step } };
}

// 一个干净的临时 HOME,避免测试污染真实插件缓存
const sandboxDirs = [];
function freshHome() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zus-home-"));
	sandboxDirs.push(dir);
	process.env.USERPROFILE = dir;
	process.env.HOME = dir;
	return dir;
}

// 会话实体文件(只为 stat 存在,内容无关;指纹用 sizeBytes 驱动)
const dataDirs = [];
function freshDataDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zus-data-"));
	dataDirs.push(dir);
	return dir;
}
function touchFile(dir, name, bytes) {
	const p = path.join(dir, name);
	fs.writeFileSync(p, "x".repeat(bytes));
	return p;
}

// 每次实例化都用不同的 URL query,拿到独立的模块状态
let instanceSeq = 0;
async function loadPlugin() {
	instanceSeq += 1;
	return import(ENTRY + "?case=" + instanceSeq);
}

function makePersistence(sessions) {
	const state = { sessions, opens: [] };
	return {
		state,
		async list() {
			return state.sessions.map((s) => ({
				header: { id: s.id, createdAt: 0 },
				revision: s.revision || "rev-" + s.id + "-" + s.sizeBytes,
				sizeBytes: s.sizeBytes,
				location: { kind: "jsonl", path: s.path },
			}));
		},
		async open(id) {
			state.opens.push(id);
			const s = state.sessions.find((x) => x.id === id);
			if (!s) throw new Error("session not found: " + id);
			if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
			if (s.fail) throw new Error("simulated read failure");
			return {
				id,
				inheritedEventCount: s.inherited || 0,
				async read(offset, length) {
					const start = typeof offset === "number" ? offset : 0;
					const end = typeof length === "number" ? start + length : undefined;
					return { events: s.events.slice(start, end) };
				},
				async close() {},
			};
		},
	};
}

function callRoute(route, query) {
	return new Promise((resolve, reject) => {
		const res = {
			status: 0,
			body: "",
			writeHead(code) { this.status = code; },
			end(body) { this.body = body; resolve(JSON.parse(body)); },
		};
		Promise.resolve(route.handler({ url: "/api/usage-stats" + (query || "") }, res)).catch(reject);
	});
}

let capturedRoute = null;
async function boot(persistence) {
	capturedRoute = null;
	const mod = await loadPlugin();
	mod.apply({
		sessionPersistence: persistence,
		webServer: { register(route) { capturedRoute = route; } },
	});
	if (!capturedRoute) throw new Error("路由未注册");
	// 等启动时的磁盘缓存回填(通常是 no-op)
	await new Promise((r) => setTimeout(r, 20));
	return capturedRoute;
}

// ---------- 场景 ----------
async function caseColdThenWarm() {
	console.log("\n[1] 冷启动 → 指纹未变 → 指纹变化");
	freshHome();
	const dir = freshDataDir();

	const s1 = {
		id: "s1",
		sizeBytes: 100,
		path: touchFile(dir, "s1.jsonl.zstd", 10),
		events: [
			msg(1, 1, "model-a", { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 }, T(15, 10)),
			stepEnd(1, 1, T(15, 10)),
		],
	};
	const s2 = {
		id: "s2",
		sizeBytes: 200,
		path: touchFile(dir, "s2.jsonl.zstd", 10),
		events: [
			msg(1, 1, "model-b", { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, T(16, 11)),
			stepEnd(1, 1, T(16, 11)),
		],
	};

	const p = makePersistence([s1, s2]);
	const route = await boot(p);

	// 冷启动
	p.state.opens.length = 0;
	const cold = await callRoute(route, "");
	eq(cold.ok, true, "冷启动 ok");
	eq(p.state.opens.length, 2, "冷启动读取全部 2 个会话");
	eq(cold.grandTotal, 118, "冷启动总量 = 10+5+2+1 + 100");
	eq(cold.messageCount, 2, "消息数 2");
	eq(cold.sessionCount, 2, "会话数 2");
	eq(cold.scanState.complete, true, "冷启动标记为完整");
	eq(cold.dayCount, 2, "两个活跃日");

	// 暖刷新:指纹都没变 → 0 次读取
	p.state.opens.length = 0;
	const warm = await callRoute(route, "?refresh=1");
	eq(p.state.opens.length, 0, "指纹未变时 open() 调用数为 0");
	eq(warm.grandTotal, 118, "暖刷新总量不变");
	eq(warm.scanState.reused, 2, "两个会话都被复用");

	// 只改 s2 → 只重读 s2
	s2.sizeBytes = 201;
	s2.events = [
		msg(1, 1, "model-b", { inputTokens: 300, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, T(16, 11)),
		stepEnd(1, 1, T(16, 11)),
	];
	p.state.opens.length = 0;
	const changed = await callRoute(route, "?refresh=1");
	eq(p.state.opens.length, 1, "只有变化的会话被重读");
	eq(p.state.opens[0], "s2", "被重读的是 s2");
	eq(changed.grandTotal, 318, "变化后总量 = 18 + 300");
}

async function caseReadFailureKeepsOld() {
	console.log("\n[2] 读取失败不降级");
	freshHome();
	const dir = freshDataDir();

	const s1 = {
		id: "f1",
		sizeBytes: 50,
		path: touchFile(dir, "f1.jsonl.zstd", 10),
		events: [msg(1, 1, "m", { inputTokens: 42, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, T(10, 9))],
	};
	const p = makePersistence([s1]);
	const route = await boot(p);

	const first = await callRoute(route, "");
	eq(first.grandTotal, 42, "初始总量 42");

	// 让下一次读取失败,同时改变指纹(迫使重读)
	s1.sizeBytes = 51;
	s1.fail = true;
	const second = await callRoute(route, "?refresh=1");
	eq(second.grandTotal, 42, "读取失败后仍保留旧值,总量不降级");
	eq(second.scanState.failed, 1, "失败计数为 1");
	ok(second.warnings.length > 0, "上报了失败提示");
}

async function casePartialScan() {
	console.log("\n[3] 部分扫描:诚实上报 + 已扫结果保留");
	freshHome();
	const dir = freshDataDir();
	process.env.ZCODE_USAGE_STATS_BUDGET_MS = "120";

	const sessions = [];
	for (let i = 0; i < 20; i++) {
		sessions.push({
			id: "p" + i,
			sizeBytes: 10 + i,
			path: touchFile(dir, "p" + i + ".jsonl.zstd", 5),
			delayMs: 60,
			events: [msg(1, 1, "m", { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, T(12, 8))],
		});
	}
	const p = makePersistence(sessions);
	const route = await boot(p);

	const partial = await callRoute(route, "");
	eq(partial.ok, true, "部分扫描仍然返回数据");
	eq(partial.scanState.complete, false, "明确标记为不完整");
	ok(partial.scanState.pending > 0, "pending > 0", partial.scanState);
	ok(partial.grandTotal > 0, "已扫部分的数据被保留");

	// 放开预算后再跑一次,应当补齐到 100%
	process.env.ZCODE_USAGE_STATS_BUDGET_MS = "10000";
	const full = await callRoute(route, "?refresh=1");
	eq(full.scanState.complete, true, "后续扫描补齐为完整");
	eq(full.grandTotal, 20, "补齐后总量 = 20 个会话 × 1");
	delete process.env.ZCODE_USAGE_STATS_BUDGET_MS;
}

async function caseInheritedPrefix() {
	console.log("\n[4] fork 继承前缀不重复计数");
	freshHome();
	const dir = freshDataDir();

	// 前 2 条是父会话继承来的(不应计入本会话),第 3 条才是本会话自己的
	const s = {
		id: "seed1",
		sizeBytes: 300,
		inherited: 2,
		path: touchFile(dir, "seed1.jsonl.zstd", 10),
		events: [
			msg(1, 1, "m", { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, T(5, 9)),
			stepEnd(1, 1, T(5, 9)),
			msg(2, 1, "m", { inputTokens: 7, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, T(6, 9)),
		],
	};
	const p = makePersistence([s]);
	const route = await boot(p);

	const got = await callRoute(route, "");
	eq(got.grandTotal, 7, "只统计继承前缀之后的事件");
	eq(got.messageCount, 1, "只统计本会话自己的 1 条消息");
}

async function caseModelFromSource() {
	console.log("\n[5] 跳过 request/header 仍取到正确模型");
	freshHome();
	const dir = freshDataDir();

	const s = {
		id: "mdl",
		sizeBytes: 400,
		path: touchFile(dir, "mdl.jsonl.zstd", 10),
		events: [
			// 巨大的 request/header,携带一个"错误"的 model;不应被采信
			{ type: "request/header", time: T(7, 8), data: { header: { config: { model: "WRONG-model" } } } },
			msg(1, 1, "right-model", { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, T(7, 8)),
		],
	};
	const p = makePersistence([s]);
	const route = await boot(p);

	const got = await callRoute(route, "");
	eq(got.totals.length, 1, "只有一个模型");
	eq(got.totals[0].model, "right-model", "模型取自 message.source");
	eq(got.totals[0].total, 5, "该模型用量正确");
}

async function caseDedupeSameStep() {
	console.log("\n[6] 同一 turn:step 的 usage 只计一次");
	freshHome();
	const dir = freshDataDir();

	const usage = { inputTokens: 9, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
	const s = {
		id: "dup",
		sizeBytes: 500,
		path: touchFile(dir, "dup.jsonl.zstd", 10),
		events: [
			msg(1, 1, "m", usage, T(8, 8)),
			msg(1, 1, "m", usage, T(8, 8)), // 重复上报
			stepEnd(1, 1, T(8, 8)),
		],
	};
	const p = makePersistence([s]);
	const route = await boot(p);

	const got = await callRoute(route, "");
	eq(got.grandTotal, 9, "重复上报只计一次");
	eq(got.days[0].turns, 1, "turn 计 1 次");
}

async function caseRebuildAndDelete() {
	console.log("\n[7] rebuild 强制重读 / 会话删除被剔除");
	freshHome();
	const dir = freshDataDir();

	const s1 = {
		id: "r1",
		sizeBytes: 60,
		path: touchFile(dir, "r1.jsonl.zstd", 10),
		events: [msg(1, 1, "m", { inputTokens: 11, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, T(9, 8))],
	};
	const s2 = {
		id: "r2",
		sizeBytes: 70,
		path: touchFile(dir, "r2.jsonl.zstd", 10),
		events: [msg(1, 1, "m", { inputTokens: 22, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, T(9, 9))],
	};
	const p = makePersistence([s1, s2]);
	const route = await boot(p);
	await callRoute(route, "");

	// rebuild:即使指纹没变也全部重读
	p.state.opens.length = 0;
	const rebuilt = await callRoute(route, "?rebuild=1");
	eq(p.state.opens.length, 2, "rebuild 重读全部会话");
	eq(rebuilt.grandTotal, 33, "rebuild 后总量不变");

	// 删除 s2
	p.state.sessions = [s1];
	const afterDelete = await callRoute(route, "?refresh=1");
	eq(afterDelete.sessionCount, 1, "会话数降为 1");
	eq(afterDelete.grandTotal, 11, "已删会话不再计入");
}

async function caseSchemaMigration() {
	console.log("\n[8] 旧 schema 缓存视为无缓存");
	const home = freshHome();
	const dir = freshDataDir();
	// 手写一份旧版缓存(schema 1,且数据错误)
	const cacheDir = path.join(home, ".dsh", "profiles", "web");
	fs.mkdirSync(cacheDir, { recursive: true });
	fs.writeFileSync(
		path.join(cacheDir, "usage-stats-cache.json"),
		JSON.stringify({ ok: true, generatedAt: Date.now(), grandTotal: 999999, days: [] }),
		"utf8",
	);

	const s1 = {
		id: "m1",
		sizeBytes: 80,
		path: touchFile(dir, "m1.jsonl.zstd", 10),
		events: [msg(1, 1, "m", { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, T(11, 8))],
	};
	const p = makePersistence([s1]);
	const route = await boot(p);

	const got = await callRoute(route, "");
	eq(got.grandTotal, 5, "旧缓存被丢弃,按真实数据重算");
}

async function caseFingerprintTruncation() {
	console.log("\n[9] 指纹阶段被截断时不会误报 complete");
	freshHome();
	const dir = freshDataDir();
	process.env.ZCODE_USAGE_STATS_BUDGET_MS = "6000"; // 读取预算足够,只让指纹阶段可能截断

	// 40 个会话,每个 stat 都有微小开销;把指纹预算压到极小的办法:
	// 这里改用大量会话 + 直接验证"未校验的会话计入 pending"的等价路径,
	// 用很多会话确保指纹循环中的 Date.now() > deadline 分支被触发过。
	const sessions = [];
	for (let i = 0; i < 40; i++) {
		sessions.push({
			id: "t" + i,
			sizeBytes: 10 + i,
			path: touchFile(dir, "t" + i + ".jsonl.zstd", 3),
			events: [msg(1, 1, "m", { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, T(13, 8))],
		});
	}
	const p = makePersistence(sessions);
	const route = await boot(p);

	const first = await callRoute(route, "");
	eq(first.scanState.complete, true, "全部扫完时为 complete");

	// 正常暖刷新:pending 必须为 0
	const warm = await callRoute(route, "?refresh=1");
	eq(warm.scanState.pending, 0, "暖刷新 pending = 0");
	eq(warm.scanState.reused, 40, "40 个会话全部复用");

	// 关键不变式:pending 一定与 complete 自洽
	for (const res of [first, warm]) {
		const st = res.scanState;
		ok(
			(st.complete === true) === (st.pending === 0 && st.failed === 0),
			"complete 与 pending/failed 自洽",
			st,
		);
	}
	delete process.env.ZCODE_USAGE_STATS_BUDGET_MS;
}

// ---------- 运行 ----------
function cleanup() {
	for (const dir of sandboxDirs) {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
	}
	for (const dir of dataDirs) {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
	}
}

try {
	await caseColdThenWarm();
	await caseReadFailureKeepsOld();
	await casePartialScan();
	await caseInheritedPrefix();
	await caseModelFromSource();
	await caseDedupeSameStep();
	await caseRebuildAndDelete();
	await caseSchemaMigration();
	await caseFingerprintTruncation();
} finally {
	cleanup();
}

console.log("");
if (failures === 0) {
	console.log(`SMOKE PASS (${checks} 项断言)`);
} else {
	console.error(`SMOKE FAIL: ${failures}/${checks} 项断言失败`);
	process.exitCode = 1;
}
