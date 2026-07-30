import { describe, expect, it } from 'vitest'
import type { SessionAssessment } from '../../src/shared/domain.js'
import { toSessionView } from '../../src/main/view-model.js'

function assessment(
  overrides: Partial<SessionAssessment> = {},
): SessionAssessment {
  const collectedAt = '2026-07-30T10:00:00.000Z'
  const axis = (key: keyof SessionAssessment['axes']) => ({
    axis: key,
    status: 'unknown',
    label: key,
    certainty: 'unknown' as const,
    summary: '数据不足',
    evidenceIds: [],
    sources: [],
    collectedAt,
  })
  return {
    session: {
      id: 'session-1',
      projectId: 'project-1',
      provider: 'codex',
      providerSessionId: 'thread-1',
      title: '修复登录问题',
      cwd: '/tmp/project',
      createdAt: collectedAt,
      updatedAt: collectedAt,
      lastActivityAt: collectedAt,
      activityStatus: 'ended',
      suggestedType: 'code-review',
      suggestedTypeConfidence: 0.82,
      suggestedTypeBasis: ['会话目标包含 review'],
      primaryType: 'engineering-governance',
      contentStrategy: 'minimal',
      isPartial: false,
      collectedAt,
    },
    group: 'waiting-on-session',
    primaryStatus: '等待另一个 Session',
    explanation: '存在已确认依赖',
    axes: {
      activity: axis('activity'),
      changes: axis('changes'),
      review: axis('review'),
      commit: axis('commit'),
      worktree: axis('worktree'),
      handoff: axis('handoff'),
    },
    hasConflicts: false,
    isStale: false,
    ...overrides,
  }
}

describe('renderer projection', () => {
  it('maps domain-only type and group values to the user contract', () => {
    const view = toSessionView(assessment())

    expect(view.type).toBe('engineering')
    expect(view.suggestedType).toBe('review')
    expect(view.group).toBe('waiting')
    expect(view.evidence).toHaveLength(6)
  })

  it('keeps conflict and stale facts conservative', () => {
    const value = assessment()
    value.axes.commit = {
      ...value.axes.commit,
      certainty: 'conflict',
      summary: 'Commit 归属证据冲突',
    }
    value.axes.worktree = {
      ...value.axes.worktree,
      certainty: 'stale',
      summary: 'Worktree 数据已过期',
    }

    const view = toSessionView(value)

    expect(view.evidence.find((item) => item.key === 'commit')).toMatchObject({
      tone: 'unknown',
      relation: 'conflicting',
    })
    expect(view.evidence.find((item) => item.key === 'worktree')).toMatchObject({
      tone: 'unknown',
      freshness: 'stale',
    })
  })

  it('uses user-facing axis labels and attention tone for candidate work', () => {
    const value = assessment()
    value.axes.review = {
      ...value.axes.review,
      status: 'needs-review',
      label: '需要人工 Review',
      certainty: 'candidate'
    }

    const review = toSessionView(value).evidence.find((item) => item.key === 'review')

    expect(review).toMatchObject({
      status: '需要人工 Review',
      tone: 'attention',
      relation: 'candidate'
    })
  })
})
