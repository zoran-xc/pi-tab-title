/**
 * pi-session-autoname 离线测试（不花 API 调用）
 *
 * 用假的 pi / ctx / modelRegistry 驱动扩展，覆盖：首轮起名、改名节奏（空闲/每 N 轮）、
 * 话题迁移改名、不抖动、超长收敛、手动改名记入历史、强制刷新、摘要过滤工具链、
 * 中断 → 待审核、终端标题模板、失败容错、恢复旧会话、开关、git 分支上下文。
 *
 * 跑法：node tests/run.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "extensions", "session-autoname.ts");

// ── 隔离环境：假的 @earendil-works/pi-coding-agent（扩展只用 getAgentDir 一个值导入）
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-autoname-test-"));
const DATA_DIR = path.join(ROOT, "data");
const NM = path.join(ROOT, "node_modules/@earendil-works/pi-coding-agent");
fs.mkdirSync(NM, { recursive: true });
fs.writeFileSync(
	path.join(NM, "package.json"),
	JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.0.0", type: "module", main: "index.js" }),
);
fs.writeFileSync(path.join(NM, "index.js"), `export const getAgentDir = () => ${JSON.stringify(ROOT)};\n`);
fs.mkdirSync(DATA_DIR, { recursive: true });

const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const BASE_CONFIG = {
	enabled: true,
	model: "",
	maxChars: 10,
	rulesFile: "naming-rules.md",
	updateEveryTurns: 1,
	idleRenameAfterMs: 600000,
	minMsBetweenUpdates: 0,
	includeGitBranch: true,
	skipWhenNoUI: true,
	debug: false,
	titleTemplate: "",
};
let mtimeBump = 1;
function writeConfig(patch = {}) {
	fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...BASE_CONFIG, ...patch }, null, 2));
	// 配置按 mtime 缓存，测试里保证每次写入 mtime 都往前走
	const t = Date.now() / 1000 + mtimeBump++;
	fs.utimesSync(CONFIG_PATH, t, t);
}
writeConfig();

const extCopy = path.join(ROOT, "index.ts");
fs.copyFileSync(SRC, extCopy);
process.env.PI_AUTONAME_HOME = DATA_DIR;

// ── 断言
let failed = 0;
function check(label, ok, extra = "") {
	console.log(`${ok ? "  ✅" : "  ❌"} ${label}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failed += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 假 world
const world = { name: undefined, renames: [], titles: [], completions: [], notifies: [], entries: [], modelCalls: [] };

function makeCtx(entries = [], cwd = "/tmp/fake-repo") {
	return {
		ui: {
			notify: (m, t) => world.notifies.push(`${t ?? "info"}: ${m}`),
			setTitle: (t) => world.titles.push(t),
		},
		mode: "tui",
		hasUI: true,
		cwd,
		sessionManager: {
			getEntries: () => entries,
			buildContextEntries: () => entries,
			getSessionFile: () => "/tmp/session.jsonl",
			getLeafId: () => "leaf",
		},
		modelRegistry: {
			getAvailable: () => [{ id: "deepseek-flash", provider: "deepseek" }],
			getAll: () => [{ id: "deepseek-flash", provider: "deepseek" }],
			find: (p, i) => (p === "deepseek" && i === "deepseek-flash" ? { id: i, provider: p } : undefined),
			complete: async (_model, context) => {
				world.completions.push(context);
				const next = world.modelCalls.shift();
				if (!next) throw new Error("unexpected model call");
				if (next.throw) throw new Error(next.throw);
				return { role: "assistant", content: [{ type: "text", text: next.text }], stopReason: "stop" };
			},
		},
		model: { id: "deepseek-flash", provider: "deepseek" },
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	};
}

const handlers = new Map();
const commands = new Map();
const fakePi = {
	on: (event, handler) => handlers.set(event, handler),
	registerCommand: (name, options) => commands.set(name, options),
	appendEntry: (type, data) => world.entries.push({ type: "custom", customType: type, data }),
	getSessionName: () => world.name,
	setSessionName: (name) => {
		world.name = name;
		world.renames.push(name);
		world.entries.push({ type: "session_info", name });
	},
	getAllTools: () => [],
	// pi.exec 实测会让 -p 模式无法退出，扩展不该再用它；这里直接炸掉当护栏
	exec: async () => {
		throw new Error("pi.exec must not be used: it hangs print mode");
	},
};

const mod = await import(pathToFileURL(extCopy).href);
mod.default(fakePi);
check("扩展加载并注册了生命周期钩子", handlers.has("session_start") && handlers.has("agent_settled"));

const userMsg = (text) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistantMsg = (text, extra = [], stopReason = "stop") => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }, ...extra], stopReason },
});

async function fire(event, payload, ctx) {
	const handler = handlers.get(event);
	if (!handler) throw new Error(`no handler for ${event}`);
	await handler({ type: event, ...payload }, ctx);
}
const agentMsg = (text, stopReason = "stop") => ({
	role: "assistant",
	content: [{ type: "text", text }],
	stopReason,
});
/** 完整跑一轮：turn_start → turn_end → agent_settled（等后台改名落地） */
async function runTurn(ctx, turnIndex, message = agentMsg("ok")) {
	await fire("turn_start", { turnIndex }, ctx);
	await fire("turn_end", { turnIndex, message }, ctx);
	await fire("agent_settled", {}, ctx);
	await sleep(60);
}
const lastMarker = () => [...world.entries].reverse().find((e) => e.customType === "session-autoname")?.data;

