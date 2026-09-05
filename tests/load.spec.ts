import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRules, RuleCache } from '../src/load.ts'
import { RulesRootWatcher } from '../src/watch.ts'

const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map(async (dir) => {
    await rm(dir, { recursive: true, force: true })
  }))
})

async function tempRulesRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rules-'))
  temps.push(dir)
  return dir
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('loadRules', () => {
  it('loads nested .mdc files and ignores .md', async () => {
    const root = await tempRulesRoot()
    await mkdir(join(root, 'frontend'), { recursive: true })
    await writeFile(join(root, 'always.mdc'), '---\nalwaysApply: true\n---\nA\n', 'utf8')
    await writeFile(join(root, 'frontend', 'components.mdc'), '---\ndescription: UI\nalwaysApply: false\n---\nB\n', 'utf8')
    await writeFile(join(root, 'readme.md'), '---\nalwaysApply: true\n---\nignored\n', 'utf8')

    const warnings: string[] = []
    const rules = await loadRules(root, { onWarning: (message) => { warnings.push(message) } })
    expect(rules.map(rule => rule.id)).toEqual(['always', 'frontend/components'])
    expect(rules[0]?.applyType).toBe('always')
    expect(rules[1]?.applyType).toBe('inactive')
    expect(warnings).toEqual([])
  })

  it('skips invalid frontmatter with a warning', async () => {
    const root = await tempRulesRoot()
    await writeFile(join(root, 'broken.mdc'), 'not a rule\n', 'utf8')
    await writeFile(join(root, 'ok.mdc'), '---\nalwaysApply: true\n---\nok\n', 'utf8')

    const warnings: string[] = []
    const rules = await loadRules(root, { onWarning: (message) => { warnings.push(message) } })
    expect(rules.map(rule => rule.id)).toEqual(['ok'])
    expect(warnings.some(message => message.includes('broken.mdc'))).toBe(true)
  })

  it('returns empty when the directory is missing', async () => {
    const rules = await loadRules(join(tmpdir(), 'dsh-rules-missing-does-not-exist'))
    expect(rules).toEqual([])
  })
})

describe('RuleCache', () => {
  it('caches by root and invalidates', async () => {
    const root = await tempRulesRoot()
    await writeFile(join(root, 'a.mdc'), '---\nalwaysApply: true\n---\n1\n', 'utf8')
    const cache = new RuleCache()
    const first = await cache.get(root)
    expect(first).toHaveLength(1)
    await writeFile(join(root, 'b.mdc'), '---\nalwaysApply: true\n---\n2\n', 'utf8')
    expect(await cache.get(root)).toHaveLength(1)
    cache.invalidate(root)
    expect(await cache.get(root)).toHaveLength(2)
    cache.invalidate()
    expect(cache.size).toBe(0)
  })
})

describe('RulesRootWatcher', () => {
  it('debounces invalidation and disposes cleanly', async () => {
    const root = await tempRulesRoot()
    const invalidated: string[] = []
    const watcher = new RulesRootWatcher({
      debounceMs: 25,
      onInvalidate: (rulesRoot) => { invalidated.push(rulesRoot) },
    })
    watcher.scheduleInvalidate(root)
    watcher.scheduleInvalidate(root)
    await wait(50)
    expect(invalidated).toEqual([root])
    watcher.dispose()
    watcher.scheduleInvalidate(root)
    await wait(50)
    expect(invalidated).toEqual([root])
  })

  it('starts watching an existing rules root', async () => {
    const root = await tempRulesRoot()
    const watcher = new RulesRootWatcher({
      onInvalidate: () => {},
    })
    watcher.ensure(root)
    watcher.dispose()
  })
})
