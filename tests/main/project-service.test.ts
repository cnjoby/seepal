import { describe, expect, it } from 'vitest'

import type { CodexAdapter } from '../../src/main/codex-adapter.js'
import { SeePalDatabase } from '../../src/main/database.js'
import type { GitAdapter } from '../../src/main/git-adapter.js'
import { ProjectService } from '../../src/main/project-service.js'
import type {
  CodexSyncResult,
  Project,
  ProjectScope,
  SessionRecord
} from '../../src/shared/domain.js'

const now = new Date('2026-07-30T10:00:00.000Z')

function scope(path: string): ProjectScope {
  return {
    rootPath: path,
    canonicalRootPath: path,
    isGitRepository: true,
    gitDirectory: `${path}/.git`,
    worktrees: [path],
    submodules: [],
    symbolicLinks: [],
    includedPaths: [path],
    excludedPaths: [],
    warnings: []
  }
}

function session(projectId: string, cwd: string): SessionRecord {
  return {
    id: `${projectId}:codex:thread-1`,
    projectId,
    provider: 'codex',
    providerSessionId: 'thread-1',
    title: '修复登录问题',
    cwd,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastActivityAt: now.toISOString(),
    activityStatus: 'ended',
    suggestedType: 'bugfix',
    suggestedTypeConfidence: 0.8,
    suggestedTypeBasis: ['目标包含 BUG 修复'],
    primaryType: 'bugfix',
    contentStrategy: 'minimal',
    isPartial: false,
    collectedAt: now.toISOString()
  }
}

function syncResult(project: Project, failures: CodexSyncResult['failures'] = []): CodexSyncResult {
  return {
    matchedCount: 1,
    sessions: [session(project.id, project.canonicalRootPath)],
    evidence: [],
    coverage: {
      sessionCount: 1,
      isComplete: failures.length === 0
    },
    compatibility: {
      status: failures.length === 0 ? 'supported' : 'degraded'
    },
    failures
  }
}

function fixtures(sync: (projectId: string) => CodexSyncResult) {
  let inspections = 0
  const git = {
    async inspectProject(path: string) {
      inspections += 1
      return scope(path)
    },
    async collectSessionEvidence() {
      return {
        value: [],
        before: { canonicalRootPath: '/tmp' },
        after: { canonicalRootPath: '/tmp' },
        unchanged: true as const
      }
    }
  } as unknown as GitAdapter
  const codex = {
    async discover() {
      return {
        matchedCount: 1,
        compatibility: { status: 'supported' as const },
        failures: []
      }
    },
    async sync(projectId: string) {
      return sync(projectId)
    }
  } as unknown as CodexAdapter
  return { git, codex, inspections: () => inspections }
}

describe('ProjectService', () => {
  it('does not inspect or persist a cancelled project and rejects a duplicate canonical path', async () => {
    const database = new SeePalDatabase(':memory:')
    const adapterFixtures = fixtures((projectId) =>
      syncResult(database.getProject(projectId)!)
    )
    const service = new ProjectService(database, adapterFixtures.git, adapterFixtures.codex, {
      now: () => now
    })

    await expect(
      service.createProject({ rootPath: '/tmp/one', confirmed: false })
    ).rejects.toThrow('确认读取范围')
    expect(adapterFixtures.inspections()).toBe(0)
    expect(service.listProjects()).toEqual([])

    await service.createProject({ rootPath: '/tmp/one', confirmed: true })
    await expect(
      service.createProject({ rootPath: '/tmp/one', confirmed: true })
    ).rejects.toThrow('已经添加')
    expect(service.listProjects()).toHaveLength(1)
    database.close()
  })

  it('keeps prior sessions across a later partial sync and upserts repeated provider ids', async () => {
    const database = new SeePalDatabase(':memory:')
    let project!: Project
    let run = 0
    const adapterFixtures = fixtures((projectId) => {
      run += 1
      const currentProject = database.getProject(projectId)!
      if (run <= 2) return syncResult(currentProject)
      return {
        matchedCount: 0,
        sessions: [],
        evidence: [],
        compatibility: { status: 'degraded' },
        failures: [{ stage: 'list', message: 'interrupted' }]
      }
    })
    const service = new ProjectService(database, adapterFixtures.git, adapterFixtures.codex, {
      now: () => now
    })
    project = await service.createProject({ rootPath: '/tmp/one', confirmed: true })

    await service.syncCodex(project.id, { contentStrategy: 'minimal' })
    await service.syncCodex(project.id, { contentStrategy: 'minimal' })
    await service.syncCodex(project.id, { contentStrategy: 'minimal' })

    expect(service.getConsole(project.id).sessions).toHaveLength(1)
    expect(service.getProject(project.id).syncStatus).toBe('failed')
    expect(service.getProject(project.id).lastSuccessfulSyncAt).toBe(now.toISOString())
    database.close()
  })

  it('isolates projects and deletes only the selected SeePal copy', async () => {
    const database = new SeePalDatabase(':memory:')
    const adapterFixtures = fixtures((projectId) =>
      syncResult(database.getProject(projectId)!)
    )
    const service = new ProjectService(database, adapterFixtures.git, adapterFixtures.codex, {
      now: () => now
    })
    const one = await service.createProject({ rootPath: '/tmp/one', confirmed: true })
    const two = await service.createProject({ rootPath: '/tmp/two', confirmed: true })
    await service.syncCodex(one.id, { contentStrategy: 'minimal' })
    await service.syncCodex(two.id, { contentStrategy: 'minimal' })

    await service.deleteProject(one.id)

    expect(() => service.getProject(one.id)).toThrow('项目不存在')
    expect(service.getConsole(two.id).sessions).toHaveLength(1)
    database.close()
  })

  it('records an unexpected sync failure instead of leaving the project syncing', async () => {
    const database = new SeePalDatabase(':memory:')
    const adapterFixtures = fixtures(() => {
      throw new Error('adapter crashed')
    })
    const service = new ProjectService(database, adapterFixtures.git, adapterFixtures.codex, {
      now: () => now
    })
    const project = await service.createProject({ rootPath: '/tmp/one', confirmed: true })

    await expect(
      service.syncCodex(project.id, { contentStrategy: 'minimal' })
    ).rejects.toThrow('adapter crashed')

    expect(service.getProject(project.id)).toMatchObject({
      syncStatus: 'failed',
      syncMessage: expect.stringContaining('adapter crashed')
    })
    database.close()
  })
})