// ═══ 场景 1：首轮起名（git 分支进上下文）
console.log("\n场景 1 首轮起名");
const gitRepo = path.join(ROOT, "fake-repo");
fs.mkdirSync(path.join(gitRepo, ".git"), { recursive: true });
fs.writeFileSync(path.join(gitRepo, ".git/HEAD"), "ref: refs/heads/feature/payment\n");
let entries = [userMsg("帮我修一下 zeth 的支付回调签名校验，总是验签失败")];
let ctx = makeCtx(entries, gitRepo);
world.modelCalls.push({ text: '{"title":"zeth 支付修复","status":"进行中","project":"","changed":true}' });
await fire("session_start", { reason: "new" }, ctx);
await runTurn(ctx, 0);
check("首轮就起了名", world.renames[0] === "zeth 支付修复", `got ${JSON.stringify(world.renames)}`);
check("写了托管标记 entry", Boolean(lastMarker()));
const sys1 = world.completions[0].systemPrompt;
check("系统提示带上了命名规则与字符上限", sys1.includes("终端标签栏") && sys1.includes("10 个字符"));
check("系统提示要求 project 字段", sys1.includes('"project"') && sys1.includes("待审核"));
const p1 = world.completions[0].messages[0].content[0].text;
check("用户提示带上了工作区", p1.includes('project="fake-repo"'));
check("用户提示带上了 git 分支", p1.includes('gitBranch="feature/payment"'));
check("无标题时标成 none", p1.includes("<current-title>none</current-title>"));

// ═══ 场景 2：任务未变 → changed=false，不抖动
console.log("\n场景 2 任务未变不抖动");
entries.push(assistantMsg("已定位到签名拼接顺序问题，正在修。"));
entries.push(userMsg("继续，顺手把单测补上"));
world.modelCalls.push({ text: '{"title":"zeth 支付修复","status":"进行中","project":"","changed":false}' });
await runTurn(ctx, 1);
check("没有重复改名", world.renames.length === 1, `renames=${JSON.stringify(world.renames)}`);

// ═══ 场景 3：话题迁移 → 改名，旧标题进历史
console.log("\n场景 3 话题迁移 + 旧标题入历史");
entries.push(assistantMsg("单测通过了。不过我注意到 API 调用层的超时没设。"));
entries.push(userMsg("对，先看这个超时问题"));
world.modelCalls.push({ text: '{"title":"zeth API超时","status":"进行中","project":"","changed":true}' });
await runTurn(ctx, 2);
check("标题跟着迁移", world.renames[1] === "zeth API超时", `got ${JSON.stringify(world.renames)}`);
check("旧标题记进历史", JSON.stringify(lastMarker()?.prev) === '["zeth 支付修复"]', `prev=${JSON.stringify(lastMarker()?.prev)}`);

