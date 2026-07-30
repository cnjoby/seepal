export const IPC_CHANNELS = {
  selectDirectory: 'seepal:select-directory',
  inspectProject: 'seepal:inspect-project',
  addProject: 'seepal:add-project',
  listProjects: 'seepal:list-projects',
  getProjectDashboard: 'seepal:get-project-dashboard',
  syncCodex: 'seepal:sync-codex',
  updateSessionType: 'seepal:update-session-type',
  deleteProject: 'seepal:delete-project',
  getAiConfig: 'seepal:get-ai-config',
  saveAiConfig: 'seepal:save-ai-config',
  clearAiApiKey: 'seepal:clear-ai-api-key',
  testAiConnection: 'seepal:test-ai-connection',
  prepareAiScan: 'seepal:prepare-ai-scan',
  startAiScan: 'seepal:start-ai-scan',
  getAiScanStatus: 'seepal:get-ai-scan-status',
  cancelAiScan: 'seepal:cancel-ai-scan',
  resumeAiScan: 'seepal:resume-ai-scan',
  retryAiScanFailures: 'seepal:retry-ai-scan-failures',
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
export type AiProtocol = 'openai' | 'anthropic'
export const DEFAULT_AI_MODEL = 'deepseek-v4-flash'
export const DEFAULT_AI_BASE_URLS: Record<AiProtocol, string> = {
  openai: 'https://api.deepseek.com',
  anthropic: 'https://api.deepseek.com/anthropic',
}
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
  ai?: AiInterpretationDto
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

export interface AiConfigDto {
  protocol: AiProtocol
  baseUrl: string
  model: string
  hasApiKey: boolean
  loadError?: string
}

export interface AiConfigInput {
  protocol: AiProtocol
  baseUrl: string
  model: string
  apiKey?: string
}

export interface AiConnectionTestResultDto {
  ok: boolean
  message: string
  model?: string
  latencyMs?: number
}

export type AiAssessmentDto =
  | 'needs-action'
  | 'blocked'
  | 'possibly-complete'
  | 'unknown'

export interface AiInterpretationDto {
  assessment: AiAssessmentDto
  nextActor: 'user' | 'ai' | 'external' | 'none' | 'unknown'
  goal: string
  outcome: string
  gaps: string[]
  nextAction?: string
  evidenceRefs: string[]
}

export interface AiScanPreparationDto {
  id: string
  projectId: string
  projectName: string
  sessionCount: number
  cachedCount: number
  requestCount: number
  providerHost: string
  model: string
  hasApiKey: boolean
  expiresAt: string
}

export interface AiScanStatusDto {
  runId?: string
  status: 'idle' | 'running' | 'paused' | 'completed' | 'partial' | 'canceled'
  total: number
  succeeded: number
  reused: number
  failed: number
  stale: number
  unknown: number
  pending: number
  items: Array<{
    sessionId: string
    status: 'pending' | 'processing' | 'succeeded' | 'reused' | 'failed' | 'stale' | 'unknown'
    error?: string
  }>
  interpretations: Record<string, AiInterpretationDto>
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
  getAiConfig(): Promise<AiConfigDto>
  saveAiConfig(input: AiConfigInput): Promise<AiConfigDto>
  clearAiApiKey(): Promise<AiConfigDto>
  testAiConnection(): Promise<AiConnectionTestResultDto>
  prepareAiScan(projectId: string): Promise<AiScanPreparationDto>
  startAiScan(input: {
    preparationId: string
    localReadConfirmed: boolean
    remoteSendConfirmed: boolean
  }): Promise<AiScanStatusDto>
  getAiScanStatus(projectId: string): Promise<AiScanStatusDto>
  cancelAiScan(projectId: string): Promise<AiScanStatusDto>
  resumeAiScan(projectId: string): Promise<AiScanStatusDto>
  retryAiScanFailures(projectId: string): Promise<AiScanStatusDto>
}
