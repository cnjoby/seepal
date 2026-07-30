export const IPC_CHANNELS = {
  selectDirectory: 'seepal:select-directory',
  inspectProject: 'seepal:inspect-project',
  addProject: 'seepal:add-project',
  listProjects: 'seepal:list-projects',
  getProjectDashboard: 'seepal:get-project-dashboard',
  syncCodex: 'seepal:sync-codex',
  updateSessionType: 'seepal:update-session-type',
  deleteProject: 'seepal:delete-project',
} as const

export const UI_SESSION_TYPES = [
  'feature',
  'bugfix',
  'investigation',
  'review',
  'testing',
  'documentation',
  'engineering',
  'release',
  'product-design',
  'unknown',
] as const

export type UiSessionType = (typeof UI_SESSION_TYPES)[number]
export type ContentPolicy = 'metadata' | 'full-local'
export type SourceStatus =
  | 'not-connected'
  | 'syncing'
  | 'complete'
  | 'partial'
  | 'failed'

export interface SyncCoverageDto {
  sessionCount: number
  from?: string
  to?: string
  lastSuccessfulAt?: string
  status: SourceStatus
  stage?: string
  affectedScope?: string
  message?: string
}

export interface ProjectSummaryDto {
  id: string
  name: string
  path: string
  contentPolicy: ContentPolicy
  sessionCount: number
  attentionCount: number
  lastSyncedAt?: string
  sourceStatus?: SourceStatus
}

export interface ProjectInspectionDto {
  path: string
  name: string
  valid: boolean
  duplicateProjectId?: string
  reason?: string
  repositoryRoot?: string
  worktrees?: Array<{ path: string; branch?: string; included: boolean }>
  submodules?: Array<{ path: string; included: boolean }>
  linkedPaths?: Array<{ path: string; included: boolean }>
  codex?: {
    status: 'found' | 'not-found' | 'unavailable'
    sessionCount?: number
    from?: string
    to?: string
    attributionBasis?: string
  }
}

export interface EvidenceAxisDto {
  key: 'activity' | 'changes' | 'review' | 'commit' | 'worktree' | 'handoff'
  label: string
  status: string
  summary: string
  tone: 'complete' | 'attention' | 'active' | 'unknown' | 'not-applicable'
  source?: string
  occurredAt?: string
  collectedAt?: string
  freshness?: 'fresh' | 'stale' | 'unknown'
  relation?: 'confirmed' | 'candidate' | 'conflicting'
}

export interface SessionViewDto {
  id: string
  provider: string
  title: string
  type: UiSessionType
  suggestedType?: UiSessionType
  typeConfidence?: number
  typeReason?: string
  group: 'needs-attention' | 'ai-working' | 'waiting' | 'settled' | 'unknown'
  status: string
  nextAction?: string
  lastActivityAt?: string
  branch?: string
  worktree?: string
  evidence: EvidenceAxisDto[]
}

export interface ProjectDashboardDto {
  project: ProjectSummaryDto
  sessions: SessionViewDto[]
  coverage: SyncCoverageDto
}

export interface DeleteResultDto {
  success: boolean
  remainingCategories?: string[]
  message?: string
}

export interface SeePalApi {
  listProjects(): Promise<ProjectSummaryDto[]>
  selectDirectory(): Promise<string | null>
  inspectProject(path: string): Promise<ProjectInspectionDto>
  addProject(input: {
    path: string
    confirmedRepositoryRoot: string
    contentPolicy: ContentPolicy
  }): Promise<ProjectSummaryDto>
  getProjectDashboard(projectId: string): Promise<ProjectDashboardDto>
  syncCodex(
    projectId: string,
    contentPolicy: ContentPolicy,
  ): Promise<ProjectDashboardDto>
  updateSessionType(
    projectId: string,
    sessionId: string,
    type: UiSessionType,
  ): Promise<SessionViewDto>
  deleteProject(projectId: string): Promise<DeleteResultDto>
}
