import { describe, expect, it } from 'vitest'

import { aiSessionContentHash, redactAiText } from '../../src/main/codex-adapter.js'
import { SeePalDatabase } from '../../src/main/database.js'
import {
  parseAiInterpretation,
  ProjectAiScanService
} from '../../src/main/project-ai-scan-service.js'
import type {
  AiMessage,
  AiSessionInput,
  Evidence,
  Project,
  SessionRecord
} from '../../src/shared/domain.js'

const timestamp = '2026-07-30T10:00:00.000Z'

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'SeePal',
    rootPath: '/tmp/project',
    canonicalRootPath: '/tmp/project',
    contentStrategy: 'minimal',
    createdAt: timestamp,
    updatedAt: timestamp,
    lastSuccessfulSyncAt: timestamp,
    syncStatus: 'complete',
    coverage: { sessionCount: 1, isComplete: true },
    ...overrides
  }
}

function session(index: number): SessionRecord {
  return {
    id: `project-1:codex:session-${index}`,
    projectId: 'project-1',
    provider: 'codex',
    providerSessionId: `session-${index}`,
    title: `Session ${index}`,
    cwd: '/tmp/project',
    createdAt: timestamp,
    updatedAt: timestamp,
    lastActivityAt: timestamp,
    activityStatus: 'ended',
    suggestedType: 'unknown',
    suggestedTypeConfidence: 0,
    suggestedTypeBasis: [],
    primaryType: 'unknown',
    contentStrategy: 'minimal',
    sourceVersion: 'codex/0.139.0',
    isPartial: false,
    collectedAt: timestamp
  }
}

function inputFor(item: SessionRecord, suffix = ''): AiSessionInput {
  const messages: AiMessage[] = [{
    ref: 'message-1',
    role: 'user',
    text: `Goal for ${item.providerSessionId}${suffix}`
  }]
  return {
    sessionId: item.id,
    sessionFingerprint: `session-${item.providerSessionId}`,
    evidenceFingerprint: '',
    contentHash: aiSessionContentHash(messages),
    truncated: false,
    messages
  }
}

function fixture(count = 1, partial = false) {
  const database = new SeePalDatabase(':memory:')
  database.createProject(project(partial ? {
    syncStatus: 'partial',
    coverage: { sessionCount: count, isComplete: false }
  } : {
    coverage: { sessionCount: count, isComplete: true }
  }))
  const sessions = Array.from({ length: count }, (_, index) => session(index))
  sessions.forEach((item) => database.upsertSession(item))
  const config = {
    protocol: 'openai' as const,
    baseUrl: 'https://model.invalid',
    model: 'fake-model',
    apiKey: 'test-only'
  }
  let concurrent = 0
  let maxConcurrent = 0
  let requests = 0
  let localReads = 0
  let transcriptSuffix = ''
  const codex = {
    readSessionForAi: async (item: SessionRecord, _scope: unknown, signal?: AbortSignal) => {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      localReads += 1
      return inputFor(item, transcriptSuffix)
    }
  }
  const provider = {
    snapshotConfig: async () => ({ ...config }),
    generateTextWithConfig: async (
      _prompt: string,
      _config: unknown,
      signal?: AbortSignal
    ) => {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      requests += 1
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await Promise.resolve()
      concurrent -= 1
      return {
        model: config.model,
        text: JSON.stringify({
          assessment: 'possibly-complete',
          nextActor: 'none',
          goal: 'finish the requested work',
          outcome: 'work appears complete',
          gaps: [],
          evidenceRefs: ['message-1']
        })
      }
    }
  }
  const service = new ProjectAiScanService(
    database,
    {
      inspectProject: async () => ({
        rootPath: '/tmp/project',
        canonicalRootPath: '/tmp/project',
        isGitRepository: true,
        worktrees: ['/tmp/project'],
        submodules: [],
        symbolicLinks: [],
        includedPaths: ['/tmp/project'],
        excludedPaths: [],
        warnings: []
      })
    } as never,
    codex as never,
    {
      getPublicConfig: async () => ({
        protocol: config.protocol,
        baseUrl: config.baseUrl,
        model: config.model,
        hasApiKey: true
      })
    } as never,
    provider as never,
    () => new Date(timestamp)
  )
  return {
    database,
    sessions,
    service,
    codex,
    provider,
    metrics: () => ({ requests, maxConcurrent, localReads }),
    setTranscriptSuffix: (value: string) => {
      transcriptSuffix = value
    }
  }
}

