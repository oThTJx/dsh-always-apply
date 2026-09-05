/**
 * Resolve the on-disk rules directory under a workspace root.
 * @module @firefly0621/dsh-always-apply
 */

import { isAbsolute, resolve, sep } from 'node:path'

/** Default relative rules directory. */
export const DEFAULT_RULES_DIR = '.dsh/rules'

/**
 * Resolve the absolute rules directory under a workspace root.
 * @param workspaceRoot - absolute session cwd / workspace root.
 * @param rulesDir - configured relative directory (default `.dsh/rules`).
 * @returns absolute rules root.
 */
export function resolveRulesRoot(workspaceRoot: string, rulesDir = DEFAULT_RULES_DIR): string {
  if (rulesDir.length === 0) {
    throw new Error('rules: rulesDir must be a non-empty relative path')
  }
  if (isAbsolute(rulesDir)) {
    throw new Error('rules: rulesDir must be a relative path under the workspace root')
  }
  const normalized = rulesDir.split(/[\\/]/).filter(part => part.length > 0 && part !== '.')
  if (normalized.some(part => part === '..')) {
    throw new Error('rules: rulesDir must not contain ".." segments')
  }
  const root = resolve(workspaceRoot)
  const candidate = resolve(root, ...normalized)
  if (!(candidate === root || candidate.startsWith(root + sep))) {
    throw new Error('rules: rulesDir escapes the workspace root')
  }
  return candidate
}
