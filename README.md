# @firefly0621/dsh-skill-always-apply

English | [中文](README.zh.md)

Opt-in Cordis consumer that contributes skill bodies marked `alwaysApply: true` (Cursor-aligned frontmatter) to the system prompt of every model request, without requiring a `skill` tool load.

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

On every `system-prompt/assemble` (the assembly that runs before each model step):

1. Skip agentless assemblies and sessions whose `session.header.origin === 'subagent'` (default; `skipSubagent: false` overrides).
2. `snapshot()` the viewing agent's skills; skip incomplete observations.
3. Select `Config.names` plus skills whose summary, loaded definition, or skill-file frontmatter carries `alwaysApply: true`, minus `disabledNames`.
4. Load each body via `ctx.skills.get()`, honor section `maxTotalBytes`, and contribute one `skill:always-apply` system-prompt section that lists names and embeds each `renderSkillContent` block.

Rendering is memoized per agent and invalidated by `skills/change`, so membership and bodies refresh on the next assembly after a catalog change, and the prompt prefix stays byte-stable between changes for KV reuse.

### Config

| Field | Default | Meaning |
|---|---|---|
| `names` | `[]` | Force-inject these skill names even without frontmatter `alwaysApply`. |
| `disabledNames` | `[]` | Never inject these names, even when marked. |
| `skipSubagent` | `true` | Skip subagent-origin sessions. |
| `maxTotalBytes` | `100000` | UTF-8 length of the **complete** always-apply section text (reminder envelope + every rendered body). Skills that would push the complete text over the budget are skipped with a warning. |

Always-apply injection is a host standing-instructions path: frontmatter `alwaysApply: true` and `Config.names` do **not** require `modelInvocable`. A skill with `disable-model-invocation: true` can still be injected here while staying out of the model-facing `skill` catalog.

## Model Experience

### Always-apply standing instructions

#### What the model sees

A `skill:always-apply` section at the front of the system prompt when at least one selected skill fits the complete-section budget: a short `<system-reminder>` naming the always-apply set, then each skill's canonical `<skill_content>` block. Because the section is part of the system prompt, every step receives it, compaction never shadows it, and a catalog change lands on the next assembly.

#### Token effect

One section whose size is the reminder envelope plus every rendered skill body that fit under `maxTotalBytes`, re-sent in every request's system prompt.

#### KV Cache effect

The section text sits in the request prefix. While the always-apply set is unchanged the rendered text is byte-stable, so the warm prefix cache is reused; a `skills/change` refresh recomposes the section, invalidating reuse from that token forward.

## Known Limitations and Deferred Work

- **Opt-in only** — product defaults do not mount this plugin; operators add it explicitly.
- **Bodies must avoid `{{...}}` prompt-variable syntax** — the section is interpolated by the prompt renderer; a body containing a complete `{{...}}` group is skipped with a warning (an unclosed `{{` is kept as literal prose).
- **A complete persona replaces every section** — an agent whose composition registers a `complete` persona (agent presets) suppresses all prompt sections, including this one, for that agent.
- **Catalog still lists model-invocable always-apply skills** — those entries remain in the `skill` catalog; the reminder tells the model not to re-load them when the body is already present.
- **Bypasses model invocation policy** — always-apply and `Config.names` inject regardless of `modelInvocable`; use `disabledNames` to exclude.
