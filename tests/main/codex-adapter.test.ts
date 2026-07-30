import { describe, expect, it } from 'vitest'

import {
  CodexAdapter,
  type CodexRpcTransport
} from '../../src/main/codex-adapter.js'
import type { ProjectScope } from '../../src/shared/domain.js'

class FakeTransport implements CodexRpcTransport {
  readonly calls: Array<{ method: string; params: unknown }> = []

  constructor(
    private readonly responses: Record<string, unknown | (() => unknown | Promise<unknown>)>
  ) {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params })
    const response = this.responses[method]
    if (typeof response === 'function') return (await response()) as T
    return response as T
  }

  notify(): void {}
  async close(): Promise<void> {}
}

const scope: ProjectScope = {
  rootPath: '/tmp/project',
  canonicalRootPath: '/tmp/project',
  isGitRepository: true,
  worktrees: ['/tmp/project', '/tmp/project-worktree'],
  submodules: [],
  symbolicLinks: [],
  includedPaths: ['/tmp/project', '/tmp/project-worktree'],
  excludedPaths: [],
  warnings: []
}

function thread(id: string, cwd: string) {
  return {
    id,
    preview: `Thread ${id}`,
    cwd,
    createdAt: 1_753_862_400,
    updatedAt: 1_753_869_600,
    status: { type: 'idle' },
    cliVersion: '0.1.0',
    gitInfo: null,
    turns: []
  }
}

describe('CodexAdapter', () => {
  it('passes exact project/worktree cwd filters and rejects unrelated returned threads', async () => {
    const transport = new FakeTransport({
      initialize: { userAgent: 'codex-test' },
      'thread/list': {
        data: [thread('included', '/tmp/project'), thread('excluded', '/tmp/project-other')],
        nextCursor: null
      }
    })
    const adapter = new CodexAdapter(transport, { resolvePath: async (path) => path })

    const result = await adapter.discover('project-1', scope)

    expect(result.matchedCount).toBe(1)
    expect(
      transport.calls.find((call) => call.method === 'thread/list')?.params
    ).toMatchObject({
      cwd: ['/tmp/project', '/tmp/project-worktree'],
      useStateDbOnly: true
    })
  })

  it('returns bounded partial coverage for an incompatible list payload', async () => {
    const transport = new FakeTransport({
      initialize: { userAgent: 'codex/0.139.0' },
      'thread/list': { data: null, nextCursor: null }
    })
    const adapter = new CodexAdapter(transport, { resolvePath: async (path) => path })

    const result = await adapter.discover('project-1', scope)

    expect(result.matchedCount).toBe(0)
    expect(result.coverage?.isComplete).toBe(false)
    expect(result.failures[0]?.stage).toBe('list')
  })

  it('keeps metadata sessions when one full-content read fails', async () => {
    const transport = new FakeTransport({
      initialize: { userAgent: 'codex-test' },
      'thread/list': {
        data: [thread('ok', '/tmp/project'), thread('partial', '/tmp/project')],
        nextCursor: null
      },
      'thread/read': () => {
        const reads = transport.calls.filter((call) => call.method === 'thread/read')
        if (reads.length === 2) throw new Error('fixture read failed')
        return { thread: { ...thread('ok', '/tmp/project'), turns: [] } }
      }
    })
    const adapter = new CodexAdapter(transport, { resolvePath: async (path) => path })

    const result = await adapter.sync('project-1', scope, 'full-local')

    expect(result.sessions).toHaveLength(2)
    expect(result.sessions.find((item) => item.providerSessionId === 'partial')?.isPartial).toBe(
      true
    )
    expect(result.failures).toEqual([
      expect.objectContaining({ stage: 'read', providerSessionId: 'partial' })
    ])
  })
})
