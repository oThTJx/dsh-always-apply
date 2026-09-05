/**
 * Load and cache project rules from a `.dsh/rules` tree.
 * @module @firefly0621/dsh-always-apply
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { parseMdcDocument } from './parse.ts'
import type { ParsedRule } from './types.ts'

/** Options for {@link loadRules}. */
export interface LoadRulesOptions {
  /** Optional abort signal for cooperative cancellation. */
  readonly signal?: AbortSignal
  /** Called for each skipped invalid file (message already includes the path). */
  readonly onWarning?: (message: string) => void
}

/**
 * Recursively load every valid `*.mdc` under `rulesRoot`, sorted by id.
 * Missing roots yield an empty list. Invalid files are skipped with {@link LoadRulesOptions.onWarning}.
 * @param rulesRoot - absolute path to the rules directory.
 * @param options - optional signal and warning sink.
 * @returns parsed rules bound to workspace-relative ids.
 */
export async function loadRules(rulesRoot: string, options: LoadRulesOptions = {}): Promise<ParsedRule[]> {
  options.signal?.throwIfAborted()
  let rootStat
  try {
    rootStat = await stat(rulesRoot)
  } catch {
    // Missing rules directory means zero rules.
    return []
  }
  if (!rootStat.isDirectory()) {
    options.onWarning?.(`rules root is not a directory: ${rulesRoot}`)
    return []
  }

  const files: string[] = []
  await walkMdcFiles(rulesRoot, rulesRoot, files, options.signal)
  files.sort((left, right) => compareCodePoints(toPosix(relative(rulesRoot, left)), toPosix(relative(rulesRoot, right))))

  const rules: ParsedRule[] = []
  for (const absolutePath of files) {
    options.signal?.throwIfAborted()
    const relativePath = toPosix(relative(rulesRoot, absolutePath))
    const id = relativePath.replace(/\.mdc$/i, '')
    let raw: string
    try {
      raw = await readFile(absolutePath, 'utf8')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      options.onWarning?.(`rules: skipping ${relativePath} — unreadable (${message})`)
      continue
    }
    try {
      const parsed = parseMdcDocument(raw)
      rules.push({
        ...parsed,
        id,
        relativePath,
        absolutePath,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      options.onWarning?.(`rules: skipping ${relativePath} — ${message}`)
    }
  }
  return rules
}

/**
 * Cache of loaded rule lists keyed by absolute rules-root path.
 * Call {@link RuleCache.invalidate} after Settings write/delete or external edits
 * when filesystem watch is enabled.
 */
export class RuleCache {
  readonly #entries = new Map<string, Promise<ParsedRule[]>>()

  /** Number of cached roots (including in-flight loads). */
  get size(): number {
    return this.#entries.size
  }

  /**
   * Return the cached rule list for `rulesRoot`, loading on miss.
   * @param rulesRoot - absolute rules directory.
   * @param options - forwarded to {@link loadRules} on miss.
   * @returns parsed rules for that root.
   */
  get(rulesRoot: string, options: LoadRulesOptions = {}): Promise<ParsedRule[]> {
    const key = rulesRoot
    const existing = this.#entries.get(key)
    if (existing !== undefined) return existing
    const loading = loadRules(rulesRoot, options).catch((error) => {
      this.#entries.delete(key)
      throw error
    })
    this.#entries.set(key, loading)
    return loading
  }

  /**
   * Drop one root's cache entry, or every entry when `rulesRoot` is omitted.
   * @param rulesRoot - absolute rules directory to drop; omit to clear all.
   */
  invalidate(rulesRoot?: string): void {
    if (rulesRoot === undefined) {
      this.#entries.clear()
      return
    }
    this.#entries.delete(rulesRoot)
  }
}

async function walkMdcFiles(
  rulesRoot: string,
  directory: string,
  out: string[],
  signal: AbortSignal | undefined,
): Promise<void> {
  signal?.throwIfAborted()
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    signal?.throwIfAborted()
    const absolutePath = join(directory, entry.name)
    if (entry.isDirectory()) {
      await walkMdcFiles(rulesRoot, absolutePath, out, signal)
      continue
    }
    if (!entry.isFile()) continue
    if (!entry.name.toLowerCase().endsWith('.mdc')) continue
    out.push(absolutePath)
  }
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
