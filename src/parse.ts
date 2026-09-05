/**
 * Parse and serialize Cursor-aligned `.mdc` project rules.
 * @module @firefly0621/dsh-always-apply
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type {
  ParsedMdcDocument,
  RuleApplyType,
  RuleFrontmatterInput,
  RuleWriteDocument,
} from './types.ts'

/**
 * Classify a rule from normalized frontmatter fields.
 * Priority: always (`alwaysApply: true`) → specific (non-empty `globs`) → inactive.
 * @param input - normalized frontmatter fields.
 * @returns the apply type.
 */
export function classifyApplyType(input: RuleFrontmatterInput): RuleApplyType {
  if (input.alwaysApply === true) return 'always'
  if ((input.globs?.length ?? 0) > 0) return 'specific'
  return 'inactive'
}

/**
 * Normalize YAML `globs` (string, comma-separated string, or string array) to a clean list.
 * @param value - raw frontmatter globs value.
 * @returns trimmed non-empty glob patterns in order.
 */
export function normalizeGlobs(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (typeof value === 'string') {
    return value.split(',').map(part => part.trim()).filter(part => part.length > 0)
  }
  if (Array.isArray(value)) {
    const out: string[] = []
    for (const entry of value) {
      if (typeof entry !== 'string') {
        throw new TypeError('frontmatter field "globs" entries must be strings')
      }
      const trimmed = entry.trim()
      if (trimmed.length > 0) out.push(trimmed)
    }
    return out
  }
  throw new TypeError('frontmatter field "globs" must be a string or string array')
}

/**
 * Whether the text contains a complete `{{...}}` group the prompt renderer cannot carry.
 * @param text - candidate body text.
 * @returns true when any `{{` is closed by a later `}}`.
 */
export function hasPromptVariableSyntax(text: string): boolean {
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', open + 2)) {
    if (text.indexOf('}}', open + 2) >= 0) return true
  }
  return false
}

/**
 * Parse a leading `---` YAML frontmatter block and markdown body from an `.mdc` file.
 * @param raw - complete file text.
 * @returns classified document fields.
 */
export function parseMdcDocument(raw: string): ParsedMdcDocument {
  const normalized = raw.replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---')) {
    throw new Error('mdc rule requires YAML frontmatter delimited by ---')
  }
  const afterOpen = normalized.slice(3)
  const newline = afterOpen.match(/^\r?\n/)
  if (newline === null) {
    throw new Error('mdc rule frontmatter opening --- must end a line')
  }
  const rest = afterOpen.slice(newline[0].length)
  const closeMatch = rest.match(/\r?\n---[ \t]*(?:\r?\n|$)/)
  if (closeMatch === null || closeMatch.index === undefined) {
    throw new Error('mdc rule frontmatter is missing the closing ---')
  }
  const yamlText = rest.slice(0, closeMatch.index)
  const body = rest.slice(closeMatch.index + closeMatch[0].length)
  let data: unknown
  try {
    data = parseYaml(yamlText)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`mdc rule frontmatter is invalid YAML: ${message}`)
  }
  if (data === null || data === undefined) {
    data = {}
  }
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('mdc rule frontmatter must be a YAML mapping')
  }
  const record = data as Record<string, unknown>
  const alwaysApply = frontmatterBoolean(record, 'alwaysApply') ?? false
  if (record.description !== undefined && typeof record.description !== 'string') {
    throw new TypeError('frontmatter field "description" must be a string')
  }
  const description = typeof record.description === 'string' ? record.description : ''
  const globs = normalizeGlobs(record.globs)
  if (hasPromptVariableSyntax(body)) {
    throw new Error('mdc rule body contains {{...}} prompt-variable syntax the system prompt cannot carry')
  }
  const applyType = classifyApplyType({ alwaysApply, description, globs })
  return {
    applyType,
    description: description.trim(),
    globs,
    alwaysApply: applyType === 'always',
    body,
  }
}

/**
 * Serialize an editor document to `.mdc` text using the Settings write-back shapes.
 * @param doc - apply type, fields, and body.
 * @returns file text with YAML frontmatter and body.
 */
export function serializeMdcDocument(doc: RuleWriteDocument): string {
  const mapping: Record<string, unknown> = {}
  switch (doc.applyType) {
    case 'always':
      mapping.alwaysApply = true
      if (doc.description.trim().length > 0) mapping.description = doc.description.trim()
      break
    case 'specific':
      mapping.alwaysApply = false
      if (doc.description.trim().length > 0) mapping.description = doc.description.trim()
      mapping.globs = [...doc.globs]
      break
    default: {
      const _exhaustive: never = doc.applyType
      return _exhaustive
    }
  }
  const yaml = stringifyYaml(mapping, { lineWidth: 0 }).trimEnd()
  const body = doc.body.endsWith('\n') || doc.body.length === 0 ? doc.body : `${doc.body}\n`
  return `---\n${yaml}\n---\n${body.startsWith('\n') ? body : `\n${body}`}`
}

/**
 * Parse a frontmatter boolean using common YAML / English spellings.
 * @param data - parsed frontmatter object.
 * @param key - field name.
 * @returns boolean when present; undefined when absent.
 */
function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!(key in data)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    switch (value.trim().toLowerCase()) {
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
