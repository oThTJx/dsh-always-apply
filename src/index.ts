/**
 * Always-apply skill injection: standing instructions contributed to the system
 * prompt for skills marked `alwaysApply: true` (or listed in Config.names).
 *
 * Unlike a durable user message, the rendered rules live in a
 * `system-prompt/assemble` section: the catalog is re-evaluated on every
 * assembly (memoized per agent and invalidated by `skills/change`), so
 * membership and bodies refresh without accumulating conversation history and
 * compaction never shadows them. An incomplete skills snapshot reuses the last
 * complete render for that agent instead of clearing standing instructions.
 * Skill bodies must stay free of `{{...}}` prompt-variable syntax — the
 * section is interpolated by the prompt renderer, so such skills are skipped
 * with a warning.
 *
 * @module @firefly0621/dsh-always-apply
 */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  escapeText,
  renderSkillContent,
  type SkillDefinition,
  type SkillSummary,
} from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'always-apply'

/** Skills registry for discovery and loading. */
export const inject = ['skills']

const DEFAULT_MAX_TOTAL_BYTES = 100_000

/** Prompt section name for the always-apply standing instructions. */
const SECTION_NAME = 'skill:always-apply'

/** Always-apply consumer configuration. Invalid values fail plugin load. */
export interface Config {
  /**
   * Skill names to inject even when frontmatter omits `alwaysApply`.
   * Empty by default. Forced names bypass `modelInvocable` the same way
   * frontmatter `alwaysApply` does: this path is host standing instructions,
   * not the model-facing `skill` catalog.
   */
  names?: string[]
  /** Skill names excluded from always-apply injection even when marked. */
  disabledNames?: string[]
  /**
   * When true (default), skip injection for sessions whose header origin is
   * `subagent`.
   */
  skipSubagent?: boolean
  /**
   * Maximum UTF-8 byte length of the complete always-apply section text
   * (reminder envelope plus every rendered skill body). Skills that would push
   * the complete text over the budget are skipped with a warning.
   * Default 100000.
   */
  maxTotalBytes?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  names: z.array(String).default([]),
  disabledNames: z.array(String).default([]),
  skipSubagent: z.boolean().default(true),
  maxTotalBytes: z.number().default(DEFAULT_MAX_TOTAL_BYTES),
})

/**
 * Render the always-apply standing-instructions text for the given skills:
 * a short reminder naming the set, then each skill's canonical
 * `<skill_content>` block.
 * @param skills - loaded definitions to render, in injection order.
 * @returns the rendered instructions text.
 */
export function renderAlwaysApplyText(skills: readonly SkillDefinition[]): string {
  const names = skills.map(skill => skill.name)
  const nameList = names.map(name => `- ${escapeText(name)}`).join('\n')
  const bodies = skills.map(skill => renderSkillContent(skill)).join('\n\n')
  return [
    '<system-reminder>',
    'The following always-apply skills are in effect for this session. Follow their instructions for the rest of the conversation.',
    'Do not call the `skill` tool again for these names unless their bodies are absent from the system prompt.',
    '',
    '<always_apply_skills>',
    nameList,
    '</always_apply_skills>',
    '</system-reminder>',
    '',
    bodies,
  ].join('\n')
}

/**
 * Whether the text contains a complete `{{...}}` group — the prompt renderer
 * would either substitute it as a variable or fail loud, so a section cannot
 * carry it. Mirrors the renderer's own scan, not a regex over the body.
 * @param text - candidate section text to inspect.
 * @returns true when any `{{` is closed by a later `}}`.
 */
function hasPromptVariableSyntax(text: string): boolean {
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', open + 2)) {
    if (text.indexOf('}}', open + 2) >= 0) return true
  }
  return false
}

