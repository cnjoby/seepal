import {
  EVIDENCE_AXES,
  type AssessmentCertainty,
  type AxisAssessment,
  type Evidence,
  type EvidenceAxis,
  type SessionAssessment,
  type SessionRecord,
  type SessionType
} from '../shared/domain.js'

const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1_000

const CODE_EXPECTED_TYPES = new Set<SessionType>([
  'feature',
  'bugfix',
  'engineering-governance'
])

const STATUS_LABELS: Record<EvidenceAxis, Record<string, string>> = {
  activity: {
    running: 'AI 正在工作',
    'waiting-for-user': '等待你回复',
    'waiting-on-session': '等待其他 Session',
    ended: 'Session 已结束',
    unknown: '活动状态不明确'
  },
  changes: {
    present: '发现代码或文档改动',
    none: '未发现改动',
    candidate: '发现候选改动',
    unknown: '改动状态不明确',
    'not-applicable': '无需代码改动'
  },
  review: {
    reviewed: '已确认 Review',
    'needs-review': '需要 Review',
    'not-applicable': '当前无需 Review',
    unknown: 'Review 状态不明确'
  },
  commit: {
    committed: '已发现对应 Commit',
    uncommitted: '仍有未提交改动',
    'not-applicable': '当前无需 Commit',
    unknown: 'Commit 状态不明确'
  },
  worktree: {
    clean: 'Worktree 干净',
    dirty: 'Worktree 仍有改动',
    ahead: 'Branch 尚未集成',
    overlapping: '与其他 Worktree 有候选重叠',
    'not-applicable': '当前无 Worktree 收尾要求',
    unknown: 'Worktree 状态不明确'
  },
  handoff: {
    'not-needed': '当前无需承接',
    needed: '需要后续 Session 承接',
    continued: '已关联后续 Session',
    unknown: '承接状态不明确'
  }
}

function timestampOf(evidence: Evidence): number {
  const value = evidence.occurredAt ?? evidence.collectedAt
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : 0
}

function latestEvidenceForAxis(evidence: Evidence[], axis: EvidenceAxis): Evidence[] {
  const matches = evidence.filter((item) => item.axis === axis)
  if (matches.length === 0) return []

  const latestTimestamp = Math.max(...matches.map(timestampOf))
  return matches.filter((item) => timestampOf(item) === latestTimestamp)
}

function certaintyFor(evidence: Evidence[]): AssessmentCertainty {
  if (new Set(evidence.map((item) => item.status)).size > 1) return 'conflict'
  if (evidence.some((item) => item.confidence === 'candidate')) return 'candidate'
  if (evidence.every((item) => item.confidence === 'unknown')) return 'unknown'
  return 'confirmed'
}

function defaultAxis(
  axis: EvidenceAxis,
  status: string,
  summary: string,
  certainty: AssessmentCertainty = 'unknown'
): AxisAssessment {
  return {
    axis,
    status,
    label: STATUS_LABELS[axis][status] ?? status,
    certainty,
    summary,
    evidenceIds: [],
    sources: []
  }
}

function projectAxis(axis: EvidenceAxis, allEvidence: Evidence[]): AxisAssessment {
  const latest = latestEvidenceForAxis(allEvidence, axis)
  if (latest.length === 0) {
    return defaultAxis(axis, 'unknown', '当前没有足够事实判断该状态。')
  }

  const certainty = certaintyFor(latest)
  if (certainty === 'conflict') {
    return {
      axis,
      status: 'unknown',
      label: '证据存在冲突',
      certainty,
      summary: latest.map((item) => item.summary).join('；'),
      evidenceIds: latest.map((item) => item.id),
      sources: [...new Set(latest.map((item) => item.source))],
      occurredAt: latest[0]?.occurredAt,
      collectedAt: latest[0]?.collectedAt
    }
  }

  const selected = latest[0]!
  return {
    axis,
    status: selected.status,
    label: STATUS_LABELS[axis][selected.status] ?? selected.status,
    certainty,
    summary: selected.summary,
    evidenceIds: latest.map((item) => item.id),
    sources: [...new Set(latest.map((item) => item.source))],
    occurredAt: selected.occurredAt,
    collectedAt: selected.collectedAt
  }
}

function deriveMissingAxes(
  session: SessionRecord,
  axes: Record<EvidenceAxis, AxisAssessment>
): void {
  if (
    axes.activity.status === 'unknown' &&
    axes.activity.certainty !== 'conflict' &&
    session.activityStatus !== 'unknown'
  ) {
    axes.activity = defaultAxis(
      'activity',
      session.activityStatus,
      '活动状态来自 Codex Thread 元数据。',
      'confirmed'
    )
  }

  const hasChanges = axes.changes.status === 'present' || axes.changes.status === 'candidate'
  const expectsCode = CODE_EXPECTED_TYPES.has(session.primaryType)

  if (axes.review.status === 'unknown' && axes.review.certainty !== 'conflict') {
    axes.review = hasChanges
      ? defaultAxis('review', 'needs-review', '发现改动，但没有找到对应的人工 Review 确认。', 'candidate')
      : defaultAxis(
          'review',
          expectsCode ? 'unknown' : 'not-applicable',
          expectsCode ? '尚不能判断是否需要 Review。' : '该类型不要求必须产生代码改动。'
        )
  }

  if (axes.commit.status === 'unknown' && axes.commit.certainty !== 'conflict') {
    axes.commit =
      axes.worktree.status === 'dirty'
        ? defaultAxis(
            'commit',
            'uncommitted',
            'Worktree 仍有未提交改动。',
            axes.worktree.certainty === 'confirmed' ? 'confirmed' : 'candidate'
          )
        : defaultAxis(
            'commit',
            hasChanges ? 'unknown' : 'not-applicable',
            hasChanges ? '尚不能确认改动是否已提交。' : '当前没有需要提交的已确认改动。'
          )
  }

  if (!expectsCode && axes.changes.status === 'none') {
    if (axes.worktree.status === 'unknown') {
      axes.worktree = defaultAxis(
        'worktree',
        'not-applicable',
        '当前没有需要收尾的代码改动。'
      )
    }
  }
}