// ═══ 场景 4：超长 → 先让模型自压，再硬截断
console.log("\n场景 4 超长标题收敛");
entries.push(assistantMsg("超时问题修完了，等你审核。"));
world.modelCalls.push({ text: '{"title":"zeth 支付回调与API超时修复完成待审核","status":"待审核","project":"","changed":true}' });
world.modelCalls.push({ text: '{"title":"zeth 超时修复待审核啊","status":"待审核","project":"","changed":true}' });
await runTurn(ctx, 3);
const last = world.renames[world.renames.length - 1];
check("最终标题 ≤ 10 字符", [...last].length <= 10, `"${last}" 长度 ${[...last].length}`);

// ═══ 场景 5：终端标题模板 —— 非当前项目才显示 @项目
console.log("\n场景 5 终端标题模板");
writeConfig({ titleTemplate: "π - {name}{project} {status} {prev}" });
entries.push(userMsg("这个 ymesh 索引慢的问题也看一下"));
world.modelCalls.push({ text: '{"title":"ymesh 索引优化","status":"进行中","project":"ymesh","changed":true}' });
await runTurn(ctx, 4);
const title5 = world.titles[world.titles.length - 1];
check("模板渲染出名字 + @非当前项目", title5?.includes("ymesh 索引优化@ymesh"), `got "${title5}"`);
check("模板带上了状态", title5?.includes("进行中"), `got "${title5}"`);
check("模板带上了旧标题", /\(.*→.*\)|\(.*\)/.test(title5 ?? ""), `got "${title5}"`);
check("没有重复堆分隔符", !/-\s*-/.test(title5 ?? "") && !title5?.endsWith("-"), `got "${title5}"`);

// 同项目时不该出现 @
world.modelCalls.push({ text: '{"title":"ymesh 索引优化","status":"待审核","project":"fake-repo","changed":false}' });
await runTurn(ctx, 5);
const title6 = world.titles[world.titles.length - 1];
check("聊的就是当前项目 → 不显示 @项目", !title6?.includes("@fake-repo") && title6?.includes("待审核"), `got "${title6}"`);

// ═══ 场景 6：中断 → 状态强制待审核
console.log("\n场景 6 中断强制待审核");
world.modelCalls.push({ text: '{"title":"ymesh 索引优化","status":"已完成","project":"","changed":false}' });
await runTurn(ctx, 6, agentMsg("被打断了", "aborted"));
check("中断后状态是待审核", lastMarker()?.status === "待审核", `got ${JSON.stringify(lastMarker()?.status)}`);
check("中断提示进了提示词", world.completions[world.completions.length - 1].messages[0].content[0].text.includes("上一轮被中断或出错"));

// ═══ 场景 7：改名节奏 —— 连续对话每 5 轮一次
console.log("\n场景 7 改名节奏：每 N 轮");
writeConfig({ updateEveryTurns: 5, minMsBetweenUpdates: 0 });
world.name = undefined;
world.modelCalls.length = 0;
world.completions.length = 0;
const cadenceEntries = [userMsg("开始一个新任务")];
ctx = makeCtx(cadenceEntries);
world.modelCalls.push({ text: '{"title":"新任务","status":"进行中","project":"","changed":true}' });
await fire("session_start", { reason: "new" }, ctx);
await runTurn(ctx, 0); // 无标题 → 立刻起名（第 1 次调用）
check("第 1 轮就起名", world.completions.length === 1 && world.name === "新任务");
for (const turn of [1, 2, 3]) {
	cadenceEntries.push(userMsg(`继续 ${turn}`));
	await runTurn(ctx, turn);
}
check("第 2–4 轮不打扰模型", world.completions.length === 1, `completions=${world.completions.length}`);
world.modelCalls.push({ text: '{"title":"新任务 续","status":"进行中","project":"","changed":true}' });
cadenceEntries.push(userMsg("第 5 轮"));
await runTurn(ctx, 4);
check("第 5 轮重新评估", world.completions.length === 2, `completions=${world.completions.length}`);

