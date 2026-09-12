# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，版本号用 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.2.2] - 2026-09-12

### Fixed

- **首次起名不再等 agent 自跑完**：原来挂在 `agent_settled`，而它只在 agent 真正停下来时才触发 ——
  用户实测首个长任务是自跑了 33 轮（约 10 分钟）才 settle，标题就一直不出现。
  现在改成用户发出**第一条消息**（`before_agent_start`）就起名，比助手回答还早。
- 全新会话的第一次 `turn_start` 因 `lastTurnEndedAt = 0` 被误判成「空闲回来」，会在首轮连发两次命名请求。
- 首轮命名失败后，后续轮的重试在「会话里没有可摘要内容」时静默放弃；现在用最近一条 prompt 兜底。

## [0.2.1] - 2026-09-12

### Changed

- 默认 `titleTemplate` 去掉 `{status}`：状态标签（尤其「待审核」）在标签栏里太吵。
  状态本身仍在维护（日志、`/autoname`、中断强制「待审核」），想显示把 `{status}` 加回模板即可。

### Docs

- VS Code 集成终端建议只设 `terminal.integrated.tabs.title` = `${sequence}`；接 `${process}` 会在标题前多出一段 `node - `。

## [0.2.0] - 2026-09-12

### Changed

- **改名节奏**改为：没有标题则首轮就起名；上一轮结束后隔 `idleRenameAfterMs`（默认 10 分钟）以上才回来则重新评估；连续对话每 `updateEveryTurns`（默认 5）轮一次。不再每轮都请求模型。
- **取消「手动命名即让位」**：插件开着就一直维护标题，手动 `/name` 起的名字会记入历史、显示在括号里。
- 被中断或出错的一轮（`stopReason` 为 `aborted` / `error`）状态在代码里强制为「待审核」。

### Added

- 模型输出新增 `project` 字段：仅当「对话讨论的项目 ≠ 当前工作区」时非空。
- 终端标题模板支持 `{name}` `{status}` `{project}` `{prev}` `{turns}`，默认
  `π - {name}{project} {prev}`；空占位符会自动收拾多余分隔符与空括号。
- 配置项 `idleRenameAfterMs`、`prevTitleCount`。

### Fixed

- `idleResume` / `interrupted` 标志在构建提示词之前就被清掉，导致「上一轮被中断」的提示从未进入提示词。

## [0.1.0] - 2026-09-12

### Added

- 首轮自动起名，之后每轮重新评估标题。
- 只把对话结论（user / assistant 文本块）喂给命名模型，跳过工具参数、工具输出与 thinking。
- 命名习惯外置为 `naming-rules.md`；配置按 mtime 热读，改完即时生效。
- 尊重手动命名（后续版本已改为「不让位、记入历史」）。
- 离线测试与实机端到端验证。
