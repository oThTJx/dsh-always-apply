/**
 * Always-apply skill injection: durable session preamble for skills marked
 * `alwaysApply: true` (or listed in Config.names).
 *
 * @module @firefly0621/dsh-skill-always-apply
 */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import {
  escapeText,
  renderSkillContent,
  type SkillDefinition,
  type SkillSummary,
} from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'skill-always-apply'

/** Skills registry for discovery and loading. */
export const inject = ['skills']

const DEFAULT_MAX_TOTAL_BYTES = 100_000

/**
 * Durable source for an always-apply injection message. Transcript consumers
 * present the injection from this metadata instead of re-parsing the body.
 */
export interface SkillAlwaysApplySource {
  readonly kind: 'skill-always-apply'
  /** Injected skill bodies are instructions for the model to follow. */
  readonly form: 'instructions'
  /** Skill names included in this message, in injection order. */
  readonly names: readonly string[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'skill-always-apply': SkillAlwaysApplySource
  }
}

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
   * Maximum UTF-8 byte length of the complete always-apply user message
   * (reminder envelope plus every rendered skill body). Skills that would push
   * the complete message over the budget are skipped with a warning.
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

/** Published vs model-visible always-apply presence for one session. */
export interface AlwaysApplyPresence {
  /** Whether any readable always-apply message exists in the durable log. */
  readonly published: boolean
  /** Whether a readable always-apply message is on the model-visible surface. */
  readonly visible: boolean
}

/**
 * Register the always-apply pre-step consumer.
 * @param ctx - Cordis context with `skills`.
 * @param config - optional name overrides, subagent skip, and byte budget.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const forcedNames = new Set(config.names ?? [])
  const disabledNames = new Set(config.disabledNames ?? [])
  const skipSubagent = config.skipSubagent ?? true
  const maxTotalBytes = config.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  assertPositiveInteger('maxTotalBytes', maxTotalBytes)

  // Await next() first so catalog / gesture listeners can run, then prepend
  // always-apply bodies as background instructions ahead of those messages.
  ctx.on('agent/pre-step', async (
    { agent, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (skipSubagent && agent.session.header.origin === 'subagent') return decision
    if (shouldSkipAlwaysApplyInjection(agent, decision.messages)) return decision

    signal.throwIfAborted()
    const lookup = { cwd: agent.session.header.cwd, signal, scope: agent }
    const snapshot = await ctx.skills.snapshot(lookup)
    signal.throwIfAborted()
    if (!snapshot.complete) return decision

    const loaded: SkillDefinition[] = []
    let message: UserMessage | undefined
    for (const summary of [...snapshot.skills].sort((left, right) => compareCodePoints(left.name, right.name))) {
      if (disabledNames.has(summary.name)) continue
      const forced = forcedNames.has(summary.name)
      const summaryFlag = summaryAlwaysApplyFlag(summary)
      if (!forced && summaryFlag === false) continue

      const skill = await ctx.skills.get(summary.name, lookup)
      signal.throwIfAborted()
      if (skill === undefined) continue
      if (!forced && summaryFlag === undefined && !(await definitionIsAlwaysApply(skill))) continue

      const candidate = renderAlwaysApplyMessage([...loaded, skill])
      if (utf8ByteLength(userMessageText(candidate)) > maxTotalBytes) {
        ctx.logger.warn(
          `skill-always-apply: skipping "${skill.name}" — complete message would exceed maxTotalBytes (${maxTotalBytes})`,
        )
        continue
      }
      loaded.push(skill)
      message = candidate
    }
    if (message === undefined) return decision

    return { kind: 'enter', messages: [message, ...decision.messages] }
  })
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
  if (metadata !== undefined && metadata !== null && typeof metadata === 'object') {
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
    return false
  }
  const frontmatter = parseFrontmatter(raw)
  if (frontmatter === undefined) return false
  try {
    return frontmatterBoolean(frontmatter, 'alwaysApply') === true
  } catch {
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

/**
 * Whether the pre-step listener should skip building a new always-apply message.
 * Skips when the current step already carries one, or when a prior always-apply
 * message is still on the model-visible surface. A durable but surface-shadowed
 * message (for example after compaction) does not skip — the listener re-injects.
 * @param agent - live agent whose session log and surface are scanned.
 * @param stepMessages - messages already proposed for this step's enter decision.
 * @returns true when injection should be skipped.
 */
export function shouldSkipAlwaysApplyInjection(
  agent: Agent,
  stepMessages: readonly UserMessage[],
): boolean {
  if (alwaysApplyMessage(stepMessages) !== undefined) return true
  return alwaysApplyPresence(agent).visible
}

/**
 * Return whether this session's model-visible surface already carries always-apply.
 * @param agent - live agent whose session surface is scanned.
 * @returns true when a readable always-apply message is currently visible.
 */
export function sessionHasAlwaysApply(agent: Agent): boolean {
  return alwaysApplyPresence(agent).visible
}

/**
 * Scan durable events and the model-visible surface for always-apply messages.
 * @param agent - live agent whose session is scanned.
 * @returns published and visible flags for always-apply presence.
 */
export function alwaysApplyPresence(agent: Agent): AlwaysApplyPresence {
  const visibleNodes = new Set(agent.session.surface.nodes)
  let published = false
  let visible = false
  for (const event of agent.session.events) {
    if (event.type !== 'user/message') continue
    if (readAlwaysApplyNames(event.data.source) === undefined) continue
    published = true
    if (visibleNodes.has(event.seq)) visible = true
  }
  return { published, visible }
}

/**
 * Build the durable always-apply user message for the given loaded skills.
 * @param skills - loaded definitions to render, in injection order.
 * @returns a user-role instructions message with {@link SkillAlwaysApplySource}.
 */
export function renderAlwaysApplyMessage(skills: readonly SkillDefinition[]): UserMessage {
  const names = skills.map(skill => skill.name)
  const source: SkillAlwaysApplySource = {
    kind: 'skill-always-apply',
    form: 'instructions',
    names,
  }
  const nameList = names.map(name => `- ${escapeText(name)}`).join('\n')
  const bodies = skills.map(skill => renderSkillContent(skill)).join('\n\n')
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        'The following always-apply skills are in effect for this session. Follow their instructions for the rest of the conversation.',
        'Do not call the `skill` tool again for these names unless their bodies are absent from this conversation.',
        '',
        '<always_apply_skills>',
        nameList,
        '</always_apply_skills>',
        '</system-reminder>',
        '',
        bodies,
      ].join('\n'),
    }],
    source,
  })
}

function alwaysApplyMessage(messages: readonly UserMessage[]): UserMessage | undefined {
  for (const message of messages) {
    if (readAlwaysApplyNames(message.source) !== undefined) return message
  }
  return undefined
}

/**
 * Names of one durable always-apply message, or undefined when the record is
 * not a usable always-apply source (seed validation only guarantees `kind`).
 * @param source - message source to inspect.
 * @returns readable name list, or undefined when the source is not this plugin's.
 */
function readAlwaysApplyNames(source: unknown): readonly string[] | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as { kind?: unknown; names?: unknown }
  if (record.kind !== 'skill-always-apply') return undefined
  if (!Array.isArray(record.names)) return undefined
  const names: string[] = []
  for (const entry of record.names as readonly unknown[]) {
    if (typeof entry !== 'string' || entry.length === 0) return undefined
    names.push(entry)
  }
  return names
}

function userMessageText(message: UserMessage): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
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
    throw new Error(`skill-always-apply: ${name} must be an integer greater than or equal to ${minimum}`)
  }
}