// ═══ 场景 8：改名节奏 —— 空闲超过阈值后回来
console.log("\n场景 8 改名节奏：空闲后回来");
writeConfig({ updateEveryTurns: 5, idleRenameAfterMs: 10 });
world.modelCalls.push({ text: '{"title":"新任务 续二","status":"进行中","project":"","changed":true}' });
await sleep(25); // 制造「上一轮结束后过了很久才回来」
cadenceEntries.push(userMsg("我又回来了"));
await runTurn(ctx, 5);
check("空闲后这一轮重新评估", world.completions.length === 3 && world.name === "新任务 续二", `completions=${world.completions.length} name=${world.name}`);

// ═══ 场景 9：手动改名不再让位，而是记进历史
console.log("\n场景 9 手动改名：记入历史，不让位");
writeConfig({ updateEveryTurns: 1, idleRenameAfterMs: 600000 });
world.name = "我自己起的名字";
await fire("session_info_changed", { name: "我自己起的名字" }, ctx);
world.modelCalls.push({ text: '{"title":"接管后的名字","status":"进行中","project":"","changed":true}' });
cadenceEntries.push(userMsg("继续干活"));
await runTurn(ctx, 6);
check("插件没让位，继续接管命名", world.name === "接管后的名字", `got ${world.name}`);
check("手动起的名字进了历史", JSON.stringify(lastMarker()?.prev ?? []).includes("我自己起的名字"), `prev=${JSON.stringify(lastMarker()?.prev)}`);

// ═══ 场景 10：/autoname now 强制改名 + /autoname 状态
console.log("\n场景 10 手动强制刷新与状态");
world.modelCalls.push({ text: '{"title":"收尾待审核","status":"待审核","project":"","changed":true}' });
check("/autoname 已注册", commands.has("autoname"));
await commands.get("autoname").handler("now", ctx);
check("强制刷新生效", world.name === "收尾待审核", `got ${world.name}`);
await commands.get("autoname").handler("", ctx);
const statusText = world.notifies[world.notifies.length - 1] ?? "";
check("状态里报了节奏与历史", statusText.includes("空闲 >10 分钟") && statusText.includes("历史标题"), `got "${statusText}"`);

// ═══ 场景 11：摘要只取结论，不取工具链
console.log("\n场景 11 摘要过滤工具链");
writeConfig({ titleTemplate: "" });
const toolEntries = [
	userMsg("看看这个报错"),
	assistantMsg("我读一下文件。", [
		{ type: "toolCall", name: "read", arguments: { path: "/secret/path.ts" }, id: "t1" },
		{ type: "thinking", thinking: "内部思考内容不该外泄" },
	]),
	{ type: "message", message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "TOOL_OUTPUT_SHOULD_NOT_APPEAR" }] } },
];
world.name = undefined;
ctx = makeCtx(toolEntries);
world.modelCalls.push({ text: '{"title":"报错排查","status":"进行中","project":"","changed":true}' });
await fire("session_start", { reason: "new" }, ctx);
await runTurn(ctx, 0);
const digestPrompt = world.completions[world.completions.length - 1].messages[0].content[0].text;
check("摘要含用户与助手结论", digestPrompt.includes("看看这个报错") && digestPrompt.includes("我读一下文件。"));
check("摘要不含工具参数", !digestPrompt.includes("/secret/path.ts"));
check("摘要不含工具输出", !digestPrompt.includes("TOOL_OUTPUT_SHOULD_NOT_APPEAR"));
check("摘要不含思考内容", !digestPrompt.includes("内部思考内容不该外泄"));

// ═══ 场景 12：模型返回 changed=false 但会话还没名字 → 必须补上名字
console.log("\n场景 12 无标题时不能听信 changed=false");
world.name = undefined;
ctx = makeCtx([userMsg("随便聊聊")]);
world.modelCalls.push({ text: '{"title":"闲聊","status":"进行中","project":"","changed":false}' });
await fire("session_start", { reason: "new" }, ctx);
await runTurn(ctx, 0);
check("仍然写入了标题", world.name === "闲聊", `got ${world.name ?? "(未命名)"}`);

