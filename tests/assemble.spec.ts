import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import * as ProjectRules from '@firefly0621/dsh-always-apply'
import {
  renderProjectRulesSection,
  renderRuleContent,
  selectRulesForAssemble,
  resolveRulesRoot,
  SECTION_NAME,
} from '@firefly0621/dsh-always-apply'

type AssembleListener = (
  assembly: PromptAssembly,
  context: AssembleContext,
  next: () => Promise<PromptAssembly>,
) => Promise<PromptAssembly>

async function captureAssemble(ctx: Context): Promise<AssembleListener> {
  await ctx.plugin(SystemPrompt)
  let listener: AssembleListener | undefined
  const originalOn = ctx.on.bind(ctx)
  ;(ctx as unknown as { on: typeof ctx.on }).on = ((event: string, callback: (...args: never[]) => unknown) => {
    if (event === 'system-prompt/assemble') listener = callback as AssembleListener
    return originalOn(event as never, callback as never)
  }) as typeof ctx.on
  await ctx.plugin(ProjectRules)
  if (listener === undefined) throw new Error('assemble listener missing')
  return listener
}

function agentStub(cwd: string, origin: 'user' | 'subagent' = 'user', events: readonly SessionEvent[] = []): Agent {
  return {
    session: {
      header: { origin, cwd },
      snapshotEvents: () => events,
    },
  } as unknown as Agent
}

describe('package composition contracts', () => {
  it('exports a function plugin namespace with no default export', async () => {
    const mod = await import('@firefly0621/dsh-always-apply')
    expect(mod.name).toBe('rules')
    expect(mod.inject).toEqual([])
    expect(mod.apply).toEqual(expect.any(Function))
    expect('default' in mod && mod.default).toBeFalsy()
  })

  it('ships an insert-only overlay patch naming this package', async () => {
    const patchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
    const patches = loadOverlayPatches('rules-test', patchPath)
    expect(patches).toHaveLength(1)
    expect(patches[0]?.insert).toEqual([
      {
        id: 'rules',
        name: '@firefly0621/dsh-always-apply',
      },
      {
        id: 'ui-settings-rules',
        name: '@firefly0621/dsh-client-ui-settings-rules',
      },
    ])
  })

  it('declares publish metadata for the fork package', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string
      files: string[]
      repository: { url: string }
      dsh: { bundle: { patch: string } }
    }
    expect(pkg.version).toBe('0.1.0-rc.18')
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(pkg.repository.url).toBe('git+https://github.com/oThTJx/dsh-always-apply.git')
  })
})

describe('renderProjectRulesSection', () => {
  it('frames auto-attached rule_content blocks', () => {
    const text = renderProjectRulesSection({
      autoAttached: [
        { id: 'always', body: 'Always do the thing.' },
        { id: 'specific', body: 'Specific body.' },
      ],
    })
    expect(text).toContain('<auto_attached_rules>')
    expect(text).toContain(renderRuleContent({ id: 'always', body: 'Always do the thing.' }))
    expect(text).toContain(renderRuleContent({ id: 'specific', body: 'Specific body.' }))
    expect(text).toContain('Follow these rule bodies')
  })

  it('returns empty string when no rules', () => {
    expect(renderProjectRulesSection({ autoAttached: [] })).toBe('')
  })
})

describe('selectRulesForAssemble', () => {
  it('includes always and matching specific; excludes unmatched specific', () => {
    const selected = selectRulesForAssemble(
      [
        {
          id: 'a',
          relativePath: 'a.mdc',
          absolutePath: '/r/a.mdc',
          applyType: 'always',
          alwaysApply: true,
          description: '',
          globs: [],
          body: 'A',
        },
        {
          id: 's',
          relativePath: 's.mdc',
          absolutePath: '/r/s.mdc',
          applyType: 'specific',
          alwaysApply: false,
          description: '',
          globs: ['**/*.ts'],
          body: 'S',
        },
        {
          id: 's2',
          relativePath: 's2.mdc',
          absolutePath: '/r/s2.mdc',
          applyType: 'specific',
          alwaysApply: false,
          description: '',
          globs: ['**/*.py'],
          body: 'S2',
        },
        {
          id: 'off',
          relativePath: 'off.mdc',
          absolutePath: '/r/off.mdc',
          applyType: 'inactive',
          alwaysApply: false,
          description: 'dormant',
          globs: [],
          body: 'Off',
        },
      ],
      ['src/a.ts'],
      '/ws',
      100_000,
      () => {},
    )
    expect(selected.autoAttached.map(rule => rule.id)).toEqual(['a', 's'])
  })
})

