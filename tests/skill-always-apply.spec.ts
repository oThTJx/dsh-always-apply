import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import * as SkillAlwaysApply from '@firefly0621/dsh-skill-always-apply'
import {
  alwaysApplyPresence,
  renderAlwaysApplyMessage,
  sessionHasAlwaysApply,
  shouldSkipAlwaysApplyInjection,
} from '@firefly0621/dsh-skill-always-apply'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

type AlwaysApplySkillRegistration = SkillRegistration & { readonly alwaysApply?: boolean }

function registerAlwaysApply(ctx: Context, skill: AlwaysApplySkillRegistration): void {
  ctx.skills.register(skill)
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function alwaysApplyTexts(agent: Agent): string[] {
  return [...agent.session.events]
    .filter((e): e is SessionEvent<'user/message'> =>
      e.type === 'user/message' && e.data.source.kind === 'skill-always-apply')
    .map(e => e.data.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

describe('package composition contracts', () => {
  it('exports a function plugin namespace with no default export', async () => {
    const mod = await import('@firefly0621/dsh-skill-always-apply')
    expect(mod.name).toBe('skill-always-apply')
    expect(mod.inject).toEqual(['skills'])
    expect(mod.apply).toEqual(expect.any(Function))
    expect('default' in mod && mod.default).toBeFalsy()
  })

  it('ships an insert-only overlay patch naming this package', async () => {
    const patchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
    const patches = loadOverlayPatches('skill-always-apply-test', patchPath)
    expect(patches).toHaveLength(1)
    expect(patches[0]?.insert).toEqual([
      {
        id: 'skill-always-apply',
        name: '@firefly0621/dsh-skill-always-apply',
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
    expect(pkg.version).toBe('0.1.0-rc.8')
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(pkg.files).toEqual([
      'lib/index.js',
      'lib/invariant.js',
      'cordis.patch.yml',
      'lib/types/**/*.d.ts',
    ])
    expect(pkg.repository.url).toBe('git+https://github.com/oThTJx/dsh-skill-always-apply.git')
  })
})

describe('renderAlwaysApplyMessage', () => {
  it('frames skill names and canonical skill_content bodies', () => {
    const message = renderAlwaysApplyMessage([{
      name: 'demo-skill',
      description: 'Demo',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'project-dsh',
      provider: 'runtime',
      content: 'Always do the thing.',
    }])
    expect(message.source).toEqual({
      kind: 'skill-always-apply',
      form: 'instructions',
      names: ['demo-skill'],
    })
    const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('<always_apply_skills>')
    expect(text).toContain('- demo-skill')
    expect(text).toContain('<skill_content name="demo-skill">')
    expect(text).toContain('Always do the thing.')
  })
})

describe('alwaysApplyPresence / shouldSkipAlwaysApplyInjection', () => {
  it('skips only while an always-apply message remains model-visible', () => {
    const message = renderAlwaysApplyMessage([{
      name: 'demo-skill',
      description: 'Demo',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'project-dsh',
      provider: 'runtime',
      content: 'body',
    }])
    const publishedOnly = {
      session: {
        events: [{
          type: 'user/message',
          seq: 7,
          data: { source: message.source, content: message.content },
        }],
        surface: { nodes: [] },
      },
    } as unknown as Agent
    const visible = {
      session: {
        events: publishedOnly.session.events,
        surface: { nodes: [7] },
      },
    } as unknown as Agent

    expect(alwaysApplyPresence(publishedOnly)).toEqual({ published: true, visible: false })
    expect(shouldSkipAlwaysApplyInjection(publishedOnly, [])).toBe(false)
    expect(alwaysApplyPresence(visible)).toEqual({ published: true, visible: true })
    expect(shouldSkipAlwaysApplyInjection(visible, [])).toBe(true)
    expect(shouldSkipAlwaysApplyInjection(publishedOnly, [message])).toBe(true)
  })
})

describe('dsh-skill-always-apply plugin', () => {
  it('detects alwaysApply from loaded definitions when summaries lack the field', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'dsh-skill-always-apply-main-'))
    try {
      const fileSkillPath = join(temp, 'from-file.md')
      await writeFile(fileSkillPath, [
        '---',
        'name: from-file',
        'description: File fixture',
        'alwaysApply: true',
        '---',
        '',
        'Frontmatter body.',
      ].join('\n'), 'utf8')

      const ctx = new Context()
      const skills = {
        snapshot: async () => ({
          complete: true,
          skills: [
            {
              name: 'from-file',
              description: 'File fixture',
              invocation: { modelInvocable: true, userInvocable: true },
              source: 'project-dsh',
              provider: 'filesystem',
            },
            {
              name: 'from-extra',
              description: 'Extra fixture',
              invocation: { modelInvocable: true, userInvocable: true },
              source: 'runtime',
              provider: 'runtime',
            },
            {
              name: 'ordinary',
              description: 'Ordinary fixture',
              invocation: { modelInvocable: true, userInvocable: true },
              source: 'runtime',
              provider: 'runtime',
            },
          ],
        }),
        get: async (name: string) => {
          if (name === 'from-file') {
            return {
              name,
              description: 'File fixture',
              invocation: { modelInvocable: true, userInvocable: true },
              source: 'project-dsh',
              provider: 'filesystem',
              path: fileSkillPath,
              content: 'Frontmatter body.',
            }
          }
          if (name === 'from-extra') {
            return {
              name,
              description: 'Extra fixture',
              alwaysApply: true,
              invocation: { modelInvocable: true, userInvocable: true },
              source: 'runtime',
              provider: 'runtime',
              content: 'Extra body.',
            }
          }
          return {
            name,
            description: 'Ordinary fixture',
            invocation: { modelInvocable: true, userInvocable: true },
            source: 'runtime',
            provider: 'runtime',
            content: 'Ordinary body.',
          }
        },
      }
      ctx.provide('skills', skills as never)

      let listener:
        | ((payload: { agent: Agent; signal: AbortSignal }, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>)
        | undefined
      const originalOn = ctx.on.bind(ctx)
      ;(ctx as unknown as { on: typeof ctx.on }).on = ((event: string, callback: (...args: never[]) => unknown) => {
        if (event === 'agent/pre-step') listener = callback as typeof listener
        return originalOn(event as never, callback as never)
      }) as typeof ctx.on

      await ctx.plugin(SkillAlwaysApply)
      expect(listener).toBeDefined()

      const agent = {
        session: {
          header: { origin: 'user', cwd: temp },
          events: [],
          surface: { nodes: [] },
        },
      } as unknown as Agent
      const next = async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] })
      const decision = await listener!({ agent, signal: new AbortController().signal }, next)
      expect(decision.kind).toBe('enter')
      if (decision.kind !== 'enter') throw new Error('expected enter decision')
      const text = decision.messages.map(message =>
        message.content.map(block => block.type === 'text' ? block.text : '').join(''),
      ).join('')
      expect(text).toContain('Frontmatter body.')
      expect(text).toContain('Extra body.')
      expect(text).not.toContain('Ordinary body.')
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('injects alwaysApply skills on the first pre-step', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(ToolSkill)
    await ctx.plugin(SkillAlwaysApply)
    registerAlwaysApply(ctx, {
      name: 'always-on',
      description: 'Always-on fixture',
      alwaysApply: true,
      source: 'project-dsh',
      content: 'Follow always-on rules.',
    })
    registerAlwaysApply(ctx, {
      name: 'on-demand',
      description: 'Ordinary fixture',
      source: 'project-dsh',
      content: 'Load me on demand.',
    })
    const adapter = new MockAdapter([textResponse('ok')])
    ctx.llm.registerAdapter(['mock'], adapter)

    const agent = ctx.agentLoop.create(SessionId('aa-boot'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const injected = alwaysApplyTexts(agent)
    expect(injected).toHaveLength(1)
    expect(injected[0]).toContain('Follow always-on rules.')
    expect(injected[0]).not.toContain('Load me on demand.')
    expect(sessionHasAlwaysApply(agent)).toBe(true)
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('Follow always-on rules.')
  })

  it('honors Config.names and disabledNames', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillAlwaysApply, {
      names: ['forced-on'],
      disabledNames: ['always-on'],
    })
    registerAlwaysApply(ctx, {
      name: 'always-on',
      description: 'Marked but disabled',
      alwaysApply: true,
      source: 'project-dsh',
      content: 'Should stay out.',
    })
    registerAlwaysApply(ctx, {
      name: 'forced-on',
      description: 'Forced by config',
      source: 'project-dsh',
      content: 'Forced body.',
    })
    const adapter = new MockAdapter([textResponse('ok')])
    ctx.llm.registerAdapter(['mock'], adapter)

    const agent = ctx.agentLoop.create(SessionId('aa-cfg'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const injected = alwaysApplyTexts(agent)
    expect(injected).toHaveLength(1)
    expect(injected[0]).toContain('Forced body.')
    expect(injected[0]).not.toContain('Should stay out.')
  })

  it('skips injection for subagent-origin sessions', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillAlwaysApply)
    registerAlwaysApply(ctx, {
      name: 'always-on',
      description: 'Always-on fixture',
      alwaysApply: true,
      source: 'project-dsh',
      content: 'Follow always-on rules.',
    })
    const adapter = new MockAdapter([textResponse('ok')])
    ctx.llm.registerAdapter(['mock'], adapter)

    const handle = await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId('aa-sub'),
      meta: { origin: 'subagent' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(handle.agent.session.header.origin).toBe('subagent')
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, handle.agent)
    expect(alwaysApplyTexts(handle.agent)).toEqual([])
  })

  it('does not duplicate always-apply on a later step', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillAlwaysApply)
    registerAlwaysApply(ctx, {
      name: 'always-on',
      description: 'Always-on fixture',
      alwaysApply: true,
      source: 'project-dsh',
      content: 'Follow always-on rules.',
    })
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    ctx.llm.registerAdapter(['mock'], adapter)

    const agent = ctx.agentLoop.create(SessionId('aa-once'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(alwaysApplyTexts(agent)).toHaveLength(1)
  })

  it('skips oversized skills under maxTotalBytes', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillAlwaysApply, { maxTotalBytes: 900 })
    registerAlwaysApply(ctx, {
      name: 'tiny',
      description: 'Tiny',
      alwaysApply: true,
      source: 'project-dsh',
      content: 'ok',
    })
    registerAlwaysApply(ctx, {
      name: 'huge',
      description: 'Huge',
      alwaysApply: true,
      source: 'project-dsh',
      content: 'x'.repeat(2_000),
    })
    const adapter = new MockAdapter([textResponse('ok')])
    ctx.llm.registerAdapter(['mock'], adapter)

    const agent = ctx.agentLoop.create(SessionId('aa-bytes'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const injected = alwaysApplyTexts(agent)
    expect(injected).toHaveLength(1)
    expect(injected[0]).toContain('name="tiny"')
    expect(injected[0]).not.toContain('name="huge"')
  })

  it('fails loud when maxTotalBytes is invalid', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await expect(ctx.plugin(SkillAlwaysApply, { maxTotalBytes: 0 })).rejects.toThrow(/maxTotalBytes/)
  })

  it('stops injecting after the plugin fiber is disposed', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillAlwaysApply)
    registerAlwaysApply(ctx, {
      name: 'always-on',
      description: 'Always-on fixture',
      alwaysApply: true,
      source: 'project-dsh',
      content: 'Follow always-on rules.',
    })
    const adapter = new MockAdapter([textResponse('ok')])
    ctx.llm.registerAdapter(['mock'], adapter)

    await fiber.dispose()
    const agent = ctx.agentLoop.create(SessionId('aa-dispose'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(alwaysApplyTexts(agent)).toEqual([])
  })

  it('injects Config.names skills that are not model-invocable', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillAlwaysApply, { names: ['forced-hidden'] })
    registerAlwaysApply(ctx, {
      name: 'forced-hidden',
      description: 'Forced standing, catalog-hidden',
      invocation: { modelInvocable: false, userInvocable: true },
      source: 'project-dsh',
      content: 'Forced hidden body.',
    })
    const adapter = new MockAdapter([textResponse('ok')])
    ctx.llm.registerAdapter(['mock'], adapter)

    const agent = ctx.agentLoop.create(SessionId('aa-names-hidden'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(alwaysApplyTexts(agent)[0]).toContain('Forced hidden body.')
  })

  it('injects for subagent-origin sessions when skipSubagent is false', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillAlwaysApply, { skipSubagent: false })
    registerAlwaysApply(ctx, {
      name: 'always-on',
      description: 'Always-on fixture',
      alwaysApply: true,
      source: 'project-dsh',
      content: 'Follow always-on rules.',
    })
    const adapter = new MockAdapter([textResponse('ok')])
    ctx.llm.registerAdapter(['mock'], adapter)

    const handle = await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId('aa-sub-on'),
      meta: { origin: 'subagent' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(handle.agent.session.header.origin).toBe('subagent')
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, handle.agent)
    expect(alwaysApplyTexts(handle.agent)[0]).toContain('Follow always-on rules.')
  })

  it('re-injects after the always-apply message leaves the model-visible surface', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillAlwaysApply)
    registerAlwaysApply(ctx, {
      name: 'always-on',
      description: 'Always-on fixture',
      alwaysApply: true,
      source: 'project-dsh',
      content: 'Follow always-on rules.',
    })
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    ctx.llm.registerAdapter(['mock'], adapter)

    const agent = ctx.agentLoop.create(SessionId('aa-reinject'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(alwaysApplyTexts(agent)).toHaveLength(1)
    expect(sessionHasAlwaysApply(agent)).toBe(true)

    const alwaysSeq = [...agent.session.events].find(
      (e): e is SessionEvent<'user/message'> =>
        e.type === 'user/message' && e.data.source.kind === 'skill-always-apply',
    )?.seq
    expect(alwaysSeq).toEqual(expect.any(Number))
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '[compacted prior always-apply]' }],
      source: { kind: 'plugin', plugin: 'test-compact' },
    }), {
      surfaceOp: { op: 'replace', start: alwaysSeq!, end: alwaysSeq! },
      sourceEventSeqs: [alwaysSeq!],
    })
    expect(sessionHasAlwaysApply(agent)).toBe(false)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(alwaysApplyTexts(agent)).toHaveLength(2)
    expect(sessionHasAlwaysApply(agent)).toBe(true)
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('Follow always-on rules.')
  })
})
