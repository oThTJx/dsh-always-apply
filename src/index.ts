/**
 * Project rules engine: load `.dsh/rules/*.mdc` and inject Always/Specific bodies
 * into `system-prompt/assemble`.
 *
 * @module @firefly0621/dsh-always-apply
 */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { RuleCache } from './load.ts'
import { RulesRootWatcher } from './watch.ts'
import { collectInContextPaths, ruleMatchesContext } from './paths.ts'
import { renderProjectRulesSection, utf8ByteLength } from './render.ts'
import { DEFAULT_RULES_DIR, resolveRulesRoot } from './resolve-root.ts'
import { ProjectRulesGateway } from './remote.ts'
import type { Config as ConfigShape, ParsedRule } from './types.ts'

export type { ParsedRule, RuleApplyType, RuleSettingsApplyType, RuleWriteDocument, RuleDetail, RuleListItem, RuleWriteInput } from './types.ts'
/** Plugin configuration (value export is the Schemastery validator below). */
export type Config = ConfigShape
export {
  classifyApplyType,
  normalizeGlobs,
  parseMdcDocument,
  serializeMdcDocument,
  hasPromptVariableSyntax,
} from './parse.ts'
export { loadRules, RuleCache } from './load.ts'
export { RulesRootWatcher, type RulesRootWatchOptions } from './watch.ts'
export {
  collectInContextPaths,
  collectInContextPathsFromParts,
  filePathFromToolCall,
  pathTokensFromText,
  ruleMatchesContext,
} from './paths.ts'
export {
  escapeText,
  renderProjectRulesSection,
  renderRuleContent,
  utf8ByteLength,
} from './render.ts'
export { DEFAULT_RULES_DIR, resolveRulesRoot } from './resolve-root.ts'
export {
  ProjectRulesGateway,
  assertRuleId,
  type ProjectRulesGatewayOptions,
} from './remote.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'rules'

/** Services required before this consumer can register tools and assemble. */
export const inject: string[] = []

/** Prompt section name for project rules. */
export const SECTION_NAME = 'rules:project'

const DEFAULT_MAX_TOTAL_BYTES = 100_000
const DEFAULT_WATCH_DEBOUNCE_MS = 100

/** Schemastery validation for {@link ConfigShape}. */
export const Config: z<ConfigShape> = z.object({
  rulesDir: z.string().default(DEFAULT_RULES_DIR),
  skipSubagent: z.boolean().default(true),
  maxTotalBytes: z.number().default(DEFAULT_MAX_TOTAL_BYTES),
  watchRules: z.boolean().default(true),
  watchDebounceMs: z.number().min(0).default(DEFAULT_WATCH_DEBOUNCE_MS),
  defaultWorkspaceRoot: z.string().default(''),
})

/**
 * Select Always + matching Specific bodies under the auto-attach byte budget,
 * preferring Always when the budget is tight.
 * @param rules - all loaded rules.
 * @param contextPaths - in-context paths for Specific matching.
 * @param workspaceRoot - absolute workspace root.
 * @param maxTotalBytes - UTF-8 budget for the complete rendered auto-attached section.
 * @param onWarning - warning sink.
 * @returns auto-attached rules.
 */
export function selectRulesForAssemble(
  rules: readonly ParsedRule[],
  contextPaths: readonly string[],
  workspaceRoot: string,
  maxTotalBytes: number,
  onWarning: (message: string) => void,
): {
  readonly autoAttached: ParsedRule[]
} {
  const always: ParsedRule[] = []
  const specific: ParsedRule[] = []
  for (const rule of rules) {
    switch (rule.applyType) {
      case 'always':
        always.push(rule)
        break
      case 'specific':
        if (ruleMatchesContext(rule.globs, contextPaths, workspaceRoot)) specific.push(rule)
        break
      case 'inactive':
        break
      default: {
        const _exhaustive: never = rule.applyType
        return _exhaustive
      }
    }
  }

  const autoAttached: ParsedRule[] = []
  const tryAdd = (rule: ParsedRule): void => {
    const candidate = renderProjectRulesSection({
      autoAttached: [...autoAttached, rule],
    })
    if (utf8ByteLength(candidate) > maxTotalBytes) {
      onWarning(`rules: skipping "${rule.id}" — auto-attached section would exceed maxTotalBytes (${maxTotalBytes})`)
      return
    }
    autoAttached.push(rule)
  }
  for (const rule of always) tryAdd(rule)
  for (const rule of specific) tryAdd(rule)

  return { autoAttached }
}

/**
 * Project-rules consumer: contributes a `rules:project` system-prompt section.
 * @param ctx - Cordis context with `system-prompt`.
 * @param config - rules directory, subagent skip, and byte budget.
 */
export function apply(ctx: Context, config: ConfigShape = {}): void {
  const rulesDir = config.rulesDir ?? DEFAULT_RULES_DIR
  const skipSubagent = config.skipSubagent ?? true
  const maxTotalBytes = config.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  assertPositiveInteger('maxTotalBytes', maxTotalBytes)
  const watchRules = config.watchRules ?? true
  const watchDebounceMs = config.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS

  const cache = new RuleCache()
  const watcher = watchRules
    ? new RulesRootWatcher({
      debounceMs: watchDebounceMs,
      onInvalidate: (rulesRoot) => { cache.invalidate(rulesRoot) },
      onWarning: (message) => { ctx.logger.warn(message) },
    })
    : undefined
  const defaultWorkspaceRoot = config.defaultWorkspaceRoot?.trim() || undefined
  new ProjectRulesGateway(ctx, { cache, rulesDir, defaultWorkspaceRoot })

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context.agent
    if (agent === undefined || (skipSubagent && agent.session.header.origin === 'subagent')) {
      return next()
    }

    /* v8 ignore next -- agents normally carry an absolute cwd. */
    const workspaceRoot = resolve(agent.session.header.cwd ?? process.cwd())
    let rulesRoot: string
    try {
      rulesRoot = resolveRulesRoot(workspaceRoot, rulesDir)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(message)
      return next()
    }

    watcher?.ensure(rulesRoot)

    const rules = await cache.get(rulesRoot, {
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
      onWarning: (message) => { ctx.logger.warn(message) },
    })
    const text = renderProjectRulesSection(selectRulesForAssemble(
      rules,
      collectInContextPaths(agent),
      workspaceRoot,
      maxTotalBytes,
      (message) => { ctx.logger.warn(message) },
    ))
    if (text === '') return next()
    const result = await next()
    return {
      ...result,
      sections: [{ name: SECTION_NAME, text }, ...result.sections],
    }
  })

  ctx.effect(() => () => {
    watcher?.dispose()
    cache.invalidate()
  }, 'rules: dispose rule cache')
}

function assertPositiveInteger(field: string, value: number, minimum = 1): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`rules: ${field} must be an integer greater than or equal to ${minimum}`)
  }
}
