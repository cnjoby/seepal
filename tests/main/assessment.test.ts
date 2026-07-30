import { describe, expect, it } from 'vitest'

import { assessSession } from '../../src/main/assessment.js'
import type { Evidence, SessionRecord } from '../../src/shared/domain.js'

const collectedAt = '2026-07-30T10:00:00.000Z'

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'project-1:codex:thread-1',
    projectId: 'project-1',
    provider: 'codex',
    providerSessionId: 'thread-1',
    title: '实现设置页',
    cwd: '/tmp/project',
    createdAt: '2026-07-30T08:00:00.000Z',
    updatedAt: collectedAt,
    lastActivityAt: collectedAt,
    activityStatus: 'ended',
    suggestedType: 'feature',
    suggestedTypeConfidence: 0.92,
    suggestedTypeBasis: ['会话目标包含实现'],
    primaryType: 'feature',
    contentStrategy: 'minimal',
    isPartial: false,
    collectedAt,
    ...overrides
  }
}

function evidence(
  axis: Evidence['axis'],
  status: string,
  overrides: Partial<Evidence> = {}
): Evidence {
  return {
    id: `${axis}:${status}`,
    projectId: 'project-1',
    sessionId: 'project-1:codex:thread-1',
    axis,
    status,
    summary: `${axis} is ${status}`,
    source: 'test',
    collectedAt,
    confidence: 'confirmed',
    ...overrides
  }
}

describe('assessSession', () => {
  it('keeps a finished coding session with unreviewed changes in needs-attention', () => {
    const result = assessSession(session(), [
      evidence('activity', 'ended'),
      evidence('changes', 'present'),
      evidence('worktree', 'dirty')
    ])

    expect(result.group).toBe('needs-attention')
    expect(result.axes.review.status).toBe('needs-review')
    expect(result.primaryStatus).toContain('Review')
  })

  it('prioritizes observed active work without claiming completion', () => {
    const result = assessSession(session({ activityStatus: 'running' }), [
      evidence('activity', 'running')
    ])

    expect(result.group).toBe('ai-working')
    expect(result.primaryStatus).toBe('AI 正在工作')
  })

  it('keeps a finished investigation conservative when handoff is unknown', () => {
    const result = assessSession(session({ primaryType: 'investigation' }), [
      evidence('activity', 'ended'),
      evidence('changes', 'none'),
      evidence('worktree', 'clean')
    ])

    expect(result.group).toBe('unknown')
    expect(result.axes.review.status).toBe('not-applicable')
    expect(result.primaryStatus).toBe('状态不明确')
  })

  it('does not treat an unknown session type with missing evidence as settled', () => {
    const result = assessSession(
      session({
        suggestedType: 'unknown',
        suggestedTypeConfidence: 0.2,
        primaryType: 'unknown'
      }),
      [evidence('activity', 'ended'), evidence('changes', 'none')]
    )

    expect(result.group).toBe('unknown')
    expect(result.primaryStatus).toBe('状态不明确')
  })

  it('preserves conflicting facts instead of selecting the newest convenient answer', () => {
    const result = assessSession(session(), [
      evidence('activity', 'ended'),
      evidence('changes', 'present'),
      evidence('review', 'reviewed', { id: 'reviewed' }),
      evidence('review', 'needs-review', { id: 'not-reviewed' })
    ])

    expect(result.group).toBe('unknown')
    expect(result.axes.review.certainty).toBe('conflict')
    expect(result.hasConflicts).toBe(true)
  })

  it('marks the affected axes stale when the last collection is out of date', () => {
    const result = assessSession(
      session(),
      [evidence('activity', 'ended')],
      { now: new Date('2026-08-02T10:00:00.000Z') }
    )

    expect(result.isStale).toBe(true)
    expect(result.axes.activity.certainty).toBe('stale')
    expect(result.group).toBe('unknown')
  })

  it('does not let one fresh axis hide stale evidence on another axis', () => {
    const result = assessSession(
      session(),
      [
        evidence('activity', 'ended', {
          collectedAt: '2026-07-28T10:00:00.000Z'
        }),
        evidence('worktree', 'clean')
      ],
      { now: new Date('2026-07-30T10:00:00.000Z') }
    )

    expect(result.axes.activity.certainty).toBe('stale')
    expect(result.axes.worktree.certainty).toBe('confirmed')
    expect(result.group).toBe('unknown')
  })
})
