# @firefly0621/dsh-always-apply

[English](README.md) | 中文

可选 Cordis 消费方：把 frontmatter 标了 `alwaysApply: true`（与 Cursor 对齐）的 skill 正文，贡献到每次模型请求的 system prompt，无需再调 `skill` 工具。

本包**不**注册 skill 提供方。需与 `dsh-skill` / `dsh-skill-filesystem`（通常还有 `dsh-tool-skill`）一起挂载。默认不进 `dsh-base`；安装方式：

```sh
dsh plugin --profile web add @firefly0621/dsh-always-apply
```

也可把自带的 `cordis.patch.yml` 插入自定义 base。

本包也可直接运行在较早的上游 `@deepseek-ai/dsh-skill` 版本上。当目录摘要不携带类型化 `alwaysApply` 字段时，本消费方会加载候选 skill，并从定义或 skill 文件 frontmatter 读取 `alwaysApply`，因此无需修改宿主源码。

## Skill frontmatter

由 `@deepseek-ai/dsh-skill-filesystem` 解析的本地 `SKILL.md`（或扁平 `.md`）：

```yaml
---
name: my-standing-rules
description: Standing session rules
alwaysApply: true
---

Follow these rules for the whole session.
```

`alwaysApply` 的布尔拼写与 `disable-model-invocation` / `user-invocable` 相同。非法值会被视为未启用，因此本消费方跳过注入，但该 skill 仍保留在发现目录中。

路由文案（`description` / `whenToUse`）仍由注册该 skill 的提供方负责；本消费方只负责选取并注入正文。挂载会发布清晰路由文案的 skill 提供方，才能让发现与模型目录保持可用。

交付的 `@firefly0621/dsh-skill-karpathy-guidelines` 提供方将 `karpathy-guidelines` 标为 `alwaysApply: true`。与该提供方一起挂载本消费方，即可在不调用 `skill` 工具的情况下注入 Karpathy 正文。

## 行为

在每次 `system-prompt/assemble`（每个模型 step 前的组装）时：

1. 跳过无 agent 的组装，以及 `session.header.origin === 'subagent'` 的会话（默认；可用 `skipSubagent: false` 覆盖）。
2. 对当前 agent 做 `snapshot()`。不完整观察会复用该 agent 上一次完整 always-apply 文本（若尚无则不注入），且不写入 warm 缓存，以便下次组装重试。
3. 选取 `Config.names` 中的名称，以及 summary、加载后定义或 skill 文件 frontmatter 中带 `alwaysApply: true` 的 skill，并排除 `disabledNames`。候选加载并发进行；字节预算仍按名称顺序跳过。
4. 遵守 section 的 `maxTotalBytes`，贡献一个 `skill:always-apply` system-prompt section（名称列表 + 各 `renderSkillContent` 块）。

渲染按 agent 记忆化，由 `skills/change` 失效：目录变化后的下一次组装即刷新成员与正文；两次变化之间 prompt 前缀逐字节稳定，利于 KV 缓存复用。

### Config

| 字段 | 默认 | 含义 |
|---|---|---|
| `names` | `[]` | 即使无 frontmatter `alwaysApply` 也强制注入的 skill 名。 |
| `disabledNames` | `[]` | 即使已标记也永不注入的名称。 |
| `skipSubagent` | `true` | 跳过 subagent 来源会话。 |
| `maxTotalBytes` | `100000` | 完整 always-apply section 文本的 UTF-8 长度（提醒信封 + 全部已渲染正文）。会把完整文本推出预算的 skill 会被跳过并告警。 |

always-apply 注入是宿主常驻指令路径：frontmatter `alwaysApply: true` 与 `Config.names` **不**要求 `modelInvocable`。带 `disable-model-invocation: true` 的 skill 仍可在此注入，同时不出现在面向模型的 `skill` 目录中。

## Model Experience

### Always-apply 常驻指令

#### What the model sees

在至少有一个选中 skill 落入完整 section 预算时，system prompt 最前有一条 `skill:always-apply` section：短 `<system-reminder>` 列出 always-apply 集合，随后各 skill 的规范 `<skill_content>` 块。因为它是 system prompt 的一部分，每个 step 都会收到，compaction 永远不会遮蔽它；目录变化在下一次完整组装时生效（不完整的重新发现会保留此前的完整文本直至那时）。

#### Token effect

一个 section，大小为提醒信封加上所有落在 `maxTotalBytes` 内的已渲染 skill 正文，随每次请求的 system prompt 重发。

#### KV Cache effect

section 文本位于请求前缀。always-apply 集合不变时渲染文本逐字节稳定，warm 前缀缓存可复用；`skills/change` 触发的刷新会重拼 section，从该 token 起使复用失效。

## Known Limitations and Deferred Work

- **仅 opt-in** — 产品默认不挂载；由运营方显式安装。
- **正文须避免 `{{...}}` 提示变量语法** — section 会被 prompt 渲染器插值；含完整 `{{...}}` 组的正文会被跳过并告警（未闭合的 `{{` 按字面散文保留）。
- **`complete` persona 会替换所有 section** — 组合中注册了 `complete` persona（agent preset）的 agent，其所有 prompt section（含本 section）都会被抑制。
- **目录仍列出模型可调用的 always-apply skill** — 这些条目仍出现在 `skill` 目录；提醒文案要求正文已在 system prompt 中时勿再加载。
- **绕过模型调用策略** — always-apply 与 `Config.names` 不论 `modelInvocable` 都会注入；用 `disabledNames` 排除。
