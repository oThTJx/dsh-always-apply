/**
 * Typert Remote gateway for project-rule CRUD and session apply.
 * @module @firefly0621/dsh-always-apply
 */

import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { RuleCache } from './load.ts'
import { parseMdcDocument, serializeMdcDocument } from './parse.ts'
import { resolveRulesRoot } from './resolve-root.ts'
import type { ParsedRule, RuleDetail, RuleListItem, RuleWriteDocument, RuleWriteInput } from './types.ts'

export type { RuleDetail, RuleListItem, RuleWriteInput } from './types.ts'
/** Options supplied when the gateway is constructed from the rules plugin. */
export interface ProjectRulesGatewayOptions {
  readonly cache: RuleCache
  readonly rulesDir: string
  readonly defaultWorkspaceRoot?: string | undefined
}

/**
 * Host Remote `projectRules` — list/read/write/delete `.mdc` files and apply one to a live session.
 *
 * State uses TypeScript `private` (not `#` fields): Typert Gateway invokes remotes with
 * Cordis's Service tracker proxy as `this`, and JS private fields reject that receiver.
 */
export class ProjectRulesGateway extends TypertRemoteService {
  private readonly cache: RuleCache
  private readonly rulesDir: string
  private readonly defaultWorkspaceRoot: string | undefined

  /**
   * @param ctx - Cordis context (registers service key `projectRules`).
   * @param options - shared rule cache and configured relative rules directory.
   */
  constructor(ctx: Context, options: ProjectRulesGatewayOptions) {
    super(ctx, 'projectRules')
    this.cache = options.cache
    this.rulesDir = options.rulesDir
    if (options.defaultWorkspaceRoot !== undefined) {
      if (!isAbsolute(options.defaultWorkspaceRoot)) {
        throw new Error('projectRules: defaultWorkspaceRoot must be an absolute path')
      }
      this.defaultWorkspaceRoot = resolve(options.defaultWorkspaceRoot)
    }
  }

  /**
   * Resolve workspace root with fallback to default.
   * @param workspaceRoot - explicit workspace root, or undefined to use default.
   * @returns resolved workspace root.
   */
  private resolveWorkspaceRoot(workspaceRoot: string | undefined): string {
    if (workspaceRoot !== undefined && workspaceRoot.length > 0) {
      return workspaceRoot
    }
    if (this.defaultWorkspaceRoot !== undefined) {
      return this.defaultWorkspaceRoot
    }
    throw new Error('workspaceRoot is required when no defaultWorkspaceRoot is configured')
  }

  /**
   * List every valid rule under the workspace rules root.
   * @param workspaceRoot - absolute workspace root (session cwd), or undefined to use default.
   * @returns list rows sorted by id.
   */
  @Remote('list')
  async list(workspaceRoot?: string): Promise<RuleListItem[]> {
    const rules = await this.load(this.resolveWorkspaceRoot(workspaceRoot))
    return rules.map(toListItem)
  }

  /**
   * Read one rule by id.
   * @param workspaceRoot - absolute workspace root, or undefined to use default.
   * @param id - rule id.
   * @returns full detail.
   */
  @Remote('read')
  async read(workspaceRoot: string | undefined, id: string): Promise<RuleDetail> {
    const rule = await this.requireRule(this.resolveWorkspaceRoot(workspaceRoot), id)
    return toDetail(rule)
  }

