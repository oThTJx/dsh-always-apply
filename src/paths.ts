/**
 * In-context path collection and Specific-Files glob matching for project rules.
 * @module @firefly0621/dsh-always-apply
 */

import { isAbsolute, relative, sep } from 'node:path'
import picomatch from 'picomatch'
import type { Agent } from '@deepseek-ai/dsh-agent'

const FILE_TOUCH_TOOL_NAMES = new Set(['read', 'write', 'edit'])

/** Matches workspace-ish path tokens in user prose (posix or Windows). */
const PATH_TOKEN = /(?:^|[\s`'"({\[<])((?:[A-Za-z]:)?(?:\.?\.?\/|\\)?[\w.@+-]+(?:[\\/][\w.@+-]+)+)/g

/**
 * Extract path-like tokens from user-visible text (including `@path` mention forms).
 * @param text - user message text.
 * @returns ordered unique path tokens as they appeared (trimmed, without leading `@`).
 */
export function pathTokensFromText(text: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const normalized = text.replace(/(^|[\s])@((?:[\w.@+-]+[\\/])+[\w.@+-]+)/g, '$1$2')
  for (const match of normalized.matchAll(PATH_TOKEN)) {
    const token = match[1]?.replace(/[),.;:!?]+$/u, '') ?? ''
    if (token.length === 0 || seen.has(token)) continue
    seen.add(token)
    found.push(token)
  }
  return found
}

/**
 * Read `file_path` from a read/write/edit tool-call arguments JSON string.
 * @param name - tool name.
 * @param argumentsJson - serialized tool arguments.
 * @returns file path when present; otherwise undefined.
 */
export function filePathFromToolCall(name: string, argumentsJson: string): string | undefined {
  if (!FILE_TOUCH_TOOL_NAMES.has(name)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson) as unknown
  } catch {
    // Malformed tool arguments cannot contribute a path.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  if (!('file_path' in parsed) || typeof (parsed as { file_path: unknown }).file_path !== 'string') {
    return undefined
  }
  const filePath = (parsed as { file_path: string }).file_path.trim()
  return filePath.length > 0 ? filePath : undefined
}

/**
 * Build the v1 in-context path set for Specific Files matching.
 * Union of tool-touched `file_path` values from session `tool/call` events and path tokens
 * from durable user message text (full window scanned).
 * @param agent - session-bearing agent.
 * @returns deduped paths suitable for {@link ruleMatchesContext}.
 */
export function collectInContextPaths(agent: Agent): string[] {
  const toolCalls: { name: string; arguments: string }[] = []
  const userTexts: string[] = []
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'tool/call') {
      toolCalls.push({ name: event.data.name, arguments: event.data.arguments })
      continue
    }
    if (event.type === 'user/message') {
      for (const block of event.data.content) {
        if (block.type === 'text') userTexts.push(block.text)
      }
    }
  }
  return collectInContextPathsFromParts({ toolCalls, userTexts })
}

/**
 * Collect in-context paths from plain tool-call and user-text parts (unit-test face).
 * @param parts - tool calls and user texts.
 * @returns deduped paths in discovery order.
 */
export function collectInContextPathsFromParts(parts: {
  readonly toolCalls?: readonly { readonly name: string; readonly arguments: string }[]
  readonly userTexts?: readonly string[]
}): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const add = (path: string): void => {
    if (seen.has(path)) return
    seen.add(path)
    found.push(path)
  }
  for (const call of parts.toolCalls ?? []) {
    const path = filePathFromToolCall(call.name, call.arguments)
    if (path !== undefined) add(path)
  }
  for (const text of parts.userTexts ?? []) {
    for (const token of pathTokensFromText(text)) add(token)
  }
  return found
}

/**
 * Whether any in-context path matches any of the rule globs relative to the workspace root.
 * @param globs - rule glob patterns.
 * @param paths - in-context paths (absolute or workspace-relative).
 * @param workspaceRoot - absolute workspace root used to relativize absolute paths.
 * @returns true when at least one path matches.
 */
export function ruleMatchesContext(
  globs: readonly string[],
  paths: readonly string[],
  workspaceRoot: string,
): boolean {
  if (globs.length === 0 || paths.length === 0) return false
  const isMatch = picomatch([...globs], { dot: true, windows: true })
  for (const path of paths) {
    const relativePath = toWorkspaceRelative(path, workspaceRoot)
    if (relativePath === undefined) continue
    if (isMatch(relativePath)) return true
  }
  return false
}

/**
 * Normalize a path to a posix-relative workspace path for glob matching.
 * @param path - absolute or relative path from context.
 * @param workspaceRoot - absolute workspace root.
 * @returns posix relative path, or undefined when the path escapes the workspace.
 */
export function toWorkspaceRelative(path: string, workspaceRoot: string): string | undefined {
  const rel = isAbsolute(path) ? relative(workspaceRoot, path) : path
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined
  return rel.split(sep).join('/')
}
