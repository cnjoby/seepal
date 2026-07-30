import {
  UI_SESSION_TYPES,
  type ContentPolicy,
  type DeleteResultDto,
  type EvidenceAxisDto,
  type ProjectDashboardDto,
  type ProjectInspectionDto,
  type ProjectSummaryDto,
  type SeePalApi,
  type SessionViewDto,
  type UiSessionType,
} from '../shared/ipc'

export const SESSION_TYPES = UI_SESSION_TYPES
export type SessionType = UiSessionType

export const SESSION_TYPE_LABELS: Record<SessionType, string> = {
  feature: '需求实现',
  bugfix: 'BUG 修复',
  investigation: '调研排查',
  review: '代码审查',
  testing: '测试验收',
  documentation: '文档',
  engineering: '工程治理',
  release: '发布运维',
  'product-design': '产品设计',
  unknown: '其他 / 未知',
}

export const GROUP_ORDER = [
  'needs-attention',
  'ai-working',
  'waiting',
  'settled',
  'unknown',
] as const satisfies readonly SessionViewDto['group'][]

export type SessionGroup = SessionViewDto['group']

export const GROUP_LABELS: Record<SessionGroup, string> = {
  'needs-attention': '需要我处理',
  'ai-working': 'AI 正在工作',
  waiting: '等待其他 Session',
  settled: '已经收尾',
  unknown: '状态不明确',
}

export type EvidenceTone = EvidenceAxisDto['tone']
export type EvidenceAxis = EvidenceAxisDto
export type SessionView = SessionViewDto
export type SyncCoverage = ProjectDashboardDto['coverage']
export type ProjectSummary = ProjectSummaryDto
export type ProjectDashboard = ProjectDashboardDto
export type ProjectInspection = ProjectInspectionDto
export type DeleteResult = DeleteResultDto

export type AddProjectInput = Parameters<SeePalApi['addProject']>[0]

export type {
  ContentPolicy,
  SeePalApi,
}
