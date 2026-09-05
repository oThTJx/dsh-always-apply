# @firefly0621/dsh-always-apply

[English](README.md) | 中文

可选挂载的 Cordis 消费方：从 `.dsh/rules/**/*.mdc` 加载 **对齐 Cursor 的项目规则**，并注入系统提示词。Cordis 插件名：`rules`。提示词节名：`rules:project`。

本包**不**读取 skill，也**不**依赖 `ctx.skills`。需要项目规则时挂载；安装：

```sh
dsh plugin --profile web add @firefly0621/dsh-always-apply
```

或将自带的 `cordis.patch.yml` 插入自定义 base。浏览器设置「规则」面板（`@firefly0621/dsh-client-ui-settings-rules`）是本包的依赖，因此一次安装同时带来 host 插件与设置页。

## 规则文件

将 `.mdc` 放在 `<会话 cwd>/.dsh/rules/`（可用 Config `rulesDir` 覆盖）。每个文件需要 YAML frontmatter：

| `alwaysApply` | `globs` | 类型 |
|---|---|---|
| `true` | * | Always Apply — 每轮装配注入全文 |
| `false` | 非空 | Specific Files — 上下文路径命中时注入全文 |
| `false` | 空 | Inactive — 仅存储，不自动注入 |

只有 `alwaysApply: true` 才算 Always Apply；`alwaysApply: false` 且无 `globs` 时绝不会当作 always。

```yaml
---
alwaysApply: true
description: Repo-wide constraints
---

Keep rules short and actionable.
```

正文不得包含完整的 `{{...}}` 提示词变量组（会告警并跳过）。

## 行为

每次 `system-prompt/assemble`：

1. 默认跳过无 agent 装配与 `subagent` 会话（`skipSubagent`）。
2. 从解析后的规则根加载 `.mdc`（有缓存；设置写删会失效；`watchRules` 开启时外部编辑也会失效）。
3. 自动挂载 Always 全文，以及 globs 命中 v1 上下文路径的 Specific 全文（工具 `read`/`write`/`edit` 的 `file_path` ∪ 用户消息中的路径 token）。
4. 对完整自动挂载节文本遵守 `maxTotalBytes`（超预算时先丢 Specific、保留 Always）。

同时注册：

- **`projectRules` Typert remote** — `list` / `read` / `write` / `delete`，供设置页和 host 调用。

### Config

| 字段 | 默认 | 含义 |
|---|---|---|
| `rulesDir` | `.dsh/rules` | 相对会话工作区根的目录；拒绝绝对路径与 `..`。 |
| `skipSubagent` | `true` | 跳过 subagent 来源会话。 |
| `maxTotalBytes` | `100000` | 完整自动挂载节文本的 UTF-8 长度上限。 |
| `watchRules` | `true` | 监视已访问的规则根，外部 `.mdc` 编辑后失效缓存（去抖）。 |
| `watchDebounceMs` | `100` | 缓存失效前的监视去抖窗口（毫秒）。 |
| `defaultWorkspaceRoot` | *(空)* | 无活跃会话时使用的绝对工作区根路径，使设置 UI 可在无会话时管理规则。必须是绝对路径。 |

## 模型体验

### 项目规则节

#### 模型看到什么

非空时：系统提示词中的 `rules:project` 节，含短提醒和所有自动挂载规则（Always、匹配的 Specific）的 `<auto_attached_rules>` / `<rule_content>`。

#### Token 影响

规则与上下文匹配在预算内时，每轮请求重发该节。

#### KV Cache 影响

渲染文本不变时可复用前缀；规则写删或 Specific 匹配集变化会重算该节。

## 已知限制与延后工作

- **仅可选挂载** — 产品默认不挂载本插件。
- **不导入 `.cursor/rules`** — 仅使用 `.dsh/rules`。
- **上下文路径相对 Cursor IDE 不完整** — Web host 无打开编辑器清单；Specific 仅用工具触及路径与用户文本路径 token。
- **完整 persona 会替换全部节** — 带 `complete` persona 的预设会抑制本节。
- **Typert 客户端产物** — 网关在运行时注册；Web 设置需在 host API 暴露 `projectRules` 后由客户端调用。
