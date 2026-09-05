import { describe, expect, it } from 'vitest'
import {
  collectInContextPathsFromParts,
  filePathFromToolCall,
  pathTokensFromText,
  ruleMatchesContext,
  toWorkspaceRelative,
} from '../src/paths.ts'

describe('pathTokensFromText', () => {
  it('extracts workspace-relative path tokens from user text', () => {
    expect(pathTokensFromText('see packages/foo/bar.ts and @baz/qux.ts')).toEqual([
      'packages/foo/bar.ts',
      'baz/qux.ts',
    ])
  })
})

describe('filePathFromToolCall', () => {
  it('reads file_path from read/write/edit arguments', () => {
    expect(filePathFromToolCall('read', JSON.stringify({ file_path: 'src/a.ts' }))).toBe('src/a.ts')
    expect(filePathFromToolCall('bash', JSON.stringify({ file_path: 'src/a.ts' }))).toBeUndefined()
    expect(filePathFromToolCall('read', '{')).toBeUndefined()
  })
})

describe('collectInContextPathsFromParts', () => {
  it('unions tool paths and user text tokens', () => {
    expect(collectInContextPathsFromParts({
      toolCalls: [
        { name: 'read', arguments: JSON.stringify({ file_path: 'src/a.ts' }) },
        { name: 'write', arguments: JSON.stringify({ file_path: 'src/b.ts' }) },
      ],
      userTexts: ['also packages/foo/bar.ts'],
    })).toEqual(['src/a.ts', 'src/b.ts', 'packages/foo/bar.ts'])
  })
})

describe('ruleMatchesContext', () => {
  it('matches globs with picomatch against relative paths', () => {
    expect(ruleMatchesContext(['**/*.ts'], ['src/a.ts'], '/ws')).toBe(true)
    expect(ruleMatchesContext(['**/*.ts'], ['src/a.md'], '/ws')).toBe(false)
  })

  it('relativizes absolute paths under the workspace root', () => {
    expect(ruleMatchesContext(['src/**'], ['/ws/src/a.ts'], '/ws')).toBe(true)
    expect(toWorkspaceRelative('/ws/src/a.ts', '/ws')).toBe('src/a.ts')
  })
})
