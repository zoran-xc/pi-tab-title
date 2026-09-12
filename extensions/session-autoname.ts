/**
 * session-autoname —— 按对话内容自动维护 pi 会话标题
 *
 * 做的事：
 *   1. 没有标题时（首轮）立即起名，按 naming-rules.md 里你写的命名习惯
 *   2. 之后按节奏重新评估，只喂对话结论（用户说的话 + 助手的结论），
 *      不喂工具调用链、工具输出和 thinking
 *      节奏：上一轮结束后隔了 idleRenameAfterMs（默认 10 分钟）以上才回来 → 重新评估
 *            连续对话 → 每 updateEveryTurns（默认 5）轮评估一次
 *   3. 模型同时给出 status（进行中/待审核/已完成/阻塞）与 project（仅当聊的不是当前工作区）
 *   4. 名字写进 pi 的会话名 → pi 自动同步到终端窗口标题；
 *      若配了 titleTemplate，再用「名字 + 状态 + 非当前项目 + 旧标题」覆盖一次终端标题
 *
 * 配置：~/.pi/agent/session-autoname/config.json（改动即时生效，不用重启 pi）
 * 规则：~/.pi/agent/session-autoname/naming-rules.md（你写命名习惯）
 * 日志：~/.pi/agent/session-autoname/autoname.log（>256KB 自动截断）
 * 数据目录可用环境变量 PI_AUTONAME_HOME 覆盖。
 *
 * 手动控制：/autoname status | now | on | off | config | rules
 */

import fs from "node:fs";
import path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─────────────────────────────────────────── 路径

// 运行期数据放在 pi 的 agent 目录，而不是包目录里：
// 包会被 pi update 重置，配置和命名习惯不能被冲掉。
const DATA_DIR = process.env.PI_AUTONAME_HOME ?? path.join(getAgentDir(), "session-autoname");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const LOG_PATH = path.join(DATA_DIR, "autoname.log");
const MARKER = "session-autoname";

/** 模型偶尔会把占位词当标题吐回来，直接丢掉 */
const PLACEHOLDER_TITLES = new Set(["none", "null", "未命名", "无", "无标题", "新会话", "untitled", "(无)", "（无）", "n/a"]);

// ─────────────────────────────────────────── 配置

type Config = {
	/** 总开关 */
	enabled: boolean;
	/** 起名用的模型："" = 跟当前会话同模型；"provider/model" 或裸 model id */
	model: string;
	/** 标题最大字符数（中文/英文/数字/符号都算 1） */
	maxChars: number;
	/** 命名习惯提示词文件名（相对本目录，或绝对路径） */
	rulesFile: string;
	/** 追加到系统提示的额外指令 */
	extraInstructions: string;
	/** 单次命名请求的 max_tokens */
	maxTokens: number;
	/** 单次命名请求超时（毫秒） */
	timeoutMs: number;
	/** 连续对话时每 N 轮重新评估一次标题 */
	updateEveryTurns: number;
	/** 上一轮结束到这一轮开始隔了这么久（毫秒），就重新评估一次标题 */
	idleRenameAfterMs: number;
	/** 两次命名请求的最小间隔（毫秒），防止连发消息时反复改名 */
	minMsBetweenUpdates: number;
	/** 每条消息喂给模型的字符上限 */
	perMessageChars: number;
	/** 喂给模型的对话摘要总字符上限 */
	maxDigestChars: number;
	/** 摘要里最多包含多少条历史消息（首条永远保留） */
	maxMessages: number;
	/** 是否把助手的回复也喂给模型（关掉就只看用户说了什么） */
	includeAssistant: boolean;
	/**
	 * 终端标题模板。占位符：
	 *   {name}    当前标题
	 *   {status}  进行中 / 待审核 / 已完成 / 阻塞
	 *   {project} 仅当「聊的项目" 当前工作区」时渲染成 @项目短名，否则为空
	 *   {prev}    之前用过的标题，形如 (旧1 → 旧2)
	 *   {turns}   已聊轮数
	 * 空字符串 = 用 pi 默认标题。
	 */
	titleTemplate: string;
	/** {prev} 里最多带几个旧标题 */
	prevTitleCount: number;
	/** 把当前 git 分支写进给模型的上下文（便于判断"聊的项目 vs 所处工作区"） */
	includeGitBranch: boolean;
	/** print 模式（pi -p）下不自动命名，避免额外花销 */
	skipWhenNoUI: boolean;
	/** 出错/改名时在界面上提示 */
	debug: boolean;
};

