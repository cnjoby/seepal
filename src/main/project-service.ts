import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { basename, resolve, sep } from 'node:path'

import { assessSession } from './assessment.js'
import { CodexAdapter } from './codex-adapter.js'
import { SeePalDatabase } from './database.js'
import { GitAdapter } from './git-adapter.js'
import {
  isContentStrategy,
  isSessionType,
  type CodexDiscovery,
  type CodexSyncResult,
  type ConsoleFilters,
  type ContentStrategy,
  type DeleteProjectResult,
  type Project,
  type ProjectConsole,
  type ProjectScope,
  type ProjectSummary,
  type SessionAssessment,
  type SessionType
} from '../shared/domain.js'

export interface CreateProjectInput {
  rootPath: string
  confirmedCanonicalRootPath?: string
  name?: string
  contentStrategy?: ContentStrategy
  confirmed: boolean
}

export interface SyncCodexInput {
  contentStrategy: ContentStrategy
  fullContentConfirmed?: boolean
}

export interface ProjectServiceOptions {
  now?: () => Date
  projectDataRoot?: string
}

export class ProjectService {
  private readonly now: () => Date
  private readonly projectDataRoot?: string

  constructor(
    private readonly database: SeePalDatabase,
    private readonly git: GitAdapter,
    private readonly codex: CodexAdapter,
    options: ProjectServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date())
    this.projectDataRoot = options.projectDataRoot
  }

  async inspectProject(rootPath: string): Promise<ProjectScope> {
    if (!rootPath.trim()) throw new Error('请选择一个项目目录。')
    return this.git.inspectProject(rootPath)
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    if (!input.confirmed) throw new Error('需要确认读取范围后才能添加项目。')
    const strategy = input.contentStrategy ?? 'minimal'
    if (!isContentStrategy(strategy)) throw new Error('不支持的内容读取策略。')

    const scope = await this.inspectProject(input.rootPath)
    if (!scope.isGitRepository) throw new Error(scope.warnings[0] ?? '所选目录不是 Git 项目。')
    if (
      input.confirmedCanonicalRootPath &&
      resolve(input.confirmedCanonicalRootPath) !== scope.canonicalRootPath
    ) {
      throw new Error('项目路径在确认后发生了变化，请重新选择并确认读取范围。')
    }
    if (this.database.getProjectByCanonicalPath(scope.canonicalRootPath)) {
      throw new Error('这个仓库已经添加到 SeePal。')
    }

    const timestamp = this.now().toISOString()
    return this.database.createProject({
      id: randomUUID(),
      name: input.name?.trim() || basename(scope.canonicalRootPath),
      rootPath: scope.rootPath,
      canonicalRootPath: scope.canonicalRootPath,
      contentStrategy: strategy,
      createdAt: timestamp,
      updatedAt: timestamp,
      syncStatus: 'never'
    })
  }

  getProject(projectId: string): Project {
    const project = this.database.getProject(projectId)
    if (!project) throw new Error('项目不存在。')
    return project
  }

  listProjects(): ProjectSummary[] {
    return this.database.listProjects().map((project) => {
      const sessions = this.database.listSessions(project.id)
      const evidence = this.database.listEvidence(project.id)
      const assessments = sessions.map((session) =>
        assessSession(session, evidence, { now: this.now() })
      )
      return {
        ...project,
        sessionCount: sessions.length,
        needsAttentionCount: assessments.filter(
          (assessment) => assessment.group === 'needs-attention'
        ).length
      }
    })
  }

  async previewCodex(projectId: string): Promise<CodexDiscovery> {
    const project = this.getProject(projectId)
    const scope = await this.git.inspectProject(project.canonicalRootPath)
    if (!scope.isGitRepository) throw new Error('项目仓库当前不可读取。')
    return this.codex.discover(project.id, scope)
  }

  async syncCodex(
    projectId: string,
    input: SyncCodexInput
  ): Promise<CodexSyncResult> {
    if (!isContentStrategy(input.contentStrategy)) {
      throw new Error('不支持的内容读取策略。')
    }
    if (input.contentStrategy === 'full-local' && !input.fullContentConfirmed) {
      throw new Error('读取完整 Session 内容前需要明确确认。')
    }

    let project = this.getProject(projectId)
    const startedAt = this.now().toISOString()
    project = this.database.updateProject({
      ...project,
      contentStrategy: input.contentStrategy,
      syncStatus: 'syncing',
      syncMessage: '正在读取 Codex Session。',
      updatedAt: startedAt
    })

    try {
      const scope = await this.git.inspectProject(project.canonicalRootPath)
      if (!scope.isGitRepository) {
        throw new Error('项目仓库当前不可读取。')
      }

      const result = await this.codex.sync(project.id, scope, input.contentStrategy)
      for (const session of result.sessions) this.database.upsertSession(session)
      for (const fact of result.evidence) this.database.insertEvidence(fact)

      if (result.sessions.length > 0) {
        try {
          const gitRead = await this.git.collectSessionEvidence(
            project,
            result.sessions,
            this.now().toISOString()
          )
          for (const fact of gitRead.value) {
            this.database.insertEvidence(fact)
            result.evidence.push(fact)
          }
        } catch (error) {
          result.failures.push({
            stage: 'persist',
            message:
              error instanceof Error
                ? `Git 状态读取失败：${error.message}`
                : 'Git 状态读取失败。'
          })
          result.compatibility = {
            ...result.compatibility,
            status: 'degraded',
            message: 'Codex 数据已保留，但 Git 状态读取不完整。'
          }
          if (result.coverage) {
            result.coverage = {
              ...result.coverage,
              isComplete: false,
              note: 'Codex Session 已同步，但部分 Git 状态缺失。'
            }
          }
        }
      }

      const completedAt = this.now().toISOString()
      const status =
        result.failures.length === 0
          ? 'complete'
          : result.sessions.length > 0
            ? 'partial'
            : 'failed'
      project = this.database.updateProject({
        ...project,
        syncStatus: status,
        syncMessage:
          status === 'complete'
            ? '同步完成。'
            : status === 'partial'
              ? '同步部分完成；请检查受影响范围。'
              : '未能读取 Codex Session。请确认 Codex 0.139 可用后重试。',
        coverage: result.coverage,
        lastSuccessfulSyncAt: status === 'complete' ? completedAt : project.lastSuccessfulSyncAt,
        updatedAt: completedAt
      })
      this.database.recordSyncRun(
        project.id,
        startedAt,
        completedAt,
        status,
        result.coverage,
        result.failures
      )
      return result
    } catch (error) {
      const failedAt = this.now().toISOString()
      const message = error instanceof Error ? error.message : '同步发生未知错误。'
      try {
        const current = this.database.getProject(projectId) ?? project
        this.database.updateProject({
          ...current,
          syncStatus: 'failed',
          syncMessage: `${message} 请确认项目仍可读取，并检查 Codex 0.139 后重试。`,
          updatedAt: failedAt
        })
        this.database.recordSyncRun(
          projectId,
          startedAt,
          failedAt,
          'failed',
          current.coverage,
          [{ stage: 'persist', message }]
        )
      } catch {
        // Preserve the original failure if local failure recording is unavailable.
      }
      throw error
    }
  }

  getConsole(projectId: string, filters: ConsoleFilters = {}): ProjectConsole {
    const project = this.getProject(projectId)
    const evidence = this.database.listEvidence(projectId)
    const sessions = this.database
      .listSessions(projectId)
      .map((session) => assessSession(session, evidence, { now: this.now() }))
      .filter(
        (assessment) =>
          (!filters.groups || filters.groups.includes(assessment.group)) &&
          (!filters.types || filters.types.includes(assessment.session.primaryType))
      )
    return { project, sessions, generatedAt: this.now().toISOString() }
  }

  getSession(projectId: string, sessionId: string): SessionAssessment {
    const session = this.database.getSession(projectId, sessionId)
    if (!session) throw new Error('Session 不存在或不属于当前项目。')
    return assessSession(session, this.database.listEvidence(projectId, sessionId), {
      now: this.now()
    })
  }

  setSessionType(
    projectId: string,
    sessionId: string,
    sessionType: SessionType
  ): SessionAssessment {
    if (!isSessionType(sessionType)) throw new Error('不支持的 Session 类型。')
    if (!this.database.getSession(projectId, sessionId)) {
      throw new Error('Session 不存在或不属于当前项目。')
    }
    this.database.addTypeCorrection(
      projectId,
      sessionId,
      sessionType,
      this.now().toISOString()
    )
    return this.getSession(projectId, sessionId)
  }

  async deleteProject(projectId: string): Promise<DeleteProjectResult> {
    this.getProject(projectId)
    const failedArtifacts: string[] = []
    if (this.projectDataRoot) {
      const root = resolve(this.projectDataRoot)
      const target = resolve(root, projectId)
      if (!target.startsWith(`${root}${sep}`)) {
        throw new Error('拒绝清理项目数据：目标超出 SeePal 数据目录。')
      }
      try {
        await rm(target, { recursive: true, force: true })
      } catch {
        failedArtifacts.push('cache, temporary files, or logs')
      }
    }

    const result = this.database.deleteProject(projectId)
    return {
      ...result,
      deleted: result.deleted && failedArtifacts.length === 0,
      remaining: [...result.remaining, ...failedArtifacts]
    }
  }
}
