# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，版本号用 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