const DEFAULT_CONFIG: Config = {
	enabled: true,
	model: "",
	maxChars: 10,
	rulesFile: "naming-rules.md",
	extraInstructions: "",
	maxTokens: 200,
	timeoutMs: 20000,
	updateEveryTurns: 5,
	idleRenameAfterMs: 600000,
	minMsBetweenUpdates: 30000,
	perMessageChars: 1200,
	maxDigestChars: 6000,
	maxMessages: 30,
	includeAssistant: true,
	titleTemplate: "π - {name}{project} {prev}",
	prevTitleCount: 2,
	includeGitBranch: true,
	skipWhenNoUI: true,
	debug: false,
};

const DEFAULT_RULES = `# 命名习惯（写给模型看，随便改）

## 我想要什么

标题要让我在终端标签栏里扫一眼，就知道「**在哪个项目上、干什么事、进行到哪一步**」。

## 硬性要求

- 语言与我使用的语言一致（我用中文就用中文）
- 标题 ≤ 10 个字符，超了就砍掉次要信息，但**不要砍掉项目和任务动作**
- 不加书名号、引号、句号、emoji、markdown 标记
- 不要照抄我的话，要总结成名词短语

## 信息优先级（从高到低）

1. **项目/代码库名** —— 用短名，如 \`zeth\`、\`ymesh\`、\`笔记\`
2. **当前在做什么** —— 动词 + 对象，如 \`支付修复\`、\`标题插件\`、\`周计划\`
3. 之前做过什么、接下来做什么 —— 只在标题里能塞下时体现

> 状态（进行中/待审核/已完成/阻塞）和「项目是不是当前目录」由单独字段承载，
> 不要为了塞这些而牺牲 title 里的「项目 + 动作」。

## 特别判断

- 如果**对话聊的项目 ≠ 我当前所处的工作区**（例如我在 zeth-ai 目录里聊 ymesh），
  \`project\` 字段填成 \`ymesh\`；是同一个项目就填空字符串。
- 如果话题发生了迁移（先修支付，改着改着开始调 API 调用），
  标题要跟着迁移到**当下正在做的事**，别停在最开始那件事上。
- 一件事做完了、等我审核 → status 用「待审核」；已确认完成 → 「已完成」；
  卡住了 → 「阻塞」；正常推进 → 「进行中」。
- 任务没变、篇幅变长 → 不改标题（changed=false），不要无意义地抖动。
- 之前用过的标题我会显示在括号里，所以换掉旧标题不会丢信息。
`;

// ─────────────────────────────────────────── 默认文件自举

function ensureDefaults(): void {
	try {
		fs.mkdirSync(DATA_DIR, { recursive: true });
		if (!fs.existsSync(CONFIG_PATH)) {
			fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
		}
		const rulesPath = path.join(DATA_DIR, "naming-rules.md");
		if (!fs.existsSync(rulesPath)) {
			fs.writeFileSync(rulesPath, DEFAULT_RULES, "utf8");
		}
	} catch {
		// 自举失败不阻塞扩展加载，读配置时会退化为内置默认值
	}
}

// ─────────────────────────────────────────── 配置读取（按 mtime 缓存，改了立刻生效）

let configCache: { mtimeMs: number; value: Config } | null = null;

function readConfig(): Config {
	try {
		const stat = fs.statSync(CONFIG_PATH);
		if (configCache && configCache.mtimeMs === stat.mtimeMs) return configCache.value;
		const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
		const value: Config = { ...DEFAULT_CONFIG, ...parsed };
		configCache = { mtimeMs: stat.mtimeMs, value };
		return value;
	} catch {
		return DEFAULT_CONFIG;
	}
}

function readRules(cfg: Config): string {
	try {
		const p = path.isAbsolute(cfg.rulesFile) ? cfg.rulesFile : path.join(DATA_DIR, cfg.rulesFile);
		return fs.readFileSync(p, "utf8").trim();
	} catch {
		return "";
	}
}