async function waitUntilTerminal(
  service: ProjectAiScanService,
  projectId = 'project-1'
) {
  for (let index = 0; index < 2_000; index += 1) {
    const status = service.status(projectId)
    if (status.status !== 'running') return status
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('scan did not finish')
}

async function start(service: ProjectAiScanService) {
  const preparation = await service.prepare('project-1')
  await service.start({
    preparationId: preparation.id,
    localReadConfirmed: true,
    remoteSendConfirmed: true
  })
  return waitUntilTerminal(service)
}

describe('ProjectAiScanService', () => {
  it('scans an arbitrary project session set serially and reuses exact frozen fingerprints', async () => {
    const sessionCount = 25
    const first = fixture(sessionCount)
    const status = await start(first.service)

    expect(status).toMatchObject({
      status: 'completed',
      total: sessionCount,
      succeeded: sessionCount,
      reused: 0
    })
    expect(first.metrics()).toEqual({
      requests: sessionCount,
      maxConcurrent: 1,
      localReads: sessionCount
    })

    const preparation = await first.service.prepare('project-1')
    expect(preparation).toMatchObject({
      projectName: 'SeePal',
      cachedCount: sessionCount,
      requestCount: sessionCount
    })
    await first.service.start({
      preparationId: preparation.id,
      localReadConfirmed: true,
      remoteSendConfirmed: true
    })
    const reused = await waitUntilTerminal(first.service)
    expect(reused).toMatchObject({ status: 'completed', reused: sessionCount })
    expect(first.metrics()).toEqual({
      requests: sessionCount,
      maxConcurrent: 1,
      localReads: sessionCount * 2
    })
    expect(first.database.getProject('project-1')?.contentStrategy).toBe('minimal')
    first.database.close()
  })

  it('rejects concurrent prepares for the same project', async () => {
    const value = fixture()
    const p1 = value.service.prepare('project-1')
    const p2 = value.service.prepare('project-1')
    const [first, second] = await Promise.allSettled([p1, p2])
    const rejections = [first, second].filter(
      (item): item is PromiseRejectedResult => item.status === 'rejected',
    )
    expect(rejections).toHaveLength(1)
    expect(rejections[0]!.reason).toMatchObject({
      message: '这个项目已有 AI 扫描正在运行。',
    })
    value.database.close()
  })

  it('does not reuse a candidate when sanitized transcript content changed without metadata changes', async () => {
    const value = fixture()
    await start(value.service)
    expect(value.metrics().requests).toBe(1)

    value.setTranscriptSuffix(' changed')
    const preparation = await value.service.prepare('project-1')
    expect(preparation.cachedCount).toBe(1)
    await value.service.start({
      preparationId: preparation.id,
      localReadConfirmed: true,
      remoteSendConfirmed: true
    })
    const status = await waitUntilTerminal(value.service)

    expect(status).toMatchObject({ status: 'completed', succeeded: 1, reused: 0 })
    expect(value.metrics()).toMatchObject({ requests: 2, localReads: 2 })
    value.database.close()
  })

  it('never reports completed when the underlying sync coverage is partial', async () => {
    const value = fixture(2, true)
    const status = await start(value.service)
    expect(status.status).toBe('partial')
    expect(status.succeeded).toBe(2)
    value.database.close()
  })

  it('marks the item stale and does not cache output when Evidence changes in flight', async () => {
    const value = fixture()
    value.provider.generateTextWithConfig = async () => {
      const evidence: Evidence = {
        id: 'late-evidence',
        projectId: 'project-1',
        sessionId: value.sessions[0]!.id,
        axis: 'review',
        status: 'pending',
        summary: 'Evidence changed during request.',
        source: 'test',
        collectedAt: timestamp,
        confidence: 'confirmed'
      }
      value.database.insertEvidence(evidence)
      return {
        model: 'fake-model',
        text: JSON.stringify({
          assessment: 'unknown',
          nextActor: 'unknown',
          goal: 'goal',
          outcome: 'outcome',
          gaps: [],
          evidenceRefs: []
        })
      }
    }

    const status = await start(value.service)
    expect(status).toMatchObject({ status: 'partial', stale: 1, succeeded: 0 })
    expect(status.interpretations).toEqual({})
    expect(() => value.service.retryFailures('project-1')).toThrow('重新预检')
    value.database.close()
  })

  it('synchronously marks an in-flight request unknown on cancel and never retries it on resume', async () => {
    const value = fixture(2)
    value.provider.generateTextWithConfig = (
      _prompt: string,
      _config: unknown,
      signal?: AbortSignal
    ) => new Promise((_resolve, reject) => {
      signal?.addEventListener(
        'abort',
        () => reject(new DOMException('aborted', 'AbortError')),
        { once: true }
      )
    })

    const preparation = await value.service.prepare('project-1')
    await value.service.start({
      preparationId: preparation.id,
      localReadConfirmed: true,
      remoteSendConfirmed: true
    })
    await Promise.resolve()
    const canceled = value.service.cancel('project-1')
    expect(canceled).toMatchObject({
      status: 'canceled',
      unknown: 1,
      pending: 1
    })
    expect(canceled.items.map((item) => item.status)).toEqual(['unknown', 'pending'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    value.database.close()
  })

  it('recovers interrupted processing as unknown without a detached interpretation', () => {
    const value = fixture()
    const runId = 'run-crash'
    value.database.createAiScanRun({
      id: runId,
      projectId: 'project-1',
      status: 'running',
      providerFingerprint: 'provider',
      total: 1,
      succeeded: 0,
      reused: 0,
      failed: 0,
      stale: 0,
      unknown: 0,
      pending: 1,
      startedAt: timestamp,
      updatedAt: timestamp
    }, [{
      id: 'item-crash',
      runId,
      projectId: 'project-1',
      sessionId: value.sessions[0]!.id,
      sourceFingerprint: 'source',
      fingerprint: 'fingerprint',
      status: 'processing',
      attemptCount: 1,
      updatedAt: timestamp
    }])

    expect(value.database.markInterruptedAiScansUnknown(timestamp)).toBe(1)
    expect(value.database.getAiScanRun(runId)).toMatchObject({
      status: 'canceled',
      unknown: 1
    })
    expect(value.database.listAiInterpretationsForRun(runId)).toEqual([])
    value.database.close()
  })

  it('prevents concurrent starts for the same project', async () => {
    const value = fixture()
    const firstPrep = await value.service.prepare('project-1')
    const secondPrep = await value.service.prepare('project-1')
    const first = value.service.start({
      preparationId: firstPrep.id,
      localReadConfirmed: true,
      remoteSendConfirmed: true
    })
    const second = value.service.start({
      preparationId: secondPrep.id,
      localReadConfirmed: true,
      remoteSendConfirmed: true
    })
    const [startedFirst, startedSecond] = await Promise.allSettled([first, second])
    const fulfilled = [startedFirst, startedSecond].filter(
      (item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof value.service.start>>> => item.status === 'fulfilled'
    )
    const rejected = [startedFirst, startedSecond].filter(
      (item): item is PromiseRejectedResult => item.status === 'rejected'
    )
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toMatchObject({
      message: '这个项目已有 AI 扫描正在运行。'
    })
    await value.service.cancel('project-1')
    value.database.close()
  })
})

describe('AI scan validation and redaction', () => {
  it('removes fenced code, unified diff, tool-like output, credentials and complete user paths', () => {
    const sanitized = redactAiText([
      'keep this goal',
      '```ts',
      'const secret = "source"',
      '```',
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '+const added = true',
      'Tool output: raw terminal response',
      'api_key="top secret value"',
      'Authorization: Bearer abc.def.ghi',
      'path=/Users/joby/private/project/file.ts'
    ].join('\n'))

    expect(sanitized).toContain('keep this goal')
    expect(sanitized).not.toContain('const secret')
    expect(sanitized).not.toContain('const added')
    expect(sanitized).not.toContain('raw terminal response')
    expect(sanitized).not.toContain('top secret value')
    expect(sanitized).not.toContain('/Users/joby')
    expect(sanitized).toContain('[REDACTED_PATH]')
  })

  it('requires a valid supplied reference for every non-unknown assessment', () => {
    const value = inputFor(session(0))
    expect(() =>
      parseAiInterpretation(JSON.stringify({
        assessment: 'possibly-complete',
        nextActor: 'none',
        goal: 'goal',
        outcome: 'outcome',
        gaps: [],
        evidenceRefs: []
      }), value, {
        projectId: 'project-1',
        fingerprint: 'fingerprint',
        createdAt: timestamp
      })
    ).toThrow('至少引用一条有效依据')
    expect(() =>
      parseAiInterpretation(JSON.stringify({
        assessment: 'blocked',
        nextActor: 'external',
        goal: 'goal',
        outcome: 'outcome',
        gaps: [],
        evidenceRefs: ['missing']
      }), value, {
        projectId: 'project-1',
        fingerprint: 'fingerprint',
        createdAt: timestamp
      })
    ).toThrow('不存在的依据')
  })

  it('requires the next actor to match the user-facing assessment', () => {
    const value = inputFor(session(0))
    expect(() =>
      parseAiInterpretation(JSON.stringify({
        assessment: 'needs-action',
        nextActor: 'external',
        goal: 'goal',
        outcome: 'outcome',
        gaps: ['waiting'],
        nextAction: 'wait',
        evidenceRefs: ['status']
      }), value, {
        projectId: 'project-1',
        fingerprint: 'fingerprint',
        createdAt: timestamp
      })
    ).toThrow('状态与下一步执行者不一致')
  })
})
