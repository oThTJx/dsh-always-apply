import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { RuleCache } from '../src/load.ts'
import { assertRuleId, ProjectRulesGateway } from '../src/remote.ts'

describe('assertRuleId', () => {
  it('normalizes and rejects escapes', () => {
    expect(assertRuleId('frontend/components')).toBe('frontend/components')
    expect(() => assertRuleId('../x')).toThrow(/\.\./)
    expect(() => assertRuleId('a.mdc')).toThrow(/extension/)
    expect(() => assertRuleId('/abs')).toThrow(/relative/)
  })
})

describe('ProjectRulesGateway', () => {
  it('publishes list/read/write/delete remotes', () => {
    const ctx = new Context()
    const gateway = new ProjectRulesGateway(ctx, { cache: new RuleCache(), rulesDir: '.dsh/rules' })
    expect(gateway.typertRemote).toMatchObject({ serviceKey: 'projectRules', namespace: 'projectRules' })
    expect(remoteMethods(gateway).map(entry => entry.method).sort()).toEqual([
      'delete',
      'list',
      'read',
      'write',
    ])
  })

  it('lists, writes, reads, and deletes rules under the workspace', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'dsh-rules-remote-'))
    try {
      const ctx = new Context()
      const gateway = new ProjectRulesGateway(ctx, { cache: new RuleCache(), rulesDir: '.dsh/rules' })
      expect(await gateway.list(temp)).toEqual([])

      const written = await gateway.write(temp, {
        id: 'frontend/ui',
        applyType: 'specific',
        description: 'UI rules',
        globs: ['**/*.tsx'],
        body: 'Use CSS modules.\n',
      })
      expect(written.id).toBe('frontend/ui')
      expect(written.applyType).toBe('specific')

      const disk = await readFile(join(temp, '.dsh', 'rules', 'frontend', 'ui.mdc'), 'utf8')
      expect(disk).toContain('description: UI rules')

      expect(await gateway.list(temp)).toEqual([
        expect.objectContaining({ id: 'frontend/ui', applyType: 'specific' }),
      ])
      expect(await gateway.read(temp, 'frontend/ui')).toMatchObject({
        id: 'frontend/ui',
        body: expect.stringContaining('Use CSS modules.'),
      })

      await gateway.write(temp, {
        id: 'frontend/ui2',
        previousId: 'frontend/ui',
        applyType: 'always',
        description: '',
        globs: [],
        body: 'Always.\n',
      })
      await expect(gateway.read(temp, 'frontend/ui')).rejects.toThrow(/unknown/)
      expect((await gateway.read(temp, 'frontend/ui2')).applyType).toBe('always')

      await gateway.delete(temp, 'frontend/ui2')
      expect(await gateway.list(temp)).toEqual([])
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('rejects delete of non-existent rule', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'dsh-rules-del-'))
    try {
      const ctx = new Context()
      const gateway = new ProjectRulesGateway(ctx, { cache: new RuleCache(), rulesDir: '.dsh/rules' })
      await expect(gateway.delete(temp, 'nonexistent')).rejects.toThrow(/does not exist/)
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('rejects rename onto an existing rule id without touching either file', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'dsh-rules-rename-collide-'))
    try {
      const ctx = new Context()
      const gateway = new ProjectRulesGateway(ctx, { cache: new RuleCache(), rulesDir: '.dsh/rules' })
      await gateway.write(temp, {
        id: 'keep',
        applyType: 'always',
        description: '',
        globs: [],
        body: 'Keep body.\n',
      })
      await gateway.write(temp, {
        id: 'move-me',
        applyType: 'always',
        description: '',
        globs: [],
        body: 'Move body.\n',
      })

      await expect(gateway.write(temp, {
        id: 'keep',
        previousId: 'move-me',
        applyType: 'always',
        description: '',
        globs: [],
        body: 'Would overwrite.\n',
      })).rejects.toThrow(/already exists/)

      expect((await gateway.read(temp, 'keep')).body).toContain('Keep body.')
      expect((await gateway.read(temp, 'move-me')).body).toContain('Move body.')
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('lists through the Cordis service tracker proxy (Typert Gateway receiver)', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'dsh-rules-proxy-'))
    try {
      await mkdir(join(temp, '.dsh', 'rules'), { recursive: true })
      await writeFile(join(temp, '.dsh', 'rules', 'a.mdc'), '---\nalwaysApply: true\n---\nBody.\n', 'utf8')
      const ctx = new Context()
      new ProjectRulesGateway(ctx, { cache: new RuleCache(), rulesDir: '.dsh/rules' })
      const receiver = ctx.get('projectRules') as ProjectRulesGateway
      expect(receiver).toBeDefined()
      const method = Reflect.get(receiver as object, 'list') as (
        this: ProjectRulesGateway,
        workspaceRoot: string,
      ) => Promise<unknown>
      await expect(Reflect.apply(method, receiver, [temp])).resolves.toEqual([
        expect.objectContaining({ id: 'a', applyType: 'always' }),
      ])
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('rejects non-absolute defaultWorkspaceRoot at construction', () => {
    const ctx1 = new Context()
    expect(() => new ProjectRulesGateway(ctx1, {
      cache: new RuleCache(),
      rulesDir: '.dsh/rules',
      defaultWorkspaceRoot: '../outside',
    })).toThrow(/absolute/)
    const ctx2 = new Context()
    expect(() => new ProjectRulesGateway(ctx2, {
      cache: new RuleCache(),
      rulesDir: '.dsh/rules',
      defaultWorkspaceRoot: 'relative/path',
    })).toThrow(/absolute/)
  })

  it('accepts absolute defaultWorkspaceRoot and normalizes it', () => {
    const ctx = new Context()
    const gateway = new ProjectRulesGateway(ctx, {
      cache: new RuleCache(),
      rulesDir: '.dsh/rules',
      defaultWorkspaceRoot: '/tmp/workspace',
    })
    expect(gateway).toBeDefined()
  })

  it('uses defaultWorkspaceRoot when workspaceRoot is undefined', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'dsh-rules-default-'))
    try {
      await mkdir(join(temp, '.dsh', 'rules'), { recursive: true })
      await writeFile(join(temp, '.dsh', 'rules', 'test.mdc'), '---\nalwaysApply: true\n---\nTest body.\n', 'utf8')
      const ctx = new Context()
      const gateway = new ProjectRulesGateway(ctx, {
        cache: new RuleCache(),
        rulesDir: '.dsh/rules',
        defaultWorkspaceRoot: temp,
      })
      const list = await gateway.list()
      expect(list).toEqual([
        expect.objectContaining({ id: 'test', applyType: 'always' }),
      ])
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('throws when workspaceRoot is undefined and no defaultWorkspaceRoot configured', async () => {
    const ctx = new Context()
    const gateway = new ProjectRulesGateway(ctx, { cache: new RuleCache(), rulesDir: '.dsh/rules' })
    await expect(gateway.list()).rejects.toThrow(/workspaceRoot is required/)
  })
})
