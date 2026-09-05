import { describe, expect, it } from 'vitest'
import {
  classifyApplyType,
  normalizeGlobs,
  parseMdcDocument,
  serializeMdcDocument,
} from '../src/parse.ts'

describe('classifyApplyType', () => {
  it('always wins over globs', () => {
    expect(classifyApplyType({ alwaysApply: true, description: 'x', globs: ['**/*.ts'] })).toBe('always')
  })

  it('specific when globs non-empty and not always', () => {
    expect(classifyApplyType({ alwaysApply: false, globs: ['**/*.ts'] })).toBe('specific')
  })

  it('inactive when only description set (no globs)', () => {
    expect(classifyApplyType({ alwaysApply: false, description: 'RPC conventions' })).toBe('inactive')
  })

  it('inactive when nothing set', () => {
    expect(classifyApplyType({ alwaysApply: false })).toBe('inactive')
  })

  it('inactive when description is whitespace-only', () => {
    expect(classifyApplyType({ alwaysApply: false, description: '  \n' })).toBe('inactive')
  })
})

describe('normalizeGlobs', () => {
  it('splits comma-separated strings', () => {
    expect(normalizeGlobs('**/*.ts, src/**/*.tsx')).toEqual(['**/*.ts', 'src/**/*.tsx'])
  })

  it('accepts string arrays', () => {
    expect(normalizeGlobs(['a', ' b '])).toEqual(['a', 'b'])
  })

  it('drops empty entries', () => {
    expect(normalizeGlobs('a,, ,b')).toEqual(['a', 'b'])
  })
})

describe('parseMdcDocument', () => {
  it('parses frontmatter and body', () => {
    const doc = parseMdcDocument('---\ndescription: Hi\nalwaysApply: false\nglobs: "**/*.ts, src/**/*.tsx"\n---\n\nBody line\n')
    expect(doc.applyType).toBe('specific')
    expect(doc.description).toBe('Hi')
    expect(doc.globs).toEqual(['**/*.ts', 'src/**/*.tsx'])
    expect(doc.alwaysApply).toBe(false)
    expect(doc.body).toBe('\nBody line\n')
  })

  it('parses YAML list globs', () => {
    const doc = parseMdcDocument('---\nalwaysApply: false\nglobs:\n  - "**/*.ts"\n  - "src/**/*.tsx"\n---\nbody\n')
    expect(doc.applyType).toBe('specific')
    expect(doc.globs).toEqual(['**/*.ts', 'src/**/*.tsx'])
  })

  it('rejects prompt-variable syntax in body', () => {
    expect(() => parseMdcDocument('---\nalwaysApply: true\n---\n{{foo}}')).toThrow(/prompt-variable/)
  })

  it('rejects missing frontmatter fence', () => {
    expect(() => parseMdcDocument('no frontmatter\n')).toThrow(/frontmatter/)
  })

  it('classifies as inactive when no globs even with description', () => {
    const doc = parseMdcDocument('---\ndescription: My Rule\nalwaysApply: false\n---\nBody content\n')
    expect(doc.applyType).toBe('inactive')
    expect(doc.alwaysApply).toBe(false)
    expect(doc.description).toBe('My Rule')
  })

  it('classifies as always when alwaysApply is true', () => {
    const doc = parseMdcDocument('---\nalwaysApply: true\n---\nBody\n')
    expect(doc.applyType).toBe('always')
    expect(doc.alwaysApply).toBe(true)
  })
})

describe('serializeMdcDocument', () => {
  it('writes always without globs', () => {
    const text = serializeMdcDocument({
      applyType: 'always',
      description: 'repo',
      globs: ['**/*.ts'],
      body: 'Keep it short.\n',
    })
    expect(text).toContain('alwaysApply: true')
    expect(text).toContain('description: repo')
    expect(text).not.toMatch(/^globs:/m)
    expect(text).toContain('Keep it short.')
  })

  it('writes specific with globs and alwaysApply false', () => {
    const text = serializeMdcDocument({
      applyType: 'specific',
      description: '',
      globs: ['**/*.ts', 'src/**/*.tsx'],
      body: 'Scoped.\n',
    })
    expect(text).toContain('alwaysApply: false')
    expect(text).toMatch(/globs:/)
    expect(text).not.toMatch(/^description:/m)
  })

  it('writes specific with description when provided', () => {
    const text = serializeMdcDocument({
      applyType: 'specific',
      description: 'Frontmatter desc',
      globs: ['**/*.ts'],
      body: 'Body.\n',
    })
    expect(text).toContain('alwaysApply: false')
    expect(text).toContain('description: Frontmatter desc')
    expect(text).toMatch(/globs:/)
  })

  it('round-trips empty body', () => {
    const doc = { applyType: 'always' as const, description: '', globs: [], body: '' }
    const text = serializeMdcDocument(doc)
    const parsed = parseMdcDocument(text)
    expect(parsed.body.trim()).toBe('')
    expect(parsed.applyType).toBe('always')
  })

  it('round-trips body starting with newline', () => {
    const doc = { applyType: 'always' as const, description: '', globs: [], body: '\nContent.\n' }
    const text = serializeMdcDocument(doc)
    const parsed = parseMdcDocument(text)
    expect(parsed.body).toBe('\nContent.\n')
  })

  it('round-trips body without trailing newline', () => {
    const doc = { applyType: 'always' as const, description: '', globs: [], body: 'No newline' }
    const text = serializeMdcDocument(doc)
    const parsed = parseMdcDocument(text)
    expect(parsed.body).toContain('No newline')
  })
})
