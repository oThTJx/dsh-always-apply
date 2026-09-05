# @firefly0621/dsh-always-apply

English | [中文](README.zh.md)

Opt-in Cordis consumer that loads **Cursor-aligned project rules** from `.dsh/rules/**/*.mdc` and injects them into the system prompt. Cordis plugin name: `rules`. Prompt section: `rules:project`.

This package does **not** read skills or depend on `ctx.skills`. Mount it when you want project rules; install with:

```sh
dsh plugin --profile web add @firefly0621/dsh-always-apply
```

Or insert the shipped `cordis.patch.yml` into a custom base. The browser Settings「规则」panel (`@firefly0621/dsh-client-ui-settings-rules`) is a dependency of this package, so one install brings the host plugin and the settings page together.

## Rule files

Place `.mdc` files under `<session cwd>/.dsh/rules/` (override with Config `rulesDir`). Each file needs YAML frontmatter:

| `alwaysApply` | `globs` | Type |
|---|---|---|
| `true` | * | Always Apply — full body every assemble |
| `false` | non-empty | Specific Files — body when an in-context path matches |
| `false` | empty | Inactive — stored on disk but not auto-attached |

Only `alwaysApply: true` classifies as Always Apply. `alwaysApply: false` without `globs` is never treated as always.

```yaml
---
alwaysApply: true
description: Repo-wide constraints
---

Keep rules short and actionable.
```

Bodies must not contain complete `{{...}}` prompt-variable groups (skipped with a warning).

## Behavior

On every `system-prompt/assemble`:

1. Skip agentless assemblies and `subagent` sessions by default (`skipSubagent`).
2. Load `.mdc` rules from the resolved rules root (cached; invalidated on Settings write/delete and on external edits when `watchRules` is enabled).
3. Auto-attach Always bodies and Specific bodies whose globs match v1 in-context paths (tool `read`/`write`/`edit` `file_path` values ∪ path tokens in user message text).
4. Honor `maxTotalBytes` for the complete auto-attached section text (drop Specific before Always when over budget).

Also registers:

- **`projectRules` Typert remote** — `list` / `read` / `write` / `delete` for Settings and host callers.

### Config

| Field | Default | Meaning |
|---|---|---|
| `rulesDir` | `.dsh/rules` | Relative directory under the session workspace root; absolute paths and `..` are rejected. |
| `skipSubagent` | `true` | Skip subagent-origin sessions. |
| `maxTotalBytes` | `100000` | UTF-8 length of the complete auto-attached section text (reminder + bodies + framing as rendered). |
| `watchRules` | `true` | Watch each accessed rules root and invalidate the cache on external `.mdc` edits (debounced). |
| `watchDebounceMs` | `100` | Watcher debounce window in milliseconds before cache invalidation. |
| `defaultWorkspaceRoot` | *(empty)* | Absolute workspace root used when no session workspace is available. Enables the Settings UI to manage rules without an active session. Must be an absolute path. |

## Model Experience

### Project rules section

#### What the model sees

When non-empty: a `rules:project` system-prompt section with a short reminder and `<auto_attached_rules>` / `<rule_content>` blocks for all auto-attached rules (Always and matching Specific).

#### Token effect

One section re-sent each request while rules and in-context matches stay within budget.

#### KV Cache effect

Prefix reuse holds while the rendered section text is unchanged; a rules-file write, delete, or Specific match set change recomposes the section.

## Known Limitations and Deferred Work

- **Opt-in only** — product defaults do not mount this plugin.
- **No `.cursor/rules` import** — storage is `.dsh/rules` only.
- **In-context paths are incomplete vs Cursor IDE** — no open-editor inventory on the web host; Specific matching uses tool-touched paths and user-text path tokens only.
- **A complete persona replaces every section** — presets with a `complete` persona suppress this section for that agent.
- **Typert client artifacts** — the gateway registers at runtime; web Settings must compose a client that can call `projectRules` once the remote is on the host API surface.