describe('resolveRulesRoot', () => {
  it('rejects absolute and escaping rulesDir', () => {
    expect(() => resolveRulesRoot('/ws', '/etc')).toThrow(/relative/)
    expect(() => resolveRulesRoot('/ws', '../outside')).toThrow(/\.\./)
  })
})

describe('dsh-always-apply project rules plugin', () => {
  it('injects always and matching specific bodies', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'dsh-rules-'))
    try {
      const rulesDir = join(temp, '.dsh', 'rules')
      await mkdir(rulesDir, { recursive: true })
      await writeFile(join(rulesDir, 'always.mdc'), '---\nalwaysApply: true\n---\nAlways body.\n', 'utf8')
      await writeFile(join(rulesDir, 'specific.mdc'), '---\nalwaysApply: false\nglobs: "**/*.ts"\n---\nSpecific body.\n', 'utf8')
      await writeFile(join(rulesDir, 'unmatched.mdc'), '---\nalwaysApply: false\nglobs: "**/*.py"\n---\nPython body.\n', 'utf8')
      await writeFile(join(rulesDir, 'inactive.mdc'), '---\nalwaysApply: false\ndescription: dormant\n---\nInactive body.\n', 'utf8')

      const ctx = new Context()
      const listener = await captureAssemble(ctx)
      const base: PromptAssembly = { sections: [], contexts: [], tools: [], variables: {} }
      const agent = agentStub(temp, 'user', [
        {
          type: 'user/message',
          data: { content: [{ type: 'text', text: 'please edit packages/foo/bar.ts' }] },
        } as never,
      ])
      const result = await listener(base, { agent, signal: new AbortController().signal }, async () => ({ ...base }))
      expect(result.sections[0]?.name).toBe(SECTION_NAME)
      const text = result.sections.map(section => section.text).join('')
      expect(text).toContain('Always body.')
      expect(text).toContain('Specific body.')
      expect(text).not.toContain('Python body.')
      expect(text).not.toContain('Inactive body.')
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('skips subagent sessions by default', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'dsh-rules-sub-'))
    try {
      const rulesDir = join(temp, '.dsh', 'rules')
      await mkdir(rulesDir, { recursive: true })
      await writeFile(join(rulesDir, 'always.mdc'), '---\nalwaysApply: true\n---\nAlways body.\n', 'utf8')
      const ctx = new Context()
      const listener = await captureAssemble(ctx)
      const base: PromptAssembly = { sections: [], contexts: [], tools: [], variables: {} }
      const result = await listener(
        base,
        { agent: agentStub(temp, 'subagent'), signal: new AbortController().signal },
        async () => ({ ...base }),
      )
      expect(result.sections).toEqual([])
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('prefers Always over Specific when the byte budget is tight', async () => {
    const warnings: string[] = []
    const selected = selectRulesForAssemble(
      [
        {
          id: 'always',
          relativePath: 'always.mdc',
          absolutePath: '/r/always.mdc',
          applyType: 'always',
          alwaysApply: true,
          description: '',
          globs: [],
          body: 'A'.repeat(200),
        },
        {
          id: 'specific',
          relativePath: 'specific.mdc',
          absolutePath: '/r/specific.mdc',
          applyType: 'specific',
          alwaysApply: false,
          description: '',
          globs: ['**/*'],
          body: 'B'.repeat(200),
        },
      ],
      ['x.ts'],
      '/ws',
      500,
      (message) => { warnings.push(message) },
    )
    expect(selected.autoAttached.map(rule => rule.id)).toEqual(['always'])
    expect(warnings.some(message => message.includes('specific'))).toBe(true)
  })
})
