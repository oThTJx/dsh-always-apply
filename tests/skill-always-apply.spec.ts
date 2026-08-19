import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import * as SkillAlwaysApply from '@firefly0621/dsh-skill-always-apply'
import { renderAlwaysApplyText } from '@firefly0621/dsh-skill-always-apply'
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

/** The rendered system prompt of one recorded request. */
function systemText(request: GenerateOptions): string {
  return request.system ?? ''
}

/** Every durable user message's text, for asserting the rules never became history. */
function userMessageTexts(agent: Agent): string[] {
  return [...agent.session.events]
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message')
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
    expect(pkg.version).toBe('0.1.0-rc.10')
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

describe('renderAlwaysApplyText', () => {
  it('frames skill names and canonical skill_content bodies', () => {
    const text = renderAlwaysApplyText([{
      name: 'demo-skill',
      description: 'Demo',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'project-dsh',
      provider: 'runtime',
      content: 'Always do the thing.',
    }])
    expect(text).toContain('<always_apply_skills>')
    expect(text).toContain('- demo-skill')
    expect(text).toContain('<skill_content name="demo-skill">')
    expect(text).toContain('Always do the thing.')
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
        | ((assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>) => Promise<PromptAssembly>)
        | undefined
      const originalOn = ctx.on.bind(ctx)
      ;(ctx as unknown as { on: typeof ctx.on }).on = ((event: string, callback: (...args: never[]) => unknown) => {
        if (event === 'system-prompt/assemble') listener = callback as typeof listener
        return originalOn(event as never, callback as never)
      }) as typeof ctx.on

      await ctx.plugin(SkillAlwaysApply)
      expect(listener).toBeDefined()

      const base: PromptAssembly = { sections: [], contexts: [], tools: [], variables: {} }
      const agent = {
        session: { header: { origin: 'user', cwd: temp } },
      } as unknown as Agent
      const result = await listener!(base, { agent, signal: new AbortController().signal }, async () => ({ ...base }))
      const text = result.sections.map(section => section.text).join('')
      expect(text).toContain('Frontmatter body.')
      expect(text).toContain('Extra body.')
      expect(text).not.toContain('Ordinary body.')
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('injects alwaysApply skills into the system prompt, not the history', async () => {
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

    const system = systemText(adapter.requests[0]!)
    expect(system).toContain('Follow always-on rules.')
    expect(system).not.toContain('Load me on demand.')
    expect((system.match(/<always_apply_skills>/g) ?? []).length).toBe(1)
    expect(userMessageTexts(agent).join('\n')).not.toContain('Follow always-on rules.')
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

    const system = systemText(adapter.requests[0]!)
    expect(system).toContain('Forced body.')
    expect(system).not.toContain('Should stay out.')
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
    expect(systemText(adapter.requests[0]!)).not.toContain('Follow always-on rules.')
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
    expect(systemText(adapter.requests[0]!)).toContain('Follow always-on rules.')
  })

  it('keeps exactly one section per request across steps', async () => {
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

    for (const request of adapter.requests) {
      expect((systemText(request).match(/<always_apply_skills>/g) ?? []).length).toBe(1)
      expect(systemText(request)).toContain('Follow always-on rules.')
    }
  })

  it('refreshes the section after skills/change', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillAlwaysApply)
    registerAlwaysApply(ctx, {
      name: 'alpha',
      description: 'Alpha fixture',
      alwaysApply: true,
      source: 'project-dsh',
      content: 'Alpha body.',
    })
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    ctx.llm.registerAdapter(['mock'], adapter)

    const agent = ctx.agentLoop.create(SessionId('aa-refresh'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(systemText(adapter.requests[0]!)).toContain('Alpha body.')
    expect(systemText(adapter.requests[0]!)).not.toContain('Beta body.')

    registerAlwaysApply(ctx, {
      name: 'beta',
      description: 'Beta fixture',
      alwaysApply: true,
      source: 'project-dsh',
      content: 'Beta body.',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(systemText(adapter.requests[1]!)).toContain('Alpha body.')
    expect(systemText(adapter.requests[1]!)).toContain('Beta body.')
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

    const system = systemText(adapter.requests[0]!)
    expect(system).toContain('name="tiny"')
    expect(system).not.toContain('name="huge"')
  })

  it('skips skills whose body carries prompt-variable syntax', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillAlwaysApply)
    registerAlwaysApply(ctx, {
      name: 'braced',
      description: 'Braced',
      alwaysApply: true,
      source: 'project-dsh',
      content: 'Use {{variable}} here.',
    })
    const adapter = new MockAdapter([textResponse('ok')])
    ctx.llm.registerAdapter(['mock'], adapter)

    const agent = ctx.agentLoop.create(SessionId('aa-braced'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(systemText(adapter.requests[0]!)).not.toContain('braced')
    expect(systemText(adapter.requests[0]!)).not.toContain('{{variable}}')
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
    expect(systemText(adapter.requests[0]!)).not.toContain('Follow always-on rules.')
    expect(userMessageTexts(agent).join('\n')).not.toContain('Follow always-on rules.')
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
    expect(systemText(adapter.requests[0]!)).toContain('Forced hidden body.')
  })
})
