# pi-session-autoname

**让 pi 的会话标题自己长出来** —— 首轮对话后自动起名，之后随话题迁移持续修订，只喂对话结论、不喂工具链。

会话名不是可有可无的装饰：pi 会把它同步到**终端窗口标题**（`π - <会话名> - <目录>`）、`/resume` 选择器、footer。终端开多了以后，一眼能不能认出「这个标签页在干什么」，全靠它。

```
π - zeth 支付修复 - zeth-ai
π - ymesh 标题插件 - zeth-ai      ← 在别的项目目录里聊 ymesh，也认得出
π - zeth 待验收 - zeth-ai         ← 状态跟着进展走
```

## 安装

```bash
# 从 git 安装（推荐固定 tag 或 commit）
pi install git:github.com/zoran-xc/pi-session-autoname@v0.1.0

# 本地开发
pi install /path/to/pi-session-autoname

# 只试一次，不写设置
pi -e /path/to/pi-session-autoname/extensions/session-autoname.ts
```

安装后重启 pi 生效。运行期数据落在 `~/.pi/agent/session-autoname/`（**不在包目录里**，所以 `pi update` 不会冲掉你的配置）：

| 文件 | 作用 |
| --- | --- |
| `config.json` | 配置，改完即时生效，不用重启 |
| `naming-rules.md` | **你的命名习惯**，直接写给模型看 |
| `autoname.log` | 改名记录与报错，>256KB 自动截断 |

## 配置命名习惯才是重点

扩展只负责「什么时候问模型、把什么喂给它、怎么校验结果」，**叫什么名字由 `naming-rules.md` 决定**。默认内容要你按自己的习惯改，例如：

```markdown
- 语言与我一致
- 标题 ≤ 10 个字符，砍信息但不砍「项目 + 当前动作」
- 信息优先级：项目名 > 当前动作 > 状态 > 上下文
- 如果对话聊的项目 ≠ 我当前所处的工作区，标题必须写「聊的那个项目」
- 话题迁移时标题要跟着迁移，别停在最开始那件事上
- 任务没变就别改标题，不要无意义抖动
```

## 配置项（`config.json`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `model` | `""` | 起名用哪个模型；空 = 与当前会话同模型。建议填便宜的小模型 |
| `maxChars` | `10` | 标题字符上限（中文/英文/数字都算 1） |
| `rulesFile` | `naming-rules.md` | 命名习惯文件 |
| `extraInstructions` | `""` | 追加到系统提示 |
| `updateEveryTurns` | `1` | 每 N 轮重新评估一次标题 |
| `minMsBetweenUpdates` | `30000` | 两次改名请求的最小间隔，防连发消息反复改名 |
| `includeAssistant` | `true` | 是否把助手回复也喂给模型 |
| `perMessageChars` / `maxDigestChars` / `maxMessages` | `1200` / `6000` / `30` | 摘要体积控制 |
| `titleTemplate` | `""` | 覆盖终端标题，支持 `{name}` `{status}` `{project}` `{turns}` |
| `includeGitBranch` | `true` | 把当前 git 分支放进上下文 |
| `skipWhenNoUI` | `true` | 非交互模式（`pi -p`）不自动命名，避免额外花销 |
| `debug` | `false` | 界面提示 + 全量追踪日志 |

## 手动控制

```
/autoname            # 看当前标题与状态
/autoname now        # 立刻重新评估一次
/autoname on|off     # 本会话开关
/autoname config     # 打印配置路径
/autoname rules      # 打印命名规则路径
```

## 它怎么工作

1. `session_start` 读会话记录，判断这个会话是不是自己管的（有 `session-autoname` 标记）、或者名字是不是你手动起的。
2. 每轮 `agent_settled` 后（按 `updateEveryTurns` / `minMsBetweenUpdates` 节流），把**对话结论**喂给模型：只取 user 与 assistant 的文本块，跳过 `toolCall` 参数、工具输出、thinking。
3. 模型返回 `{"title","status","changed"}`；`changed=false` 就什么都不动。
4. 超长先让模型自己压缩一次，还超就硬截断。
5. 写 `pi.setSessionName()` → pi 自动刷新终端标题。你手动 `/name` 过，自动命名就永久让位（清空名字可收回）。

## 已知限制

- **别在扩展里用 `pi.exec`**：实测 `pi -p` 模式下调用它会让进程无法退出（已改为直接读 `.git/HEAD`，零子进程）。这是我踩过的坑，写在这里免得再踩。
- 起名那次调用**不计入 pi 的会话成本统计**，它是独立请求。用便宜模型 + 摘要截断控制开销。
- `pi -p` 想自动命名需把 `skipWhenNoUI` 设为 `false`。
- 模型偶尔会吐占位词（`未命名` / `none`），扩展会直接丢掉而不是写进去。

## 验证

```bash
npm test        # 离线测试，假的 pi/ctx/model，不花 API 调用
```

覆盖：首轮起名、话题迁移改名、不抖动、超长收敛、手动改名让位、强制刷新、摘要过滤工具链、失败容错、恢复旧会话、开关、git 分支上下文。

## License

MIT
