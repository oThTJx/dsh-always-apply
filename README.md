# @firefly0621/dsh-skill-always-apply

English | [中文](README.zh.md)

Opt-in Cordis consumer that injects skill bodies marked `alwaysApply: true` (Cursor-aligned frontmatter) into a session before the first model request, without requiring a `skill` tool load.

This package does **not** register a skill provider. Mount it beside `dsh-skill` / `dsh-skill-filesystem` (and usually `dsh-tool-skill`). It is not part of the default `dsh-base` composition; install with:

```sh
dsh plugin --profile web add @firefly0621/dsh-skill-always-apply
```

Or insert the shipped `cordis.patch.yml` into a custom base.

The package also runs against upstream `@deepseek-ai/dsh-skill` releases that predate the typed `alwaysApply` field. When a catalog summary does not carry the field, this consumer loads the candidate and reads `alwaysApply` from the definition or the skill file's frontmatter, so no host-code change is required.

## Skill frontmatter

In a local `SKILL.md` (or flat `.md` skill) parsed by `@deepseek-ai/dsh-skill-filesystem`:

```yaml
---
name: my-standing-rules
description: Standing session rules
alwaysApply: true
---

Follow these rules for the whole session.
```

`alwaysApply` uses the same boolean spellings as `disable-model-invocation` / `user-invocable`. An invalid value is treated as not opted in, so this consumer skips injection while the skill stays in the discovery catalog.

Routing copy (`description` / `whenToUse`) stays on the skill provider that registers the skill; this consumer only selects and injects bodies. Mount skill providers that publish clear routing text so discovery and the model catalog stay useful.

The shipped `@firefly0621/dsh-skill-karpathy-guidelines` provider marks `karpathy-guidelines` with `alwaysApply: true`. Mount this consumer next to that provider to inject the Karpathy body without a `skill` tool load.

## Behavior

On the first applicable `agent/pre-step` (after nested listeners such as the skill catalog):

1. Skip when `session.header.origin === 'subagent'` (default; `skipSubagent: false` overrides).
2. Skip when the current step already carries a `skill-always-apply` message, or when one remains on the model-visible surface.
3. `snapshot()` the viewing agent's skills; skip incomplete observations.
4. Select `Config.names` plus skills whose summary, loaded definition, or skill-file frontmatter carries `alwaysApply: true`, minus `disabledNames`.
5. Load each body via `ctx.skills.get()`, honor complete-message `maxTotalBytes`, and prepend one durable user-role instructions message that lists names and embeds each `renderSkillContent` block.

Resume sessions still showing the message on the surface are not re-injected; surface-shadowed messages are.

### Config

| Field | Default | Meaning |
|---|---|---|
| `names` | `[]` | Force-inject these skill names even without frontmatter `alwaysApply`. |
| `disabledNames` | `[]` | Never inject these names, even when marked. |
| `skipSubagent` | `true` | Skip subagent-origin sessions. |
| `maxTotalBytes` | `100000` | UTF-8 length of the **complete** always-apply user message (reminder envelope + every rendered body). Skills that would push the complete message over the budget are skipped with a warning. |

Always-apply injection is a host standing-instructions path: frontmatter `alwaysApply: true` and `Config.names` do **not** require `modelInvocable`. A skill with `disable-model-invocation: true` can still be injected here while staying out of the model-facing `skill` catalog.

## Model Experience

### Always-apply standing instructions

#### What the model sees

One durable user-role instructions message before the first model request when at least one selected skill fits the complete-message budget: a short `<system-reminder>` naming the always-apply set, then each skill's canonical `<skill_content>` block. Later steps reuse the same session history while the message remains on the model-visible surface. If compaction (or another surface replace) shadows the message, the next pre-step re-injects.

#### Token effect

One retained instructions message whose size is the reminder envelope plus every rendered skill body that fit under `maxTotalBytes`.

#### KV Cache effect

While the injection stays visible, it is append-once. Surface-shadowed re-injection appends a new durable copy.

## Known Limitations and Deferred Work

- **Opt-in only** — product defaults do not mount this plugin; operators add it explicitly.
- **No membership refresh while visible** — after a visible injection, newly appearing always-apply skills are not appended until a new session or a surface-shadowed re-inject rebuilds the set from the current catalog.
- **Catalog still lists model-invocable always-apply skills** — those entries remain in the `skill` catalog; the reminder tells the model not to re-load them when the body is already present.
- **Bypasses model invocation policy** — always-apply and `Config.names` inject regardless of `modelInvocable`; use `disabledNames` to exclude.
