import { describe, expect, it } from 'vitest'

import { SeePalDatabase } from '../../src/main/database.js'
import type { Project, SessionRecord } from '../../src/shared/domain.js'

const projectOne: Project = {
  id: 'project-1',
  name: 'One',
  rootPath: '/tmp/one',
  canonicalRootPath: '/tmp/one',
  contentStrategy: 'minimal',
  createdAt: '2026-07-30T10:00:00.000Z',
  updatedAt: '2026-07-30T10:00:00.000Z',
  syncStatus: 'never'
}

const projectTwo: Project = {
  ...projectOne,
  id: 'project-2',
  name: 'Two',
  rootPath: '/tmp/two',
  canonicalRootPath: '/tmp/two'
}

function session(projectId: string): SessionRecord {
  return {
    id: `${projectId}:codex:shared-provider-id`,
    projectId,
    provider: 'codex',
    providerSessionId: 'shared-provider-id',
    title: 'Same provider title',
    cwd: projectId === 'project-1' ? '/tmp/one' : '/tmp/two',
    createdAt: '2026-07-30T08:00:00.000Z',
    updatedAt: '2026-07-30T10:00:00.000Z',
    lastActivityAt: '2026-07-30T10:00:00.000Z',
    activityStatus: 'ended',
    suggestedType: 'unknown',
    suggestedTypeConfidence: 0,
    suggestedTypeBasis: [],
    primaryType: 'unknown',
    contentStrategy: 'minimal',
    isPartial: false,
    collectedAt: '2026-07-30T10:00:00.000Z'
  }
}

describe('SeePalDatabase', () => {
  it('isolates equal provider session ids between projects and cascades deletion', () => {
    const database = new SeePalDatabase(':memory:')
    database.createProject(projectOne)
    database.createProject(projectTwo)
    database.upsertSession(session('project-1'))
    database.upsertSession(session('project-2'))

    expect(database.listSessions('project-1')).toHaveLength(1)
    expect(database.listSessions('project-2')).toHaveLength(1)

    database.deleteProject('project-1')

    expect(database.listSessions('project-1')).toEqual([])
    expect(database.listSessions('project-2')).toHaveLength(1)
    database.close()
  })

  it('records type corrections as history and resolves the latest user choice', () => {
    const database = new SeePalDatabase(':memory:')
    database.createProject(projectOne)
    database.upsertSession(session('project-1'))

    database.addTypeCorrection(
      'project-1',
      'project-1:codex:shared-provider-id',
      'bugfix',
      '2026-07-30T11:00:00.000Z'
    )
    database.addTypeCorrection(
      'project-1',
      'project-1:codex:shared-provider-id',
      'investigation',
      '2026-07-30T12:00:00.000Z'
    )

    const stored = database.getSession('project-1', 'project-1:codex:shared-provider-id')
    expect(stored?.primaryType).toBe('investigation')
    expect(database.listTypeCorrections('project-1', stored!.id)).toHaveLength(2)
    database.close()
  })

  it('marks interrupted synchronizations failed on the next launch', () => {
    const database = new SeePalDatabase(':memory:')
    database.createProject({ ...projectOne, syncStatus: 'syncing' })

    expect(database.markInterruptedSyncsFailed('2026-07-30T12:00:00.000Z')).toBe(1)
    expect(database.getProject(projectOne.id)).toMatchObject({
      syncStatus: 'failed',
      syncMessage: '上次同步被中断，请重新同步。'
    })
    database.close()
  })
})
