/**
 * pi-session-autoname 离线测试（不花 API 调用）
 *
 * 用假的 pi / ctx / modelRegistry 驱动扩展，覆盖：首轮起名、话题迁移改名、
 * 不抖动、超长收敛、用户手动改名让位、强制刷新、摘要过滤工具链、
 * 失败容错、恢复旧会话、开关、git 分支上下文。
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
fs.writeFileSync(
	path.join(DATA_DIR, "config.json"),
	JSON.stringify(
		{
			enabled: true,
			model: "",
			maxChars: 10,
			rulesFile: "naming-rules.md",
			updateEveryTurns: 1,
			minMsBetweenUpdates: 0,
			includeGitBranch: true,
			skipWhenNoUI: true,
			debug: false,
		},
		null,
		2,
	),
);
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

function makeCtx(entries = [], cwd = "/tmp/project-zeth-ai") {
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
const assistantMsg = (text, extra = []) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }, ...extra] },
});

async function fire(event, payload, ctx) {
	const handler = handlers.get(event);
	if (!handler) throw new Error(`no handler for ${event}`);
	await handler({ type: event, ...payload }, ctx);
}

// ── 场景 1：新会话首轮起名（git 分支要进上下文）
console.log("\n场景 1 首轮起名");
const gitRepo = path.join(ROOT, "fake-repo");
fs.mkdirSync(path.join(gitRepo, ".git"), { recursive: true });
fs.writeFileSync(path.join(gitRepo, ".git/HEAD"), "ref: refs/heads/feature/payment\n");
let entries = [userMsg("帮我修一下 zeth 的支付回调签名校验，总是验签失败")];
let ctx = makeCtx(entries, gitRepo);
world.modelCalls.push({ text: '{"title":"zeth 支付修复","status":"进行中","changed":true}' });
await fire("session_start", { reason: "new" }, ctx);
await fire("turn_end", { turnIndex: 0 }, ctx);
await fire("agent_settled", {}, ctx);
await sleep(80);
check("首轮就起了名", world.renames[0] === "zeth 支付修复", `got ${JSON.stringify(world.renames)}`);
check("写了托管标记 entry", world.entries.some((e) => e.customType === "session-autoname"));
const sys1 = world.completions[0].systemPrompt;
check("系统提示带上了命名规则与字符上限", sys1.includes("终端标签栏") && sys1.includes("10 个字符"));
const p1 = world.completions[0].messages[0].content[0].text;
check("用户提示带上了工作区", p1.includes('project="fake-repo"'));
check("用户提示带上了 git 分支", p1.includes('gitBranch="feature/payment"'));
check("无标题时标成 none", p1.includes("<current-title>none</current-title>"));

// ── 场景 2：任务未变 → changed=false，不抖动
console.log("\n场景 2 任务未变不抖动");
entries.push(assistantMsg("已定位到签名拼接顺序问题，正在修。"));
entries.push(userMsg("继续，顺手把单测补上"));
world.modelCalls.push({ text: '{"title":"zeth 支付修复","status":"进行中","changed":false}' });
await fire("turn_end", { turnIndex: 1 }, ctx);
await fire("agent_settled", {}, ctx);
await sleep(80);
check("没有重复改名", world.renames.length === 1, `renames=${JSON.stringify(world.renames)}`);

// ── 场景 3：话题迁移 → 改名
console.log("\n场景 3 话题迁移");
entries.push(assistantMsg("单测通过了。不过我注意到 API 调用层的超时没设。"));
entries.push(userMsg("对，先看这个超时问题"));
world.modelCalls.push({ text: '{"title":"zeth API超时","status":"进行中","changed":true}' });
await fire("turn_end", { turnIndex: 2 }, ctx);
await fire("agent_settled", {}, ctx);
await sleep(80);
check("标题跟着迁移", world.renames[1] === "zeth API超时", `got ${JSON.stringify(world.renames)}`);

// ── 场景 4：超长 → 先给模型一次自压机会，再硬截断
console.log("\n场景 4 超长标题收敛");
entries.push(assistantMsg("超时问题修完了，等你验收。"));
world.modelCalls.push({ text: '{"title":"zeth 支付回调与API超时修复完成待验收","status":"待验收","changed":true}' });
world.modelCalls.push({ text: '{"title":"zeth 超时修复待验收啊","status":"待验收","changed":true}' });
await fire("turn_end", { turnIndex: 3 }, ctx);
await fire("agent_settled", {}, ctx);
await sleep(80);
const last = world.renames[world.renames.length - 1];
check("最终标题 ≤ 10 字符", [...last].length <= 10, `"${last}" 长度 ${[...last].length}`);

// ── 场景 5：用户手动改名 → 自动命名让位
console.log("\n场景 5 用户手动改名让位");
world.name = "我自己起的名字";
const before = world.completions.length;
await fire("session_info_changed", { name: "我自己起的名字" }, ctx);
await fire("turn_end", { turnIndex: 4 }, ctx);
await fire("agent_settled", {}, ctx);
await sleep(80);
check("手动改名后不再调用模型", world.completions.length === before);
check("让位后名字没被覆盖", world.name === "我自己起的名字");

// ── 场景 6：/autoname now 强制改名
console.log("\n场景 6 手动强制刷新");
world.modelCalls.push({ text: '{"title":"zeth 待验收","status":"待验收","changed":true}' });
check("/autoname 已注册", commands.has("autoname"));
await commands.get("autoname").handler("now", ctx);
check("强制刷新生效", world.name === "zeth 待验收", `got ${world.name}`);

// ── 场景 7：摘要只取结论，不取工具链
console.log("\n场景 7 摘要过滤工具链");
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
world.modelCalls.push({ text: '{"title":"zeth 报错排查","status":"进行中","changed":true}' });
await fire("session_start", { reason: "new" }, ctx);
await fire("turn_end", { turnIndex: 0 }, ctx);
await fire("agent_settled", {}, ctx);
await sleep(80);
const digestPrompt = world.completions[world.completions.length - 1].messages[0].content[0].text;
check("摘要含用户与助手结论", digestPrompt.includes("看看这个报错") && digestPrompt.includes("我读一下文件。"));
check("摘要不含工具参数", !digestPrompt.includes("/secret/path.ts"));
check("摘要不含工具输出", !digestPrompt.includes("TOOL_OUTPUT_SHOULD_NOT_APPEAR"));
check("摘要不含思考内容", !digestPrompt.includes("内部思考内容不该外泄"));

// ── 场景 8：模型返回 changed=false 但会话还没名字 → 必须补上名字
console.log("\n场景 8 无标题时不能听信 changed=false");
world.name = undefined;
entries = [userMsg("随便聊聊")];
ctx = makeCtx(entries);
world.modelCalls.push({ text: '{"title":"闲聊","status":"进行中","changed":false}' });
await fire("session_start", { reason: "new" }, ctx);
await fire("turn_end", { turnIndex: 0 }, ctx);
await fire("agent_settled", {}, ctx);
await sleep(80);
check("仍然写入了标题", world.name === "闲聊", `got ${world.name ?? "(未命名)"}`);

// ── 场景 9：模型把占位词当标题吐回来 → 丢掉
console.log("\n场景 9 占位词兜底");
world.name = undefined;
ctx = makeCtx([userMsg("再来一段")]);
world.modelCalls.push({ text: '{"title":"未命名","status":"进行中","changed":true}' });
await fire("session_start", { reason: "new" }, ctx);
await fire("turn_end", { turnIndex: 0 }, ctx);
await fire("agent_settled", {}, ctx);
await sleep(80);
check("占位词没写进标题", world.name === undefined, `got ${world.name ?? "(未命名)"}`);

// ── 场景 10：模型失败不崩、不污染、写日志
console.log("\n场景 10 失败容错");
world.modelCalls.push({ throw: "boom: 429 rate limited" });
const namesBefore = world.renames.length;
await fire("turn_end", { turnIndex: 1 }, ctx);
await fire("agent_settled", {}, ctx);
await sleep(80);
check("调用失败不抛异常、不改名", world.renames.length === namesBefore);
const logFile = path.join(DATA_DIR, "autoname.log");
check("失败写进了日志", fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes("429"));

// ── 场景 11：resume 带着别人起的名字 → 不动
console.log("\n场景 11 恢复旧会话尊重既有名字");
world.name = "上周的旧会话";
world.modelCalls.length = 0;
ctx = makeCtx([userMsg("继续之前的活"), { type: "session_info", name: "上周的旧会话" }]);
await fire("session_start", { reason: "resume" }, ctx);
await fire("turn_end", { turnIndex: 0 }, ctx);
await fire("agent_settled", {}, ctx);
await sleep(80);
check("未托管的历史会话不再自动改名", world.modelCalls.length === 0 && world.name === "上周的旧会话");

// ── 场景 12：/autoname off
console.log("\n场景 12 关闭开关");
ctx = makeCtx([userMsg("新话题")]);
await fire("session_start", { reason: "new" }, ctx);
await commands.get("autoname").handler("off", ctx);
world.modelCalls.length = 0;
await fire("turn_end", { turnIndex: 0 }, ctx);
await fire("agent_settled", {}, ctx);
await sleep(80);
check("off 后不再请求模型", world.modelCalls.length === 0);

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "全部通过 ✅" : `${failed} 项失败 ❌`}`);
process.exit(failed === 0 ? 0 : 1);