/**
 * Read the typed `alwaysApply` field when the host's `dsh-skill` exposes one.
 *
 * Official `dsh-skill` releases before the fork's `alwaysApply` change do not
 * put this field on {@link SkillSummary}; the predicate therefore returns
 * `undefined` for those hosts so callers can fall back to loading and
 * inspecting the full definition. A present but non-`true` value is a real
 * `false`, and callers should skip the skill without loading it.
 * @param summary - catalog summary to inspect.
 * @returns `true` or `false` when the field is present, otherwise `undefined`.
 */
function summaryAlwaysApplyFlag(summary: SkillSummary & { readonly alwaysApply?: unknown }): boolean | undefined {
  if (!('alwaysApply' in summary)) return undefined
  return summary.alwaysApply === true
}

/**
 * Return whether one loaded skill opts into always-apply injection on any
 * supported host. The typed `alwaysApply` field is preferred when present;
 * otherwise a filesystem-backed skill's frontmatter is read from `path`.
 * @param definition - loaded skill definition.
 * @returns true only when the skill opts in.
 */
async function definitionIsAlwaysApply(definition: SkillDefinition & { readonly alwaysApply?: unknown }): Promise<boolean> {
  const flag = definitionAlwaysApplyFlag(definition)
  if (flag !== undefined) return flag
  if (definition.path === undefined) return false
  return readAlwaysApplyFrontmatter(definition.path)
}

/**
 * Read an always-apply boolean from a definition's direct or nested metadata.
 * @param definition - loaded skill definition.
 * @returns true, false, or undefined when no flag is present.
 */
function definitionAlwaysApplyFlag(definition: SkillDefinition & { readonly alwaysApply?: unknown }): boolean | undefined {
  if (definition.alwaysApply !== undefined) return definition.alwaysApply === true
  const metadata = definition.metadata
  if (metadata !== undefined && typeof metadata === 'object') {
    const flag = (metadata as Record<string, unknown>).alwaysApply
    if (flag !== undefined) return flag === true
  }
  return undefined
}

/**
 * Read `alwaysApply` from a skill file's YAML frontmatter.
 * @param path - absolute skill file path.
 * @returns true when the frontmatter field is truthy; false otherwise.
 */
async function readAlwaysApplyFrontmatter(path: string): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    // Missing or unreadable skill file; there is no frontmatter to inspect.
    return false
  }
  const frontmatter = parseFrontmatter(raw)
  if (frontmatter === undefined) return false
  try {
    return frontmatterBoolean(frontmatter, 'alwaysApply') === true
  } catch {
    // Invalid `alwaysApply` value; treat as not opted in.
    return false
  }
}

/**
 * Parse a leading `---` YAML frontmatter block.
 * @param raw - full skill source text.
 * @returns parsed object data, or undefined when absent or invalid.
 */
function parseFrontmatter(raw: string): Record<string, unknown> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)
  const body = match?.[1]
  if (body === undefined) return undefined
  let data: unknown
  try {
    data = parseYaml(body)
  } catch {
    return undefined
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  return data as Record<string, unknown>
}

/**
 * Parse a frontmatter boolean using the same spellings as the filesystem
 * skill provider.
 * @param data - parsed frontmatter object.
 * @param key - field name.
 * @returns the boolean value, or undefined when the field is absent.
 */
function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true
      case 'false':
      case 'no':
      case 'off':
        return false
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}

/** Result of one always-apply composition against the current skills catalog. */
type ComposeResult =
  | { readonly status: 'complete'; readonly text: string }
  | { readonly status: 'incomplete' }