// ─────────────────────────────────────────── 日志

function trace(cfg: Config, line: string): void {
	if (cfg.debug) log(`[trace] ${line}`);
}

function log(line: string): void {
	try {
		const stamp = new Date().toISOString();
		fs.appendFileSync(LOG_PATH, `${stamp} ${line}\n`, "utf8");
		const stat = fs.statSync(LOG_PATH);
		if (stat.size > 256 * 1024) {
			const tail = fs.readFileSync(LOG_PATH, "utf8").slice(-128 * 1024);
			fs.writeFileSync(LOG_PATH, tail, "utf8");
		}
	} catch {
		// 日志失败无所谓
	}
}

// ─────────────────────────────────────────── 工具函数

type ChatMessage = { role: string; content: unknown };
type LooseEntry = { type: string; customType?: string; data?: unknown; message?: ChatMessage };

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; text?: string };
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("\n").trim();
}

function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}…`;
}

function normalizeTitle(raw: string): string {
	return raw
		.replace(/[\r\n\t]+/g, " ")
		.replace(/^[#>*\-\s]+/, "")
		.replace(/[*`_]/g, "")
		.replace(/^["'“”‘’《》「」]+|["'“”‘’《》「」。]+$/g, "")
		.replace(/\s{2,}/g, " ")
		.trim();
}

function charCount(s: string): number {
	return [...s].length;
}

function sameTitle(a: string | undefined, b: string | undefined): boolean {
	return (a ?? "").trim() === (b ?? "").trim();
}

function timeoutSignal(ms: number, ctxSignal: AbortSignal | undefined): AbortSignal | undefined {
	try {
		const t = AbortSignal.timeout(ms);
		if (!ctxSignal) return t;
		return typeof AbortSignal.any === "function" ? AbortSignal.any([ctxSignal, t]) : t;
	} catch {
		return ctxSignal;
	}
}

/**
 * 读当前 git 分支。
 * 不用 pi.exec：实测在 -p 模式下调用 pi.exec 会让进程无法退出。
 * 直接读 .git/HEAD，零子进程，同步且必定有界。
 */
function readGitBranch(cwd: string): string {
	try {
		let gitDir = path.join(cwd, ".git");
		if (fs.statSync(gitDir).isFile()) {
			// worktree / submodule：.git 是个文本指针
			const pointer = fs.readFileSync(gitDir, "utf8").trim();
			const match = pointer.match(/^gitdir:\s*(.+)$/i);
			if (!match) return "";
			gitDir = path.resolve(cwd, match[1]);
		}
		const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
		const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
		return ref ? ref[1] : head.slice(0, 7);
	} catch {
		return "";
	}
}

// ─────────────────────────────────────────── 会话状态

type State = {
	/** 本会话的名字是我们起的（持久化标记过） */
	managed: boolean;
	/** /autoname off */
	disabled: boolean;
	turns: number;
	lastRunAt: number;
	/** 上一轮结束的时刻，用来判断「离开了多久才回来」 */
	lastTurnEndedAt: number;
	/** 上一轮结束后隔了很久才继续 → 这轮结束就重新评估标题 */
	idleResume: boolean;
	/** 上一轮被中断或出错 → 状态强制为「待审核」 */
	interrupted: boolean;
	inFlight: boolean;
	dirty: boolean;
	/** 当前状态标签（进行中/待审核/已完成/阻塞） */
	status: string;
	/** 仅当「聊的项目 ≠ 当前工作区」时的项目短名 */
	project: string;
	/** 历史标题，旧的在前 */
	prevTitles: string[];
	/** 最近一条用户 prompt：会话里没内容可摘要时拿来兜底 */
	lastPrompt: string;
	gitBranch: string;
};

function freshState(): State {
	return {
		managed: false,
		disabled: false,
		turns: 0,
		lastRunAt: 0,
		lastTurnEndedAt: 0,
		idleResume: false,
		interrupted: false,
		inFlight: false,
		dirty: false,
		status: "",
		project: "",
		prevTitles: [],
		lastPrompt: "",
		gitBranch: "",
	};
}

// ─────────────────────────────────────────── 扩展本体

export default function sessionAutoname(pi: ExtensionAPI): void {
	ensureDefaults();

	let state = freshState();
	let expectingSelfRename: string | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;

	function clearTimer(): void {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	}

	// ── 模型解析

	function resolveModel(ctx: ExtensionContext): ExtensionContext["model"] {
		const cfg = readConfig();
		const want = cfg.model.trim();
		const registry = ctx.modelRegistry;
		if (!want) return ctx.model;
		const [maybeProvider, maybeId] = want.includes("/") ? want.split("/", 2) : [undefined, want];
		if (maybeProvider && maybeId) {
			const found = registry.find(maybeProvider, maybeId);
			if (found) return found;
		}
		const all = [...registry.getAvailable(), ...registry.getAll()];
		return (
			all.find((m) => m.id === want) ??
			all.find((m) => `${m.provider}/${m.id}` === want) ??
			ctx.model
		);
	}

	// ── 摘要构建：只要结论，不要工具链

	function buildDigest(ctx: ExtensionContext, cfg: Config): string {
		const entries = ctx.sessionManager.getEntries() as unknown as LooseEntry[];
		const lines: string[] = [];
		for (const entry of entries) {
			if (entry.type !== "message" || !entry.message) continue;
			const role = entry.message.role;
			if (role !== "user" && role !== "assistant") continue;
			if (role === "assistant" && !cfg.includeAssistant) continue;
			const text = textOfContent(entry.message.content);
			if (!text) continue;
			lines.push(`[${role === "user" ? "用户" : "助手"}] ${clip(text, cfg.perMessageChars)}`);
		}
		if (lines.length === 0) return "";
		// 首条 + 最近 N 条：首条决定原始意图，近条决定当前状态
		let picked = lines.length <= cfg.maxMessages ? lines : [lines[0], "…", ...lines.slice(-(cfg.maxMessages - 1))];
		let joined = picked.join("\n");
		while (joined.length > cfg.maxDigestChars && picked.length > 2) {
			picked = [picked[0], "…", ...picked.slice(-(picked.length - 2))];
			joined = picked.join("\n");
		}
		return clip(joined, cfg.maxDigestChars);
	}

	// ── 提示词

	function systemPrompt(cfg: Config): string {
		const contract = `你是一个会话标题管理器。唯一输出是一个 JSON 对象，不要输出任何其他文字，不要用 markdown 代码块。

{"title":"<标题>","status":"进行中|待审核|已完成|阻塞","project":"<项目短名或空字符串>","changed":true|false}

规则：
- title ≤ ${cfg.maxChars} 个字符（中文/英文/数字/符号都按 1 个字符算）。
- title 的语言必须与对话中用户使用的语言一致。
- changed=false 表示沿用原标题，此时 title 必须与原标题完全一致。
- 原标题已经准确描述当前状态时，必须 changed=false，不要制造无意义抖动。
- 如果 <current-title> 是 none，说明本会话还没有标题：必须给出新标题并设 changed=true。
- 绝不要把 none / 未命名 / 无标题 / 新会话 这类占位词当成标题输出。
- 话题迁移（换了项目 / 换了任务类型 / 从功能开发转成修 bug）时必须改名。
- status 表示当前进展，独立于 title，不要为了塞状态而牺牲 title 里的项目与动作。
- project 只在「对话讨论的项目 ≠ <workspace> 里的项目」时才填短名（2-8 字符）；同一个项目填空字符串 ""。
- 用户没有提出新要求、只是在追问或确认时，不要把进行中的事改成待审核。`;
		return [contract, readRules(cfg), cfg.extraInstructions].filter((s) => s && s.trim()).join("\n\n");
	}

	function userPrompt(ctx: ExtensionContext, cfg: Config, digest: string, current: string | undefined): string {
		const project = path.basename(ctx.cwd) || ctx.cwd;
		const head = [
			`<workspace cwd="${ctx.cwd}" project="${project}"${state.gitBranch ? ` gitBranch="${state.gitBranch}"` : ""}/>`,
			`<current-title>${current?.trim() ? current.trim() : "none"}</current-title>`,
			`<current-status>${state.status || "未知"}</current-status>`,
			`<turn>${state.turns}</turn>`,
		];
		if (state.interrupted) {
			head.push("<note>上一轮被中断或出错，未正常收尾：status 必须是 待审核。</note>");
		}
		return `${head.join("\n")}\n\n<conversation>\n${digest}\n</conversation>\n\n按你的规则输出 JSON。`;
	}

	// ── 模型调用 + 解析

	type Named = { title: string; status: string; project: string; changed: boolean };

	function parseResult(text: string, current: string | undefined): Named | null {
		const start = text.indexOf("{");
		const end = text.lastIndexOf("}");
		if (start >= 0 && end > start) {
			try {
				const obj = JSON.parse(text.slice(start, end + 1)) as Partial<Named>;
				if (typeof obj.title === "string") {
					return {
						title: normalizeTitle(obj.title),
						status: typeof obj.status === "string" ? normalizeTitle(obj.status) : "",
						project: typeof obj.project === "string" ? normalizeTitle(obj.project) : "",
						changed: obj.changed !== false,
					};
				}
			} catch {
				// 落到下面的纯文本兜底
			}
		}
		const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
		if (!firstLine) return null;
		const cleaned = normalizeTitle(firstLine);
		return cleaned ? { title: cleaned, status: "", project: "", changed: !sameTitle(cleaned, current) } : null;
	}

	async function askModel(
		ctx: ExtensionContext,
		cfg: Config,
		model: NonNullable<ExtensionContext["model"]>,
		digest: string,
		current: string | undefined,
		extra = "",
	): Promise<Named | null> {
		const sys = systemPrompt(cfg) + (extra ? `\n\n${extra}` : "");
		const response = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt: sys,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: userPrompt(ctx, cfg, digest, current) }],
						timestamp: Date.now(),
					},
				],
			},
			{ maxTokens: cfg.maxTokens, signal: timeoutSignal(cfg.timeoutMs, ctx.signal) },
		);
		const text = textOfContent(response.content);
		const failure = (response as { errorMessage?: string }).errorMessage;
		if (!text && failure) throw new Error(failure);
		return parseResult(text, current);
	}

	// ── 终端标题

	/** 把模板补位后留下的空位和重复分隔符收拾干净 */
	function pruneTemplate(text: string): string {
		return text
			.replace(/\s*[-·|]\s*(?=[-·|])/g, " ")
			.replace(/\s*[（(]\s*[)）]\s*/g, " ")
			.replace(/\s{2,}/g, " ")
			.replace(/^\s*[-·|]\s*/, "")
			.replace(/\s*[-·|]\s*$/, "")
			.trim();
	}

	function renderTerminalTitle(cfg: Config, ctx: ExtensionContext, result: Named, current: string | undefined): string {
		const name = result.changed && !sameTitle(result.title, current) ? result.title : (current ?? result.title);
		const prev = state.prevTitles.slice(-Math.max(0, cfg.prevTitleCount));
		// 聊的项目就是当前工作区时不重复显示项目名
		const workspace = (path.basename(ctx.cwd) || "").toLowerCase();
		const offProject = result.project && result.project.toLowerCase() !== workspace ? `@${result.project}` : "";
		return pruneTemplate(
			cfg.titleTemplate
				.replace(/\{name\}/g, name)
				.replace(/\{status\}/g, result.status || state.status || "")
				.replace(/\{project\}/g, offProject)
				.replace(/\{prev\}/g, prev.length ? `(${prev.join(" → ")})` : "")
				.replace(/\{turns\}/g, String(state.turns)),
		);
	}

	// ── 落盘 + 生效

	/** 写入标题；返回是否真的改了名，以及渲染出的终端标题 */
	function apply(
		ctx: ExtensionContext,
		cfg: Config,
		result: Named,
		current: string | undefined,
	): { renamed: boolean; terminal: string } {
		state.managed = true;

		const renamed = result.changed && !sameTitle(result.title, current);
		if (renamed && current?.trim()) {
			state.prevTitles.push(current.trim());
			state.prevTitles = state.prevTitles.filter((t, i, all) => i === 0 || t !== all[i - 1]).slice(-8);
		}
		if (result.status) state.status = result.status;
		state.project = result.project;

		pi.appendEntry(MARKER, {
			title: result.title,
			status: state.status,
			project: state.project,
			prev: state.prevTitles.slice(-3),
			turns: state.turns,
			at: new Date().toISOString(),
		});

		if (renamed) {
			expectingSelfRename = result.title;
			pi.setSessionName(result.title); // pi 会自动把终端标题刷成 "π - <名字> - <目录>"
		}

		// 在 pi 刷完之后再覆盖一次（同步调用，后写的赢）：状态、非当前项目、旧名字都在这里体现
		let terminal = "";
		if (cfg.titleTemplate) {
			terminal = renderTerminalTitle(cfg, ctx, result, current);
			if (terminal) ctx.ui.setTitle(terminal);
		}

		if (cfg.debug) {
			ctx.ui.notify(`标题：${result.title}${renamed ? "（已更新）" : "（未变）"}｜${state.status}`, "info");
		}
		return { renamed, terminal };
	}

	// ── 命名主流程

	async function runRename(ctx: ExtensionContext, force: boolean, seedPrompt?: string): Promise<void> {
		const cfg = readConfig();
		if (!cfg.enabled || state.disabled) return;
		if (cfg.skipWhenNoUI && !ctx.hasUI) {
			trace(cfg, "skip: no UI and skipWhenNoUI=true");
			return;
		}
		if (state.inFlight) {
			state.dirty = true;
			return;
		}

		const digest = buildDigest(ctx, cfg);
		// 会话里没内容可摘要时（首条消息尚未入库 / 重试）用最近的 prompt 兜底
		const seed = seedPrompt ?? state.lastPrompt;
		const effectiveDigest = digest || (seed ? `[用户] ${clip(seed, cfg.perMessageChars)}` : "");
		trace(cfg, `run: force=${force} turns=${state.turns} digest=${digest.length} seed=${seedPrompt ? "yes" : "no"}`);
		if (!effectiveDigest) return;

		const model = resolveModel(ctx);
		if (!model) {
			log("skip: no model available");
			return;
		}

		state.inFlight = true;
		state.lastRunAt = Date.now();
		const wasInterrupted = state.interrupted;
		const current = pi.getSessionName();
		trace(cfg, `calling model ${model.provider}/${model.id}`);
		try {
			let result = await askModel(ctx, cfg, model, effectiveDigest, current);
			trace(cfg, `model returned title="${result?.title ?? "(null)"}"`);
			if (!result) {
				log("skip: unparseable model output");
				return;
			}
			// 超长先给模型一次机会自我压缩，仍超长才硬截断
			if (charCount(result.title) > cfg.maxChars) {
				const stricter = `上一次输出 "${result.title}" 有 ${charCount(result.title)} 个字符，超过 ${cfg.maxChars} 的限制。这次必须严格 ≤ ${cfg.maxChars} 个字符，牺牲次要信息也要保住「项目 + 当前动作」。`;
				const retried = await askModel(ctx, cfg, model, effectiveDigest, current, stricter);
				if (retried && charCount(retried.title) <= charCount(result.title)) result = retried;
			}
			if (charCount(result.title) > cfg.maxChars) {
				const truncated = [...result.title].slice(0, cfg.maxChars).join("");
				log(`truncate: "${result.title}" -> "${truncated}"`);
				result = { ...result, title: truncated };
			}
			if (!result.title) return;
			// 会话还没名字时不能信 changed=false：模型很容易把「沿用原标题」当成字面意思照做
			if (!current?.trim()) result = { ...result, changed: true };
			// 被中断的一轮不可能算完成，状态是确定性的，不交给模型赌
			if (wasInterrupted) result = { ...result, status: "待审核" };
			if (PLACEHOLDER_TITLES.has(result.title.toLowerCase())) {
				log(`skip: placeholder title "${result.title}"`);
				return;
			}
			const outcome = apply(ctx, cfg, result, current);
			log(
				`${outcome.renamed ? "renamed" : "kept"}: "${current ?? ""}" -> "${result.title}"  [${result.status}${result.project ? ` @${result.project}` : ""}] turns=${state.turns} prev=${state.prevTitles.length}${outcome.terminal ? ` terminal="${outcome.terminal}"` : ""}`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log(`error: ${message}`);
			if (cfg.debug) ctx.ui.notify(`自动命名失败：${message}`, "warning");
		} finally {
			// 这两个标志描述「刚结束的那一轮」，用完即消（构建提示词时还得看得到）
			state.idleResume = false;
			state.interrupted = false;
			state.inFlight = false;
			if (state.dirty) {
				state.dirty = false;
				schedule(ctx, 1000, false);
			}
		}
	}

	function schedule(ctx: ExtensionContext, delay: number, force: boolean, seedPrompt?: string): void {
		clearTimer();
		timer = setTimeout(() => {
			timer = null;
			void runRename(ctx, force, seedPrompt);
		}, delay);
		if (typeof timer === "object" && "unref" in timer) timer.unref?.();
	}

	/** 该不该现在重新评估标题 */
	function shouldRename(force: boolean): boolean {
		if (force) return true;
		if (!pi.getSessionName()?.trim()) return true; // 还没有标题：第一轮就起名
		if (state.idleResume) return true; // 上一轮结束后离开很久才回来
		return state.turns % Math.max(1, readConfig().updateEveryTurns) === 0;
	}

	function maybeRename(ctx: ExtensionContext, force: boolean, seedPrompt?: string): void {
		const cfg = readConfig();
		if (!cfg.enabled || state.disabled) {
			trace(cfg, `maybeRename: skip (enabled=${cfg.enabled} disabled=${state.disabled})`);
			return;
		}
		if (!shouldRename(force)) {
			trace(cfg, `maybeRename: skip (turns=${state.turns} 每 ${cfg.updateEveryTurns} 轮 / idleResume=${state.idleResume})`);
			return;
		}
		const wait = cfg.minMsBetweenUpdates - (Date.now() - state.lastRunAt);
		trace(cfg, `maybeRename: schedule in ${Math.max(0, wait)}ms (turns=${state.turns})`);
		schedule(ctx, !force && wait > 0 ? wait : 0, force, seedPrompt);
	}

	// ── 生命周期

	pi.on("session_start", async (event, ctx) => {
		state = freshState();
		trace(readConfig(), `session_start reason=${event.reason} hasUI=${ctx.hasUI}`);

		const entries = ctx.sessionManager.getEntries() as unknown as LooseEntry[];
		state.managed = entries.some((e) => e.type === "custom" && e.customType === MARKER);
		// 从最近一条托管标记里恢复状态与历史标题，这样重启/恢复后括号里还能看到之前干过什么
		for (let i = entries.length - 1; i >= 0; i -= 1) {
			if (entries[i]?.customType !== MARKER) continue;
			const data = entries[i]?.data as { status?: string; project?: string; prev?: unknown } | undefined;
			if (typeof data?.status === "string") state.status = data.status;
			if (typeof data?.project === "string") state.project = data.project;
			if (Array.isArray(data?.prev)) state.prevTitles = data.prev.filter((t): t is string => typeof t === "string");
			break;
		}

		// 插件开着就接管命名：旧名字（不管谁起的）进历史，显示在括号里
		const existing = pi.getSessionName()?.trim();
		if (existing && !state.managed && !state.prevTitles.includes(existing)) state.prevTitles.push(existing);

		const cfg = readConfig();
		if (cfg.includeGitBranch) state.gitBranch = readGitBranch(ctx.cwd);
	});

	pi.on("session_info_changed", async (event) => {
		const name = event.name ?? "";
		if (expectingSelfRename !== null && sameTitle(name, expectingSelfRename)) {
			expectingSelfRename = null;
			return;
		}
		expectingSelfRename = null;
		if (!name.trim()) return;
		// 不是我们改的（手动 /name、RPC、其他扩展）：记进历史，但不再让位 —— 插件开着就始终由它维护
		if (!state.prevTitles.includes(name)) state.prevTitles.push(name);
		log(`external rename: "${name}" (recorded as previous title)`);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// 首次起名不等 agent 跑完：agent_settled 可能要多等几十轮（agent 自跑），
		// 而用户发出第一条消息时就有 prompt 可用了。
		if (event.prompt?.trim()) state.lastPrompt = event.prompt;
		if (!event.prompt?.trim() || pi.getSessionName()?.trim()) return;
		const cfg = readConfig();
		if (!cfg.enabled || state.disabled) return;
		trace(cfg, "first prompt: naming immediately");
		schedule(ctx, 0, true, event.prompt);
	});

	pi.on("turn_start", async () => {
		// 上一轮结束到我这次开口之间隔了很久 → 这一轮收尾时重新评估标题
		const cfg = readConfig();
		if (state.lastTurnEndedAt > 0 && Date.now() - state.lastTurnEndedAt > cfg.idleRenameAfterMs) {
			state.idleResume = true;
			trace(cfg, `idle resume: ${Math.round((Date.now() - state.lastTurnEndedAt) / 60000)} 分钟`);
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		state.turns = Math.max(state.turns, (event.turnIndex ?? 0) + 1);
		state.lastTurnEndedAt = Date.now();
		const message = event.message as { role?: string; stopReason?: string } | undefined;
		trace(readConfig(), `turn_end turns=${state.turns} role=${message?.role ?? "?"} stop=${message?.stopReason ?? "?"}`);
		if (message?.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error")) {
			state.interrupted = true;
		}
		// 还没名字（首轮命名失败或被跳过）→ 继续重试，受 minMsBetweenUpdates 节流
		if (!pi.getSessionName()?.trim()) maybeRename(ctx, false);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		trace(readConfig(), `agent_settled (turns=${state.turns})`);
		if (ctx.hasUI) {
			// 交互模式：后台跑，不阻塞界面
			maybeRename(ctx, false);
			return;
		}
		// 无界面模式（-p / json）：没有界面可阻塞，必须等它跑完，否则进程退出前就丢了
		const cfg = readConfig();
		if (!cfg.enabled || state.disabled || !shouldRename(false)) return;
		await runRename(ctx, false);
	});

	pi.on("session_shutdown", async () => {
		clearTimer();
		state.inFlight = false;
	});

	// ── 手动控制

	pi.registerCommand("autoname", {
		description: "自动会话命名：[status|now|on|off|config|rules]",
		handler: async (args, ctx) => {
			const cfg = readConfig();
			const sub = args.trim().toLowerCase();

			if (sub === "off") {
				state.disabled = true;
				ctx.ui.notify("自动命名已关闭（本会话）", "info");
				return;
			}
			if (sub === "on") {
				state.disabled = false;
				ctx.ui.notify("自动命名已开启（本会话）", "info");
				return;
			}
			if (sub === "now") {
				await runRename(ctx, true);
				ctx.ui.notify(`标题：${pi.getSessionName() ?? "(未命名)"}｜${state.status}`, "info");
				return;
			}
			if (sub === "config") {
				ctx.ui.notify(`配置：${CONFIG_PATH}`, "info");
				return;
			}
			if (sub === "rules") {
				const p = path.isAbsolute(cfg.rulesFile) ? cfg.rulesFile : path.join(DATA_DIR, cfg.rulesFile);
				ctx.ui.notify(`命名规则：${p}`, "info");
				return;
			}

			const stateText = state.disabled ? "已关闭" : "运行中";
			const idleMin = Math.round(cfg.idleRenameAfterMs / 60000);
			ctx.ui.notify(
				[
					`标题：${pi.getSessionName() ?? "(未命名)"}｜${state.status || "(无状态)"}`,
					`状态：${stateText}｜已聊 ${state.turns} 轮${state.project ? `｜聊的不是当前工作区：${state.project}` : ""}`,
					`节奏：空闲 >${idleMin} 分钟　或　每 ${cfg.updateEveryTurns} 轮`,
					`历史标题：${state.prevTitles.length ? state.prevTitles.join(" → ") : "(无)"}`,
					`模型：${resolveModel(ctx)?.id ?? "(无)"}｜上限 ${cfg.maxChars} 字符`,
					`规则：${cfg.rulesFile}｜配置：${CONFIG_PATH}`,
				].join("\n"),
				"info",
			);
		},
	});
}
