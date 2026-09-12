# How pi-tab-title compares

At least ten [pi](https://pi.dev) packages name sessions or set terminal titles. This page is an
attempt at a fair map of the ones that overlap, based on reading their own READMEs (last checked
2026-09-12). If something here is out of date, open an issue — corrections welcome, including ones
that make this package look worse.

## The short version

Every package in this space has to answer three questions:

1. **When does it look at the session?** First prompt only, on a turn counter, on a timer, or on demand.
2. **How much can you bend it?** Nothing, a few settings, or a prompt you write yourself.
3. **Where does the name show up?** Just the `/resume` list, or also the terminal tab/tmux pane.

pi-tab-title answers them as: *first message, then after idle gaps and every N turns*;
*a markdown prompt*; *session name plus a templated terminal title*.

## The packages

| Package | When it renames | Configurable | Terminal title | Extras |
| --- | --- | --- | --- | --- |
| [`pi-session-name`](https://www.npmjs.com/package/pi-session-name) | First prompt only, then frozen (never overwrites an existing name) | — | ✅ with busy/idle prefix | Retries 3× from the first input, then gives up silently |
| [`@nicknisi/pi-session-name`](https://www.npmjs.com/package/@nicknisi/pi-session-name) | First `agent_settled` | Heuristic or one-off LLM | ✅ | `/sn` naming commands, `/sessions` search by name |
| [`@d3ara1n/pi-session-namer`](https://www.npmjs.com/package/@d3ara1n/pi-session-namer) | First prompt (side agent, +0.5–1 s) | Zero-config by design | — | `rename_session` tool so the main agent can name the session itself |
| [`pi-session-namer`](https://www.npmjs.com/package/pi-session-namer) | First turn + every 4 turns | Format template, type list, language | — | Optional ≤16-char "progress" segment; lock/unlock commands |
| [`pi-autoname`](https://www.npmjs.com/package/pi-autoname) | First turn + 10-minute cooldown | Model, cooldown, respect-manual-name | — | Renames only when the current name stops fitting |
| [`pi-tab-title` (roldan)](https://www.npmjs.com/package/pi-tab-title) | Not detailed in its README | Not detailed | ✅ | Herdr tab renaming. **Same npm name as this project's repo — different author, unrelated code** |
| [`@oipsanthony/pi-session-title`](https://www.npmjs.com/package/@oipsanthony/pi-session-title) | First turn + every 4 user turns | Model, period, `{title} {cwd}` template | ✅ templated | Syncs a Herdr pane; only runs in the TUI |
| [`@eddiewang/pi-session-title`](https://www.npmjs.com/package/@eddiewang/pi-session-title) | After completed conversations | — | ✅ | Generated tmux window names |
| [`@pi-archimedes/session-name`](https://www.npmjs.com/package/@pi-archimedes/session-name) | After the first exchange | — | — | — |
| [`@pi-claudian/sync-title`](https://www.npmjs.com/package/@pi-claudian/sync-title) | On sync | — | — | Keeps Claudian conversation titles and pi session names in sync |
| **pi-tab-title (this repo)** | **First message**, then after >10 min idle, or every 5 turns | **Naming policy = a markdown prompt** | ✅ `{name} {project} {prev}` | Previous titles kept in parens; `@project` when you're on a different repo; interrupted turns marked "needs review" |

## What is *not* unique to this package

Worth stating plainly, because it is easy to oversell:

- **Periodic re-evaluation** is not unique: `pi-session-namer`, `pi-autoname` and
  `@oipsanthony/pi-session-title` all re-check on a schedule.
- **Terminal titles** are not unique: five packages in the table above set them.
- **Language matching** is not unique — several derive it from the conversation.
- **A separate/cheap model** for naming is not unique: `@d3ara1n`, `@camillof` and `@oipsanthony`
  all offer it, and this package lets you point `model` at any model too.

## What this package does that the others (as of 2026-09-12) don't

- **Naming policy as a prompt.** The others expose settings — a format template, a type enum, a
  language field. That covers a fixed set of preferences. Here the whole policy is
  `naming-rules.md`, so "if the conversation moves to another repo, fill the project field" or
  "don't rename when the task didn't change" are things you can just write.
- **Previous titles kept in the tab.** Renaming does not erase the trail: `π - zeth API timeout (zeth payments)`.
- **`@project` only when the discussed project ≠ your cwd.** With several tabs open, you can tell
  which one is off in another repo without the project name being repeated everywhere.
- **Idle-gap triggering.** Re-evaluation is driven by *how long you were away* (previous turn's end
  → this turn's start), not by a wall-clock cooldown.
- **A hard character cap** (10 by default) with a self-compression retry before the hard cut.

## What this package does *not* have

- No tmux pane / Herdr integration. If you live in tmux panes, look at
  `@oipsanthony/pi-session-title` or `@eddiewang/pi-session-title`.
- No GUI, no `pi config` integration — you edit JSON and markdown.
- Not zero-config: out of the box you are expected to write a naming policy. If you want a name and
  nothing else, `@d3ara1n/pi-session-namer` is a better fit.
- No search/resume-by-name command: `@nicknisi/pi-session-name` has that.

## Picking one

| If you want… | Use |
| --- | --- |
| A name and zero decisions | `@d3ara1n/pi-session-namer` |
| The name to freeze after the first prompt, no churn | `pi-session-name` |
| Search and resume sessions by name | `@nicknisi/pi-session-name` |
| tmux window names / Herdr panes | `@eddiewang/pi-session-title`, `@oipsanthony/pi-session-title` |
| To control *how* names are written, in prose | this repo |
| To see what a session used to be about, in the tab | this repo |