// ═══ 场景 13：模型把占位词当标题吐回来 → 丢掉
console.log("\n场景 13 占位词兜底");
world.name = undefined;
ctx = makeCtx([userMsg("再来一段")]);
world.modelCalls.push({ text: '{"title":"未命名","status":"进行中","project":"","changed":true}' });
await fire("session_start", { reason: "new" }, ctx);
await runTurn(ctx, 0);
check("占位词没写进标题", world.name === undefined, `got ${world.name ?? "(未命名)"}`);

// ═══ 场景 14：模型失败不崩、不污染、写日志
console.log("\n场景 14 失败容错");
world.modelCalls.push({ throw: "boom: 429 rate limited" });
const namesBefore = world.renames.length;
await runTurn(ctx, 1);
check("调用失败不抛异常、不改名", world.renames.length === namesBefore);
const logFile = path.join(DATA_DIR, "autoname.log");
check("失败写进了日志", fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes("429"));

// ═══ 场景 15：恢复旧会话时接管，旧名字进括号
console.log("\n场景 15 恢复旧会话：接管并把旧名字放进历史");
world.name = "上周的旧会话";
world.entries.length = 0;
ctx = makeCtx([userMsg("继续之前的活"), { type: "session_info", name: "上周的旧会话" }]);
world.modelCalls.push({ text: '{"title":"继续旧活","status":"进行中","project":"","changed":true}' });
await fire("session_start", { reason: "resume" }, ctx);
await runTurn(ctx, 0);
check("接管并改名", world.name === "继续旧活", `got ${world.name}`);
check("旧名字进了历史", JSON.stringify(lastMarker()?.prev ?? []).includes("上周的旧会话"), `prev=${JSON.stringify(lastMarker()?.prev)}`);

// ═══ 场景 16：/autoname off
console.log("\n场景 16 关闭开关");
ctx = makeCtx([userMsg("新话题")]);
await fire("session_start", { reason: "new" }, ctx);
await commands.get("autoname").handler("off", ctx);
const before16 = world.completions.length;
world.modelCalls.length = 0;
await runTurn(ctx, 0);
check("off 后不再请求模型", world.completions.length === before16);

// ═══ 场景 17：首条消息即刻起名（回归：原来要等 agent 自跑完 settle 才起名）
console.log("\n场景 17 首条消息即刻起名");
writeConfig({ updateEveryTurns: 5, minMsBetweenUpdates: 0 });
world.name = undefined;
world.modelCalls.length = 0;
world.completions.length = 0;
const freshEntries = []; // 会话记录里还没有任何消息（before_agent_start 早于入库）
ctx = makeCtx(freshEntries);
world.modelCalls.push({ text: '{"title":"支付修","status":"进行中","project":"","changed":true}' });
await fire("session_start", { reason: "new" }, ctx);
await fire("before_agent_start", { prompt: "帮我修 zeth 的支付回调验签" }, ctx);
await sleep(60);
check("agent_settled 之前就已经起好名", world.name === "支付修", `got ${world.name ?? "(未命名)"}`);
check("用 prompt 当摘要种子", world.completions[0]?.messages[0].content[0].text.includes("支付回调验签"));
await runTurn(ctx, 0);
check("这一轮收尾不再重复请求", world.completions.length === 1, `completions=${world.completions.length}`);

// ═══ 场景 18：首轮命名失败后，后续轮仍会重试
console.log("\n场景 18 首轮失败后继续重试");
world.name = undefined;
world.modelCalls.length = 0;
world.completions.length = 0;
ctx = makeCtx([]);
world.modelCalls.push({ throw: "boom" });
await fire("session_start", { reason: "new" }, ctx);
await fire("before_agent_start", { prompt: "先随便聊聊" }, ctx);
await sleep(60);
check("第一次失败没有名字", world.name === undefined, `got ${world.name ?? "(未命名)"}`);
world.modelCalls.push({ text: '{"title":"重试成功","status":"进行中","project":"","changed":true}' });
await runTurn(ctx, 0);
check("后续轮重试成功", world.name === "重试成功", `got ${world.name ?? "(未命名)"}`);

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "全部通过 ✅" : `${failed} 项失败 ❌`}`);
process.exit(failed === 0 ? 0 : 1);
