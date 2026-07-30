export const SESSION_TYPES = [
  'feature',
  'bugfix',
  'investigation',
  'code-review',
  'testing',
  'documentation',
  'engineering-governance',
  'release-operations',
  'product-design',
  'unknown'
] as const

export type SessionType = (typeof SESSION_TYPES)[number]

export const SESSION_TYPE_LABELS: Record<SessionType, string> = {
  feature: '需求/功能实现',
  bugfix: 'BUG 修复',
  investigation: '调研/问题排查',
  'code-review': '代码审查',
  testing: '测试/验收',
  documentation: '文档',
  'engineering-governance': '工程治理',
  'release-operations': '发布/部署/运维',
  'product-design': '产品/UX/设计',
  unknown: '其他/未知'
}

export const CONTENT_STRATEGIES = ['minimal', 'full-local'] as const
export type ContentStrategy = (typeof CONTENT_STRATEGIES)[number]

export const CONSOLE_GROUPS = [
  'needs-attention',
  'ai-working',
  'waiting-on-session',
  'settled',
  'unknown'
] as const
export type ConsoleGroup = (typeof CONSOLE_GROUPS)[number]

export const EVIDENCE_AXES = [
  'activity',
  'changes',
  'review',
  'commit',
  'worktree',
  'handoff'
] as const
export type EvidenceAxis = (typeof EVIDENCE_AXES)[number]

export type ActivityStatus =
  | 'running'
  | 'waiting-for-user'
  | 'waiting-on-session'
  | 'ended'
  | 'unknown'

export type SyncStatus = 'never' | 'syncing' | 'complete' | 'partial' | 'failed'
export type EvidenceConfidence = 'confirmed' | 'candidate' | 'unknown'
export type AssessmentCertainty = EvidenceConfidence | 'conflict' | 'stale'

export interface CoverageWindow {
  from?: string
  to?: string
  sessionCount: number
  isComplete: boolean
  note?: string
}

export interface Project {
  id: string
  name: string
  rootPath: string
  canonicalRootPath: string
  contentStrategy: ContentStrategy
  createdAt: string
  updatedAt: string
  lastSuccessfulSyncAt?: string
  syncStatus: SyncStatus
  coverage?: CoverageWindow
  syncMessage?: string
}

export interface ProjectScope {
  rootPath: string
  canonicalRootPath: string
  isGitRepository: boolean
  gitDirectory?: string
  worktrees: string[]
  submodules: string[]
  symbolicLinks: string[]
  includedPaths: string[]
  excludedPaths: string[]
  warnings: string[]
}

export interface ProjectSummary extends Project {
  sessionCount: number
  needsAttentionCount: number
}

export interface SessionRecord {
  id: string
  projectId: string
  provider: 'codex'
  providerSessionId: string
  title: string
  cwd: string
  createdAt: string
  updatedAt: string
  lastActivityAt: string
  activityStatus: ActivityStatus
  suggestedType: SessionType
  suggestedTypeConfidence: number
  suggestedTypeBasis: string[]
  userType?: SessionType
  primaryType: SessionType
  branch?: string
  worktreePath?: string
  sourceBaseCommit?: string
  contentStrategy: ContentStrategy
  contentPreview?: string
  sourceVersion?: string
  isPartial: boolean
  collectedAt: string
}

export interface Evidence {
  id: string
  projectId: string
  sessionId: string
  axis: EvidenceAxis
  status: string
  summary: string
  source: string
  sourceRef?: string
  occurredAt?: string
  collectedAt: string
  confidence: EvidenceConfidence
  details?: Record<string, unknown>
}

export interface TypeCorrection {
  id: number
  projectId: string
  sessionId: string
  sessionType: SessionType
  correctedAt: string
}

export interface AxisAssessment {
  axis: EvidenceAxis
  status: string
  label: string
  certainty: AssessmentCertainty
  summary: string
  evidenceIds: string[]
  sources: string[]
  occurredAt?: string
  collectedAt?: string
}

export interface SessionAssessment {
  session: SessionRecord
  group: ConsoleGroup
  primaryStatus: string
  explanation: string
  nextStep?: string
  axes: Record<EvidenceAxis, AxisAssessment>
  hasConflicts: boolean
  isStale: boolean
}

export interface ConsoleFilters {
  groups?: ConsoleGroup[]
  types?: SessionType[]
}

export interface ProjectConsole {
  project: Project
  sessions: SessionAssessment[]
  generatedAt: string
}

export interface SyncFailure {
  stage: 'initialize' | 'list' | 'read' | 'persist'
  message: string
  providerSessionId?: string
}

export interface CodexDiscovery {
  matchedCount: number
  coverage?: CoverageWindow
  compatibility: {
    status: 'supported' | 'degraded' | 'unsupported'
    version?: string
    message?: string
  }
  failures: SyncFailure[]
}

export interface CodexSyncResult extends CodexDiscovery {
  sessions: SessionRecord[]
  evidence: Evidence[]
}

export interface DeleteProjectResult {
  deleted: boolean
  removed: {
    projects: number
    sessions: number
    evidence: number
    typeCorrections: number
    syncRuns: number
  }
  remaining: string[]
}

export function isSessionType(value: unknown): value is SessionType {
  return typeof value === 'string' && (SESSION_TYPES as readonly string[]).includes(value)
}

export function isContentStrategy(value: unknown): value is ContentStrategy {
  return typeof value === 'string' && (CONTENT_STRATEGIES as readonly string[]).includes(value)
}
