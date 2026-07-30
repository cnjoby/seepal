import { basename } from 'node:path'
import {
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
} from 'electron'
import { GitAdapter } from './git-adapter.js'
import { AiConfigStore } from './ai-config-store.js'
import { AiProviderClient } from './ai-provider.js'
import { ProjectService } from './project-service.js'
import { ProjectAiScanService } from './project-ai-scan-service.js'
import {
  IPC_CHANNELS,
  UI_SESSION_TYPES,
  type ContentPolicy,
  type AiConfigInput,
  type AiProtocol,
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
  aiConfig: AiConfigStore
  aiProvider: AiProviderClient
  aiScan?: ProjectAiScanService
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

function requireAiProtocol(value: unknown): AiProtocol {
  if (value === 'openai' || value === 'anthropic') return value
  throw new TypeError('AI 协议无效。')
}

function optionalApiKey(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 10_000) {
    throw new TypeError('apiKey is invalid')
  }
  return value
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
  aiConfig,
  aiProvider,
  aiScan,
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
    return toDashboard(
      service.getConsole(projectId),
      aiScan?.status(projectId).interpretations,
    )
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
    return toDashboard(
      service.getConsole(projectId),
      aiScan?.status(projectId).interpretations,
    )
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
    aiScan?.cancel(projectId)
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

  handle(IPC_CHANNELS.getAiConfig, () => aiConfig.getPublicConfig())

  handle(IPC_CHANNELS.saveAiConfig, (rawInput) => {
    const input = requireRecord(rawInput)
    const config: AiConfigInput = {
      protocol: requireAiProtocol(input.protocol),
      baseUrl: requireString(input.baseUrl, 'baseUrl'),
      model: requireString(input.model, 'model'),
      apiKey: optionalApiKey(input.apiKey),
    }
    return aiConfig.save(config)
  })

  handle(IPC_CHANNELS.clearAiApiKey, () => aiConfig.clearApiKey())

  handle(IPC_CHANNELS.testAiConnection, async () => {
    try {
      const result = await aiProvider.testConnection()
      return {
        ok: true,
        message: '连接成功。',
        model: result.model,
        latencyMs: result.latencyMs,
      }
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : '连接模型服务失败，请检查配置。',
      }
    }
  })

  if (aiScan) {
    handle(IPC_CHANNELS.prepareAiScan, (rawProjectId) =>
      aiScan.prepare(requireString(rawProjectId, 'projectId')),
    )

    handle(IPC_CHANNELS.startAiScan, (rawInput) => {
      const input = requireRecord(rawInput)
      return aiScan.start({
        preparationId: requireString(input.preparationId, 'preparationId'),
        localReadConfirmed: input.localReadConfirmed === true,
        remoteSendConfirmed: input.remoteSendConfirmed === true,
      })
    })

    handle(IPC_CHANNELS.getAiScanStatus, (rawProjectId) =>
      aiScan.status(requireString(rawProjectId, 'projectId')),
    )

    handle(IPC_CHANNELS.cancelAiScan, (rawProjectId) =>
      aiScan.cancel(requireString(rawProjectId, 'projectId')),
    )

    handle(IPC_CHANNELS.resumeAiScan, (rawProjectId) =>
      aiScan.resume(requireString(rawProjectId, 'projectId')),
    )

    handle(IPC_CHANNELS.retryAiScanFailures, (rawProjectId) =>
      aiScan.retryFailures(requireString(rawProjectId, 'projectId')),
    )
  }
}
