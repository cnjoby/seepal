import {
  EVIDENCE_AXES,
  type AxisAssessment,
  type ConsoleGroup,
  type Project,
  type ProjectConsole,
  type ProjectSummary,
  type SessionAssessment,
  type SessionType,
  type SyncStatus,
} from '../shared/domain.js'
import type {
  EvidenceAxisDto,
  ProjectDashboardDto,
  ProjectSummaryDto,
  SessionViewDto,
  SourceStatus,
  UiSessionType,
} from '../shared/ipc.js'

const axisLabels: Record<AxisAssessment['axis'], string> = {
  activity: '活动',
  changes: '改动',
  review: '人工 Review',
  commit: 'Commit',
  worktree: 'Worktree / 集成',
  handoff: '上下文承接',
}

const toUiTypeMap: Record<SessionType, UiSessionType> = {
  feature: 'feature',
  bugfix: 'bugfix',
  investigation: 'investigation',
  'code-review': 'review',
  testing: 'testing',
  documentation: 'documentation',
  'engineering-governance': 'engineering',
  'release-operations': 'release',
  'product-design': 'product-design',
  unknown: 'unknown',
}

export const fromUiTypeMap: Record<UiSessionType, SessionType> = {
  feature: 'feature',
  bugfix: 'bugfix',
  investigation: 'investigation',
  review: 'code-review',
  testing: 'testing',
  documentation: 'documentation',
  engineering: 'engineering-governance',
  release: 'release-operations',
  'product-design': 'product-design',
  unknown: 'unknown',
}

const groupMap: Record<
  ConsoleGroup,
  SessionViewDto['group']
> = {
  'needs-attention': 'needs-attention',
  'ai-working': 'ai-working',
  'waiting-on-session': 'waiting',
  settled: 'settled',
  unknown: 'unknown',
}

const sourceStatusMap: Record<SyncStatus, SourceStatus> = {
  never: 'not-connected',
  syncing: 'syncing',
  complete: 'complete',
  partial: 'partial',
  failed: 'failed',
}

function axisTone(axis: AxisAssessment): EvidenceAxisDto['tone'] {
  if (
    axis.certainty === 'unknown' ||
    axis.certainty === 'conflict' ||
    axis.certainty === 'stale'
  ) {
    return 'unknown'
  }
  if (axis.status === 'not-applicable') return 'not-applicable'
  if (axis.certainty === 'candidate') return 'attention'
  if (
    axis.status.includes('waiting') ||
    axis.status.includes('pending') ||
    axis.status.includes('unreviewed') ||
    axis.status.includes('uncommitted') ||
    axis.status.includes('dirty') ||
    axis.status === 'needs-review' ||
    axis.status === 'ahead' ||
    axis.status === 'overlapping' ||
    axis.status === 'needed'
  ) {
    return 'attention'
  }
  if (axis.status === 'running') return 'active'
  return 'complete'
}

export function toSessionView(
  assessment: SessionAssessment,
): SessionViewDto {
  const { session } = assessment
  return {
    id: session.id,
    provider: session.provider,
    title: session.title,
    type: toUiTypeMap[session.primaryType],
    suggestedType: toUiTypeMap[session.suggestedType],
    typeConfidence: session.suggestedTypeConfidence,
    typeReason: session.suggestedTypeBasis.join('；'),
    group: groupMap[assessment.group],
    status: assessment.primaryStatus,
    nextAction: assessment.nextStep,
    lastActivityAt: session.lastActivityAt,
    branch: session.branch,
    worktree: session.worktreePath,
    evidence: EVIDENCE_AXES.map((key) => {
      const axis = assessment.axes[key]
      return {
        key,
        label: axisLabels[key],
        status: axis.label,
        summary: axis.summary,
        tone: axisTone(axis),
        source: axis.sources.length > 0 ? axis.sources.join('、') : undefined,
        occurredAt: axis.occurredAt,
        collectedAt: axis.collectedAt,
        freshness:
          axis.certainty === 'stale'
            ? 'stale'
            : axis.collectedAt
              ? 'fresh'
              : 'unknown',
        relation:
          axis.certainty === 'conflict'
            ? 'conflicting'
            : axis.certainty === 'candidate'
              ? 'candidate'
              : axis.certainty === 'confirmed'
                ? 'confirmed'
                : undefined,
      }
    }),
  }
}

export function toProjectSummary(
  project: Project | ProjectSummary,
  sessionCount = 'sessionCount' in project ? project.sessionCount : 0,
  attentionCount = 'needsAttentionCount' in project
    ? project.needsAttentionCount
    : 0,
): ProjectSummaryDto {
  return {
    id: project.id,
    name: project.name,
    path: project.rootPath,
    contentPolicy: project.contentStrategy === 'full-local' ? 'full-local' : 'metadata',
    sessionCount,
    attentionCount,
    lastSyncedAt: project.lastSuccessfulSyncAt,
    sourceStatus: sourceStatusMap[project.syncStatus],
  }
}

export function toDashboard(consoleView: ProjectConsole): ProjectDashboardDto {
  const sessions = consoleView.sessions.map(toSessionView)
  const timestamps = sessions
    .map((session) => session.lastActivityAt)
    .filter((value): value is string => Boolean(value))
    .sort()
  return {
    project: toProjectSummary(
      consoleView.project,
      sessions.length,
      sessions.filter((session) => session.group === 'needs-attention').length,
    ),
    sessions,
    coverage: {
      sessionCount: consoleView.project.coverage?.sessionCount ?? sessions.length,
      from: consoleView.project.coverage?.from ?? timestamps.at(0),
      to: consoleView.project.coverage?.to ?? timestamps.at(-1),
      lastSuccessfulAt: consoleView.project.lastSuccessfulSyncAt,
      status: sourceStatusMap[consoleView.project.syncStatus],
      affectedScope: consoleView.project.coverage?.isComplete
        ? undefined
        : consoleView.project.coverage?.note,
      message: consoleView.project.syncMessage,
    },
  }
}
