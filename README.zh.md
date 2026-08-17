# @firefly0621/dsh-skill-always-apply

[English](README.md) | 中文

可选 Cordis 消费方：把 frontmatter 标了 `alwaysApply: true`（与 Cursor 对齐）的 skill 正文，在首次模型请求前注入会话，无需再调 `skill` 工具。

本包**不**注册 skill 提供方。需与 `dsh-skill` / `dsh-skill-filesystem`（通常还有 `dsh-tool-skill`）一起挂载。默认不进 `dsh-base`；安装方式：

```sh
dsh plugin --profile web add @firefly0621/dsh-skill-always-apply
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

在首次适用的 `agent/pre-step`（在 skill 目录等内层监听之后）：

1. 默认跳过 `session.header.origin === 'subagent'`（可用 `skipSubagent: false` 覆盖）。
2. 若当前步骤已有 `skill-always-apply` 消息，或模型可见面上仍保留一条，则跳过。
3. 对当前 agent 做 `snapshot()`；不完整观察则跳过。
4. 选取 `Config.names` 中的名称，以及 summary、加载后定义或 skill 文件 frontmatter 中带 `alwaysApply: true` 的 skill，并排除 `disabledNames`。
5. 经 `ctx.skills.get()` 加载正文，遵守完整消息的 `maxTotalBytes`，前置一条 durable 的用户角色 instructions 消息（名称列表 + 各 `renderSkillContent` 块）。

resume 时若消息仍在可见面则不重复注入；被 surface 遮蔽后会补注。

### Config

| 字段 | 默认 | 含义 |
|---|---|---|
| `names` | `[]` | 即使无 frontmatter `alwaysApply` 也强制注入的 skill 名。 |
| `disabledNames` | `[]` | 即使已标记也永不注入的名称。 |
| `skipSubagent` | `true` | 跳过 subagent 来源会话。 |
| `maxTotalBytes` | `100000` | 完整 always-apply 用户消息的 UTF-8 长度（提醒信封 + 全部已渲染正文）。会把完整消息推出预算的 skill 会被跳过并告警。 |

always-apply 注入是宿主常驻指令路径：frontmatter `alwaysApply: true` 与 `Config.names` **不**要求 `modelInvocable`。带 `disable-model-invocation: true` 的 skill 仍可在此注入，同时不出现在面向模型的 `skill` 目录中。

## Model Experience

### Always-apply 常驻指令

#### What the model sees

在至少有一个选中 skill 落入完整消息预算时，首次模型请求前有一条 durable 用户角色 instructions 消息：短 `<system-reminder>` 列出 always-apply 集合，随后各 skill 的规范 `<skill_content>` 块。消息仍在模型可见面时，后续步骤复用同一会话历史。若 compaction（或其他 surface 替换）遮蔽该消息，下一次 pre-step 会补注。

#### Token effect

一条保留的 instructions 消息，大小为提醒信封加上所有落在 `maxTotalBytes` 内的已渲染 skill 正文。

#### KV Cache effect

注入保持可见时只追加一次。被 surface 遮蔽后的补注会追加新的 durable 副本。

## Known Limitations and Deferred Work

- **仅 opt-in** — 产品默认不挂载；由运营方显式安装。
- **可见期间不刷新成员** — 可见注入之后，新出现的 always-apply skill 要到新会话，或在 surface 遮蔽后的补注中按当前目录重建。
- **目录仍列出模型可调用的 always-apply skill** — 这些条目仍出现在 `skill` 目录；提醒文案要求正文已在会话中时勿再加载。
- **绕过模型调用策略** — always-apply 与 `Config.names` 不论 `modelInvocable` 都会注入；用 `disabledNames` 排除。
