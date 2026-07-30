import type {
  AddProjectInput,
  ContentPolicy,
  DeleteResult,
  ProjectDashboard,
  ProjectInspection,
  ProjectSummary,
  SeePalApi,
  SessionType,
  SessionView,
} from './types'

const unavailable = async <T>(): Promise<T> => {
  throw new Error('SeePal 本地服务尚未就绪，请重新启动应用。')
}

const fallbackApi: SeePalApi = {
  listProjects: () => unavailable<ProjectSummary[]>(),
  selectDirectory: () => unavailable<string | null>(),
  inspectProject: () => unavailable<ProjectInspection>(),
  addProject: (_input: AddProjectInput) => unavailable<ProjectSummary>(),
  getProjectDashboard: () => unavailable<ProjectDashboard>(),
  syncCodex: (_projectId: string, _policy: ContentPolicy) =>
    unavailable<ProjectDashboard>(),
  updateSessionType: (
    _projectId: string,
    _sessionId: string,
    _type: SessionType,
  ) => unavailable<SessionView>(),
  deleteProject: () => unavailable<DeleteResult>(),
}

export const api: SeePalApi =
  typeof window !== 'undefined' && window.seepal ? window.seepal : fallbackApi