export interface AssessmentOptions {
  now?: Date
  staleAfterMs?: number
}

export function assessSession(
  session: SessionRecord,
  evidence: Evidence[],
  options: AssessmentOptions = {}
): SessionAssessment {
  const relevantEvidence = evidence.filter(
    (item) => item.projectId === session.projectId && item.sessionId === session.id
  )
  const axes = Object.fromEntries(
    EVIDENCE_AXES.map((axis) => [axis, projectAxis(axis, relevantEvidence)])
  ) as Record<EvidenceAxis, AxisAssessment>

  deriveMissingAxes(session, axes)

  const hasConflicts = Object.values(axes).some((axis) => axis.certainty === 'conflict')
  const now = options.now ?? new Date()
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  for (const axis of Object.values(axes)) {
    if (axis.certainty === 'conflict' || !axis.collectedAt) continue
    const collectedAt = Date.parse(axis.collectedAt)
    if (Number.isFinite(collectedAt) && now.getTime() - collectedAt > staleAfterMs) {
      axis.certainty = 'stale'
    }
  }
  const isStale = Object.values(axes).some((axis) => axis.certainty === 'stale')

  if (hasConflicts || isStale) {
    return {
      session,
      group: 'unknown',
      primaryStatus: '状态不明确',
      explanation: hasConflicts
        ? '不同来源对同一状态给出了冲突事实，需要确认后才能继续判断。'
        : '当前数据已经过期，请刷新项目后再判断。',
      nextStep: hasConflicts ? '检查冲突证据' : '刷新项目数据',
      axes,
      hasConflicts,
      isStale
    }
  }

  if (axes.activity.status === 'running') {
    return {
      session,
      group: 'ai-working',
      primaryStatus: 'AI 正在工作',
      explanation: axes.activity.summary,
      axes,
      hasConflicts,
      isStale
    }
  }

  if (axes.activity.status === 'waiting-on-session') {
    return {
      session,
      group: 'waiting-on-session',
      primaryStatus: '等待其他 Session',
      explanation: axes.activity.summary,
      axes,
      hasConflicts,
      isStale
    }
  }

  if (axes.activity.status === 'waiting-for-user') {
    return {
      session,
      group: 'needs-attention',
      primaryStatus: '等待你回复',
      explanation: axes.activity.summary,
      nextStep: '查看 Session 的待确认内容',
      axes,
      hasConflicts,
      isStale
    }
  }

  if (axes.review.status === 'needs-review') {
    return {
      session,
      group: 'needs-attention',
      primaryStatus: '改动需要 Review',
      explanation: axes.review.summary,
      nextStep: 'Review 当前改动',
      axes,
      hasConflicts,
      isStale
    }
  }

  if (axes.commit.status === 'uncommitted' && axes.commit.certainty === 'confirmed') {
    return {
      session,
      group: 'needs-attention',
      primaryStatus: '改动尚未提交',
      explanation: axes.commit.summary,
      nextStep: '检查并提交改动',
      axes,
      hasConflicts,
      isStale
    }
  }

  if (
    ['dirty', 'ahead', 'overlapping'].includes(axes.worktree.status) &&
    axes.worktree.certainty === 'confirmed'
  ) {
    return {
      session,
      group: 'needs-attention',
      primaryStatus: axes.worktree.label,
      explanation: axes.worktree.summary,
      nextStep: '检查 Worktree 状态',
      axes,
      hasConflicts,
      isStale
    }
  }

  if (axes.handoff.status === 'needed' && axes.handoff.certainty === 'confirmed') {
    return {
      session,
      group: 'needs-attention',
      primaryStatus: '需要后续 Session 承接',
      explanation: axes.handoff.summary,
      nextStep: '确认后续 Session',
      axes,
      hasConflicts,
      isStale
    }
  }

  const insufficient =
    axes.activity.status === 'unknown' ||
    axes.handoff.status === 'unknown' ||
    session.primaryType === 'unknown' ||
    Object.values(axes).some((axis) => axis.certainty === 'candidate') ||
    (CODE_EXPECTED_TYPES.has(session.primaryType) &&
      ['unknown', 'none'].includes(axes.changes.status)) ||
    (axes.changes.status === 'present' &&
      (axes.commit.status === 'unknown' || axes.commit.certainty === 'candidate'))

  if (insufficient) {
    return {
      session,
      group: 'unknown',
      primaryStatus: '状态不明确',
      explanation: '当前事实不足以判断这个 Session 是否还需要处理。',
      nextStep: '检查状态依据',
      axes,
      hasConflicts,
      isStale
    }
  }

  return {
    session,
    group: 'settled',
    primaryStatus: '当前无需处理',
    explanation: '当前没有发现需要你处理的 Session 级状态。',
    axes,
    hasConflicts,
    isStale
  }
}
