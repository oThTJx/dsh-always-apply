/**
 * Cursor-aligned project-rule types for `@firefly0621/dsh-always-apply`.
 * @module @firefly0621/dsh-always-apply/types
 */

/**
 * Project-rule apply mode derived from frontmatter.
 * Settings writes only {@link RuleSettingsApplyType}; `inactive` is on-disk only.
 */
export type RuleSettingsApplyType = 'always' | 'specific'

/** Classified apply mode, including on-disk rules that are not auto-attached. */
export type RuleApplyType = RuleSettingsApplyType | 'inactive'

/** Cordis plugin configuration. Invalid values fail plugin load. */
export interface Config {
  /**
   * Relative rules directory under the session workspace root.
   * Default `.dsh/rules`. Absolute paths and `..` escapes are rejected at resolve time.
   */
  rulesDir?: string
  /**
   * When true (default), skip prompt injection for sessions
   * whose header origin is `subagent`.
   */
  skipSubagent?: boolean
  /**
   * Maximum UTF-8 byte length of the complete auto-attached section text as rendered
   * (reminder, `<auto_attached_rules>` framing, and Always + matched Specific bodies).
   * Default 100000.
   */
  maxTotalBytes?: number
  /**
   * When true (default), watch each accessed rules root and invalidate the cache on
   * external `.mdc` edits (debounced). Settings write/delete always invalidate.
   */
  watchRules?: boolean
  /** Watcher debounce window in milliseconds before cache invalidation. Default 100. */
  watchDebounceMs?: number
  /**
   * Absolute workspace root used when no session workspace is available.
   * Enables the Settings UI to manage rules without an active session.
   */
  defaultWorkspaceRoot?: string
}

/** Frontmatter fields used to classify a rule before id/path attachment. */
export interface RuleFrontmatterInput {
  readonly alwaysApply?: boolean
  readonly description?: string
  readonly globs?: readonly string[]
}

/** Parsed `.mdc` document before it is bound to a filesystem id. */
export interface ParsedMdcDocument {
  readonly applyType: RuleApplyType
  readonly description: string
  readonly globs: readonly string[]
  readonly alwaysApply: boolean
  readonly body: string
}

/** One loaded project rule bound to a workspace-relative id. */
export interface ParsedRule extends ParsedMdcDocument {
  /** Id: posix-relative path under the rules root without the `.mdc` extension. */
  readonly id: string
  /** Posix-relative path under the rules root including `.mdc`. */
  readonly relativePath: string
  /** Absolute filesystem path of the rule file. */
  readonly absolutePath: string
}

/** Serializable editor payload used by Settings write-back. */
export interface RuleWriteDocument {
  readonly applyType: RuleSettingsApplyType
  readonly description: string
  readonly globs: readonly string[]
  readonly body: string
}

/** List row returned by `projectRules.list`. */
export interface RuleListItem {
  readonly id: string
  readonly applyType: RuleApplyType
  readonly description: string
  readonly globs: readonly string[]
}

/** Full rule detail returned by `projectRules.read` / `write`. */
export interface RuleDetail extends RuleListItem {
  readonly body: string
}

/** Write payload for `projectRules.write` (create/update/rename). */
export interface RuleWriteInput {
  /** Target id (posix path under rules root without `.mdc`). */
  readonly id: string
  /** When set and different from `id`, rename the file after writing. */
  readonly previousId?: string
  readonly applyType: RuleSettingsApplyType
  readonly description: string
  readonly globs: readonly string[]
  readonly body: string
}