  /**
   * Create or update a rule file; optionally rename when `previousId` differs.
   * @param workspaceRoot - absolute workspace root, or undefined to use default.
   * @param input - write payload.
   * @returns the stored detail.
   */
  @Remote('write')
  async write(workspaceRoot: string | undefined, input: RuleWriteInput): Promise<RuleDetail> {
    const resolvedRoot = this.resolveWorkspaceRoot(workspaceRoot)
    const id = assertRuleId(input.id)
    if (input.applyType === 'specific' && input.globs.length === 0) {
      throw new Error('specific-file rules require at least one glob')
    }
    const doc: RuleWriteDocument = {
      applyType: input.applyType,
      description: input.description,
      globs: input.globs,
      body: input.body,
    }
    // Validate round-trip before touching the filesystem.
    parseMdcDocument(serializeMdcDocument(doc))

    const rulesRoot = this.rulesRootFor(resolvedRoot)
    await mkdir(rulesRoot, { recursive: true })
    const targetPath = ruleFilePath(rulesRoot, id)
    const previousId = input.previousId !== undefined ? assertRuleId(input.previousId) : undefined
    if (previousId !== undefined && previousId !== id) {
      if (await pathExists(targetPath)) {
        throw new Error(`cannot rename to "${id}": a rule with that id already exists`)
      }
      const previousPath = ruleFilePath(rulesRoot, previousId)
      await mkdir(dirname(targetPath), { recursive: true })
      await writeFile(targetPath, serializeMdcDocument(doc), 'utf8')
      await rm(previousPath, { force: true })
    } else {
      await mkdir(dirname(targetPath), { recursive: true })
      await writeFile(targetPath, serializeMdcDocument(doc), 'utf8')
    }
    // Drop unused empty parents after rename is best-effort; ignore failures.
    if (previousId !== undefined && previousId !== id) {
      try {
        await rm(dirname(ruleFilePath(rulesRoot, previousId)), { recursive: false })
      } catch {
        // Directory not empty or missing.
      }
    }
    this.cache.invalidate(rulesRoot)
    return this.read(workspaceRoot, id)
  }

  /**
   * Delete one rule file.
   * @param workspaceRoot - absolute workspace root, or undefined to use default.
   * @param id - rule id.
   * @returns `{ ok: true }` when removed.
   */
  @Remote('delete')
  async delete(workspaceRoot: string | undefined, id: string): Promise<{ ok: true }> {
    const rulesRoot = this.rulesRootFor(this.resolveWorkspaceRoot(workspaceRoot))
    const absolutePath = ruleFilePath(rulesRoot, assertRuleId(id))
    if (!await pathExists(absolutePath)) {
      throw new Error(`rule "${id}" does not exist`)
    }
    await rm(absolutePath, { force: true })
    this.cache.invalidate(rulesRoot)
    return { ok: true }
  }

  private rulesRootFor(workspaceRoot: string): string {
    return resolveRulesRoot(resolve(workspaceRoot), this.rulesDir)
  }

  private async load(workspaceRoot: string): Promise<ParsedRule[]> {
    const rulesRoot = this.rulesRootFor(workspaceRoot)
    return this.cache.get(rulesRoot, {
      onWarning: (message) => { this.ctx.logger.warn(message) },
    })
  }

  private async requireRule(workspaceRoot: string, id: string): Promise<ParsedRule> {
    const normalized = assertRuleId(id)
    const rule = (await this.load(workspaceRoot)).find(entry => entry.id === normalized)
    if (rule === undefined) {
      throw new Error(`rule "${normalized}" is unknown or no longer available`)
    }
    return rule
  }
}

/**
 * Reject empty, absolute, or escaping rule ids.
 * @param id - candidate id.
 * @returns normalized posix id.
 */
export function assertRuleId(id: string): string {
  const trimmed = id.trim().replaceAll('\\', '/')
  if (trimmed.length === 0) throw new Error('rule id must be a non-empty string')
  if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) {
    throw new Error('rule id must be a relative path')
  }
  const parts = trimmed.split('/').filter(part => part.length > 0)
  if (parts.some(part => part === '.' || part === '..')) {
    throw new Error('rule id must not contain "." or ".." segments')
  }
  if (parts.some(part => part.toLowerCase().endsWith('.mdc'))) {
    throw new Error('rule id must not include the .mdc extension')
  }
  return parts.join('/')
}

function ruleFilePath(rulesRoot: string, id: string): string {
  const absolutePath = join(rulesRoot, ...id.split('/')) + '.mdc'
  const root = resolve(rulesRoot)
  const candidate = resolve(absolutePath)
  if (!(candidate === root || candidate.startsWith(root + sep))) {
    throw new Error('rule path escapes the rules root')
  }
  return candidate
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await access(absolutePath)
    return true
  } catch {
    // Missing path is the common case for create/rename into a free id.
    return false
  }
}

function toListItem(rule: ParsedRule): RuleListItem {
  return {
    id: rule.id,
    applyType: rule.applyType,
    description: rule.description,
    globs: [...rule.globs],
  }
}

function toDetail(rule: ParsedRule): RuleDetail {
  return {
    ...toListItem(rule),
    body: rule.body,
  }
}