/**
 * Always-apply consumer: contributes a `skill:always-apply` system-prompt
 * section assembled per step. Rendering is memoized per agent and invalidated
 * by `skills/change` (membership or body refresh) and by agent disposal
 * (eviction); a warm cache keeps each assembly a plain section unshift.
 * Incomplete snapshots do not overwrite the warm cache: the last complete
 * render is reused until discovery completes again.
 * @param ctx - Cordis context with `skills`.
 * @param config - optional name overrides, subagent skip, and byte budget.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const forcedNames = new Set(config.names ?? [])
  const disabledNames = new Set(config.disabledNames ?? [])
  const skipSubagent = config.skipSubagent ?? true
  const maxTotalBytes = config.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  assertPositiveInteger('maxTotalBytes', maxTotalBytes)

  // Rendered section text per agent; `system-prompt/assemble` is async and runs
  // for every step, so the cache keeps the recomposition cheap between changes.
  const cached = new Map<Agent, string>()
  // Survives `skills/change` warm-cache clears so an incomplete rediscovery can
  // keep standing instructions until the next complete snapshot lands.
  const lastGood = new Map<Agent, string>()

  const compose = async (agent: Agent, signal: AbortSignal | undefined): Promise<ComposeResult> => {
    const lookup = { cwd: agent.session.header.cwd, signal, scope: agent }
    const snapshot = await ctx.skills.snapshot(lookup)
    if (!snapshot.complete) return { status: 'incomplete' }

    const summaries = [...snapshot.skills]
      .sort((left, right) => compareCodePoints(left.name, right.name))
      .filter((summary) => {
        if (disabledNames.has(summary.name)) return false
        const forced = forcedNames.has(summary.name)
        const summaryFlag = summaryAlwaysApplyFlag(summary)
        return forced || summaryFlag !== false
      })

    // Host summaries often omit `alwaysApply`, so selection may need a full
    // load per candidate; resolve those loads concurrently, then apply budget
    // in name order so skip order stays stable.
    const resolved = await Promise.all(summaries.map(async (summary) => {
      const forced = forcedNames.has(summary.name)
      const summaryFlag = summaryAlwaysApplyFlag(summary)
      const skill = await ctx.skills.get(summary.name, lookup)
      if (skill === undefined) return undefined
      if (!forced && summaryFlag === undefined && !(await definitionIsAlwaysApply(skill))) return undefined
      if (hasPromptVariableSyntax(skill.content)) {
        ctx.logger.warn(
          `always-apply: skipping "${skill.name}" — body contains {{...}} prompt-variable syntax the system prompt cannot carry`,
        )
        return undefined
      }
      return skill
    }))

    const loaded: SkillDefinition[] = []
    for (const skill of resolved) {
      if (skill === undefined) continue
      const candidate = renderAlwaysApplyText([...loaded, skill])
      if (utf8ByteLength(candidate) > maxTotalBytes) {
        ctx.logger.warn(
          `always-apply: skipping "${skill.name}" — complete section would exceed maxTotalBytes (${maxTotalBytes})`,
        )
        continue
      }
      loaded.push(skill)
    }
    return {
      status: 'complete',
      text: loaded.length === 0 ? '' : renderAlwaysApplyText(loaded),
    }
  }

  ctx.on('skills/change', () => { cached.clear() })
  ctx.on('agent/disposed', ({ agent }) => {
    cached.delete(agent)
    lastGood.delete(agent)
  })

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context.agent
    // Agentless diagnostics carry no standing rules; subagent sessions opt out
    // unless configured otherwise. Waterfall listeners must delegate via next().
    if (agent === undefined || (skipSubagent && agent.session.header.origin === 'subagent')) {
      return next()
    }
    let text = cached.get(agent)
    if (text === undefined) {
      const composed = await compose(agent, context.signal)
      if (composed.status === 'incomplete') {
        text = lastGood.get(agent) ?? ''
      } else {
        text = composed.text
        cached.set(agent, text)
        lastGood.set(agent, text)
      }
    }
    if (text === '') return next()
    const result = await next()
    return {
      ...result,
      sections: [{ name: SECTION_NAME, text }, ...result.sections],
    }
  })
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function assertPositiveInteger(name: string, value: number, minimum = 1): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`always-apply: ${name} must be an integer greater than or equal to ${minimum}`)
  }
}
