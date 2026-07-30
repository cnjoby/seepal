import { basename } from 'node:path'
import {
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
} from 'electron'
import { GitAdapter } from './git-adapter.js'
import { ProjectService } from './project-service.js'
import {
  IPC_CHANNELS,
  UI_SESSION_TYPES,
  type ContentPolicy,
  type ProjectInspectionDto,
  type UiSessionType,
} from '../shared/ipc.js'
import { fromUiTypeMap, toDashboard, toProjectSummary, toSessionView } from './view-model.js'
import {
  isTrustedRendererUrl,
  requireAbsolutePath,
  requireRecord,
  requireString,
} from './validation.js'

export interface IpcDependencies {
  service: ProjectService
  git: GitAdapter
  allowedRendererUrl: string
  chooseDirectory?: () => Promise<string | null>
}

function assertTrustedSender(
  event: IpcMainInvokeEvent,
  allowedRendererUrl: string,
): void {
  const senderFrame = event.senderFrame
  if (
    !senderFrame ||
    senderFrame !== senderFrame.top ||
    !isTrustedRendererUrl(senderFrame.url, allowedRendererUrl)
  ) {
    throw new Error('Untrusted IPC sender')
  }
}

function policyToDomain(policy: unknown): 'minimal' | 'full-local' {
  if (policy === 'metadata') return 'minimal'
  if (policy === 'full-local') return 'full-local'
  throw new TypeError('contentPolicy is invalid')
}

function requireUiType(value: unknown): UiSessionType {
  if (
    typeof value !== 'string' ||
    !(UI_SESSION_TYPES as readonly string[]).includes(value)
  ) {
    throw new TypeError('type is invalid')
  }
  return value as UiSessionType
}

async function defaultChooseDirectory(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: '选择本地 Git 项目',
    properties: ['openDirectory'],
  })
  return result.canceled ? null : result.filePaths[0] ?? null
}

export function registerIpcHandlers({
  service,
  git,
  allowedRendererUrl,
  chooseDirectory = defaultChooseDirectory,
}: IpcDependencies): void {
  const handle = (
    channel: string,
    handler: (...args: unknown[]) => unknown | Promise<unknown>,
  ): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrustedSender(event, allowedRendererUrl)
      return handler(...args)
    })
  }

  handle(IPC_CHANNELS.selectDirectory, () => chooseDirectory())

  handle(IPC_CHANNELS.inspectProject, async (rawPath) => {
    const path = requireAbsolutePath(rawPath)
    const scope = await git.inspectProject(path)
    const duplicate = service
      .listProjects()
      .find((project) => project.canonicalRootPath === scope.canonicalRootPath)
    const inspection: ProjectInspectionDto = {
      path: scope.rootPath,
      name: basename(scope.canonicalRootPath),
      valid: scope.isGitRepository,
      duplicateProjectId: duplicate?.id,
      reason: scope.isGitRepository ? undefined : scope.warnings.join(' '),
      repositoryRoot: scope.canonicalRootPath,
      worktrees: scope.worktrees.map((worktree) => ({
        path: worktree,
        included: true,
      })),
      submodules: scope.submodules.map((submodule) => ({
        path: submodule,
        included: false,
      })),
      linkedPaths: scope.symbolicLinks.map((linkedPath) => ({
        path: linkedPath,
        included: false,
      })),
      codex: {
        status: 'not-found',
        attributionBasis: '确认内容策略后，才会按仓库与 Worktree 的精确工作目录读取 Codex 历史。',
      },
    }
    return inspection
  })

  handle(IPC_CHANNELS.addProject, async (rawInput) => {
    const input = requireRecord(rawInput)
    const project = await service.createProject({
      rootPath: requireAbsolutePath(input.path),
      confirmedCanonicalRootPath: requireAbsolutePath(input.confirmedRepositoryRoot),
      contentStrategy: policyToDomain(input.contentPolicy),
      confirmed: true,
    })
    return toProjectSummary(project)
  })

  handle(IPC_CHANNELS.listProjects, () =>
    service.listProjects().map((project) => toProjectSummary(project)),
  )

  handle(IPC_CHANNELS.getProjectDashboard, (rawProjectId) => {
    const projectId = requireString(rawProjectId, 'projectId')
    return toDashboard(service.getConsole(projectId))
  })

  handle(IPC_CHANNELS.syncCodex, async (rawInput) => {
    const input = requireRecord(rawInput)
    const projectId = requireString(input.projectId, 'projectId')
    const contentPolicy = requireString(
      input.contentPolicy,
      'contentPolicy',
    ) as ContentPolicy
    const strategy = policyToDomain(contentPolicy)
    await service.syncCodex(projectId, {
      contentStrategy: strategy,
      fullContentConfirmed: strategy === 'full-local',
    })
    return toDashboard(service.getConsole(projectId))
  })

  handle(IPC_CHANNELS.updateSessionType, async (rawInput) => {
    const input = requireRecord(rawInput)
    const projectId = requireString(input.projectId, 'projectId')
    const sessionId = requireString(input.sessionId, 'sessionId')
    const uiType = requireUiType(input.type)
    const assessment = await service.setSessionType(
      projectId,
      sessionId,
      fromUiTypeMap[uiType],
    )
    return toSessionView(assessment)
  })

  handle(IPC_CHANNELS.deleteProject, async (rawProjectId) => {
    const projectId = requireString(rawProjectId, 'projectId')
    const result = await service.deleteProject(projectId)
    return {
      success: result.deleted && result.remaining.length === 0,
      remainingCategories: result.remaining,
      message:
        result.remaining.length > 0
          ? `仍有本地数据未清理：${result.remaining.join('、')}`
          : 'SeePal 本地副本已删除，原项目和 Codex Session 未被修改。',
    }
  })
}
