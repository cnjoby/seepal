import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CodexAdapter,
  type CodexRpcTransport
} from '../../src/main/codex-adapter.js'
import type { CodexActivitySource } from '../../src/main/codex-activity-source.js'
import type { ProjectScope, SessionRecord } from '../../src/shared/domain.js'

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

function sessionRecord(id = 'session-ai'): SessionRecord {
  return {
    id: `project-1:codex:${id}`,
    projectId: 'project-1',
    provider: 'codex',
    providerSessionId: id,
    title: 'AI scan session',
    cwd: '/tmp/project',
    createdAt: '2025-07-30T00:00:00.000Z',
    updatedAt: '2025-07-30T10:00:00.000Z',
    lastActivityAt: '2025-07-30T10:00:00.000Z',
    activityStatus: 'ended',
    suggestedType: 'unknown',
    suggestedTypeConfidence: 0,
    suggestedTypeBasis: [],
    primaryType: 'unknown',
    contentStrategy: 'minimal',
    sourceVersion: '0.1.0',
    isPartial: false,
    collectedAt: '2025-07-30T10:00:00.000Z'
  }
}

const noLocalActivity: CodexActivitySource = {
  observe: () => new Map()
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
    const adapter = new CodexAdapter(transport, {
      resolvePath: async (path) => path,
      activitySource: noLocalActivity
    })

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
    const adapter = new CodexAdapter(transport, {
      resolvePath: async (path) => path,
      activitySource: noLocalActivity
    })

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
    const adapter = new CodexAdapter(transport, {
      resolvePath: async (path) => path,
      activitySource: noLocalActivity
    })

    const result = await adapter.sync('project-1', scope, 'full-local')

    expect(result.sessions).toHaveLength(2)
    expect(result.sessions.find((item) => item.providerSessionId === 'partial')?.isPartial).toBe(
      true
    )
    expect(result.failures).toEqual([
      expect.objectContaining({ stage: 'read', providerSessionId: 'partial' })
    ])
  })

  it('uses local activity evidence when App Server reports notLoaded', async () => {
    const transport = new FakeTransport({
      initialize: { userAgent: 'codex/0.139.0' },
      'thread/list': {
        data: [
          {
            ...thread('active', '/tmp/project'),
            status: { type: 'notLoaded' }
          }
        ],
        nextCursor: null
      }
    })
    const activitySource: CodexActivitySource = {
      observe: () =>
        new Map([
          [
            'active',
            {
              status: 'running',
              observedAt: '2026-07-30T13:00:00.000Z',
              confidence: 'confirmed',
              summary: 'Codex 本机活动日志显示最新 Turn 仍在执行。'
            }
          ]
        ])
    }
    const adapter = new CodexAdapter(transport, {
      resolvePath: async (path) => path,
      activitySource
    })

    const result = await adapter.sync('project-1', scope, 'minimal')

    expect(result.sessions[0]).toMatchObject({
      activityStatus: 'running',
      lastActivityAt: '2026-07-30T13:00:00.000Z'
    })
    expect(result.evidence[0]).toMatchObject({
      status: 'running',
      source: 'codex-local-activity-log',
      confidence: 'confirmed'
    })
  })

  it('aborts a local full-thread read instead of waiting for a stuck response', async () => {
    const transport: CodexRpcTransport = {
      request: async <T>(method: string, _params?: unknown, signal?: AbortSignal) => {
        if (method === 'initialize') return { userAgent: 'codex/0.139.0' } as T
        return new Promise<T>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          )
        })
      },
      notify: () => {},
      close: async () => {}
    }
    const adapter = new CodexAdapter(transport, {
      resolvePath: async (path) => path,
      activitySource: noLocalActivity
    })
    const item = {
      ...sessionRecord('blocked'),
      title: 'Blocked read',
      sourceVersion: 'codex/0.139.0'
    }
    const controller = new AbortController()
    const reading = adapter.readSessionForAi(item, scope, controller.signal)
    controller.abort()

    await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('extracts only the last six effective messages with one local thread request', async () => {
    const turns = Array.from({ length: 8 }, (_value, index) => ({
      items: [{
        type: index % 2 === 0 ? 'userMessage' : 'agentMessage',
        phase: index % 2 === 0 ? undefined : 'final_answer',
        content:
          index % 2 === 0
            ? [{ type: 'text', text: `turn ${index + 1}` }]
            : undefined,
        text: index % 2 === 1 ? `turn ${index + 1}` : undefined
      }]
    }))
    const transport = new FakeTransport({
      initialize: { userAgent: 'codex/0.139.0' },
      'thread/read': {
        thread: { ...thread('session-ai', '/tmp/project'), turns }
      }
    })
    const adapter = new CodexAdapter(transport, {
      resolvePath: async (path) => path,
      activitySource: noLocalActivity
    })

    const result = await adapter.readSessionForAi(sessionRecord(), scope)

    expect(result.messages.map((message) => message.text)).toEqual([
      'turn 3',
      'turn 4',
      'turn 5',
      'turn 6',
      'turn 7',
      'turn 8'
    ])
    expect(
      transport.calls.filter((call) => call.method === 'thread/read')
    ).toHaveLength(1)
    expect(
      transport.calls.find((call) => call.method === 'thread/read')?.params
    ).toEqual({ threadId: 'session-ai', includeTurns: true })
  })

  it('falls back to the last six JSONL messages when App Server cannot parse a thread', async () => {
    const sessionsRoot = await mkdtemp(join(tmpdir(), 'seepal-codex-sessions-'))
    try {
      const directory = join(sessionsRoot, '2025', '07', '30')
      await mkdir(directory, { recursive: true })
      const filePath = join(
        directory,
        'rollout-2025-07-30T10-00-00-session-ai.jsonl'
      )
      const entries = [
        {
          type: 'session_meta',
          payload: { id: 'session-ai', cwd: '/tmp/project' }
        },
        ...Array.from({ length: 8 }, (_value, index) => ({
          type: 'response_item',
          payload: {
            type: 'message',
            role: index % 2 === 0 ? 'user' : 'assistant',
            phase: index % 2 === 0 ? undefined : 'final_answer',
            content: [{
              type: index % 2 === 0 ? 'input_text' : 'output_text',
              text: `jsonl ${index + 1}`
            }]
          }
        }))
      ]
      await writeFile(filePath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
      const transport = new FakeTransport({
        initialize: { userAgent: 'codex/0.139.0' },
        'thread/read': () => {
          throw new Error(`failed to read thread ${filePath}: incompatible fixture`)
        }
      })
      const adapter = new CodexAdapter(transport, {
        resolvePath: async (path) => path,
        activitySource: noLocalActivity,
        codexSessionsRoot: sessionsRoot
      })

      const result = await adapter.readSessionForAi(sessionRecord(), scope)

      expect(result.messages.map((message) => message.text)).toEqual([
        'jsonl 3',
        'jsonl 4',
        'jsonl 5',
        'jsonl 6',
        'jsonl 7',
        'jsonl 8'
      ])
      expect(result.truncated).toBe(true)
    } finally {
      await rm(sessionsRoot, { recursive: true, force: true })
    }
  })
})
