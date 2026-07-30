import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { AiConfigStore } from '../../src/main/ai-config-store.js'
import type { AiProviderClient } from '../../src/main/ai-provider.js'
import type { GitAdapter } from '../../src/main/git-adapter.js'
import type { ProjectService } from '../../src/main/project-service.js'
import type { ProjectAiScanService } from '../../src/main/project-ai-scan-service.js'
import { IPC_CHANNELS } from '../../src/shared/ipc.js'

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>
  >(),
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    removeHandler: vi.fn((channel: string) => {
      electronMocks.handlers.delete(channel)
    }),
    handle: vi.fn(
      (
        channel: string,
        handler: (
          event: IpcMainInvokeEvent,
          ...args: unknown[]
        ) => Promise<unknown>,
      ) => {
        electronMocks.handlers.set(channel, handler)
      },
    ),
  },
}))

import { registerIpcHandlers } from '../../src/main/ipc.js'

function trustedEvent(url: string): IpcMainInvokeEvent {
  const frame = { url } as IpcMainInvokeEvent['senderFrame']
  Object.assign(frame!, { top: frame })
  return { senderFrame: frame } as IpcMainInvokeEvent
}

describe('AI IPC handlers', () => {
  const allowedRendererUrl = 'file:///Applications/SeePal/out/renderer/index.html'
  const publicConfig = {
    protocol: 'openai' as const,
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    hasApiKey: true,
  }
  const aiConfig = {
    getPublicConfig: vi.fn(async () => publicConfig),
    save: vi.fn(async () => publicConfig),
    clearApiKey: vi.fn(async () => ({ ...publicConfig, hasApiKey: false })),
  }
  const aiProvider = {
    testConnection: vi.fn(async () => ({
      text: 'OK',
      model: publicConfig.model,
      latencyMs: 12,
    })),
  }
  const idleScan = {
    status: 'idle' as const,
    total: 0,
    succeeded: 0,
    reused: 0,
    failed: 0,
    stale: 0,
    unknown: 0,
    pending: 0,
    items: [],
    interpretations: {},
  }
  const aiScan = {
    prepare: vi.fn(async (projectId: string) => ({
      id: 'preparation-1',
      projectId,
      projectName: 'SeePal',
      sessionCount: 1,
      cachedCount: 0,
      requestCount: 1,
      providerHost: 'api.deepseek.com',
      model: 'deepseek-v4-flash',
      hasApiKey: true,
      expiresAt: '2026-07-30T12:00:00.000Z',
    })),
    start: vi.fn(async () => idleScan),
    status: vi.fn(() => idleScan),
    cancel: vi.fn(() => idleScan),
    resume: vi.fn(() => idleScan),
    retryFailures: vi.fn(() => idleScan),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    electronMocks.handlers.clear()
    registerIpcHandlers({
      service: {} as ProjectService,
      git: {} as GitAdapter,
      aiConfig: aiConfig as unknown as AiConfigStore,
      aiProvider: aiProvider as unknown as AiProviderClient,
      aiScan: aiScan as unknown as ProjectAiScanService,
      allowedRendererUrl,
    })
  })

  it('returns only the public config and accepts a blank key as preserve', async () => {
    const event = trustedEvent(allowedRendererUrl)
    const getHandler = electronMocks.handlers.get(IPC_CHANNELS.getAiConfig)!
    const saveHandler = electronMocks.handlers.get(IPC_CHANNELS.saveAiConfig)!

    await expect(getHandler(event)).resolves.toEqual(publicConfig)
    await saveHandler(event, {
      protocol: 'openai',
      baseUrl: publicConfig.baseUrl,
      model: publicConfig.model,
      apiKey: '',
    })

    expect(aiConfig.save).toHaveBeenCalledWith({
      protocol: 'openai',
      baseUrl: publicConfig.baseUrl,
      model: publicConfig.model,
      apiKey: '',
    })
  })

  it('rejects an untrusted renderer and maps connection failures', async () => {
    const getHandler = electronMocks.handlers.get(IPC_CHANNELS.getAiConfig)!
    await expect(
      getHandler(trustedEvent('file:///tmp/untrusted.html')),
    ).rejects.toThrow('Untrusted IPC sender')

    aiProvider.testConnection.mockRejectedValueOnce(
      new Error('无法连接模型服务，请检查 Base URL 和网络。'),
    )
    const testHandler = electronMocks.handlers.get(
      IPC_CHANNELS.testAiConnection,
    )!
    await expect(
      testHandler(trustedEvent(allowedRendererUrl)),
    ).resolves.toEqual({
      ok: false,
      message: '无法连接模型服务，请检查 Base URL 和网络。',
    })
  })

  it('exposes the explicit prepare/start/status/cancel/resume/retry scan contract', async () => {
    const event = trustedEvent(allowedRendererUrl)
    await electronMocks.handlers.get(IPC_CHANNELS.prepareAiScan)!(event, 'project-1')
    await electronMocks.handlers.get(IPC_CHANNELS.startAiScan)!(event, {
      preparationId: 'preparation-1',
      localReadConfirmed: true,
      remoteSendConfirmed: true,
    })
    await electronMocks.handlers.get(IPC_CHANNELS.getAiScanStatus)!(event, 'project-1')
    await electronMocks.handlers.get(IPC_CHANNELS.cancelAiScan)!(event, 'project-1')
    await electronMocks.handlers.get(IPC_CHANNELS.resumeAiScan)!(event, 'project-1')
    await electronMocks.handlers.get(IPC_CHANNELS.retryAiScanFailures)!(event, 'project-1')

    expect(aiScan.prepare).toHaveBeenCalledWith('project-1')
    expect(aiScan.start).toHaveBeenCalledWith({
      preparationId: 'preparation-1',
      localReadConfirmed: true,
      remoteSendConfirmed: true,
    })
    expect(aiScan.status).toHaveBeenCalledWith('project-1')
    expect(aiScan.cancel).toHaveBeenCalledWith('project-1')
    expect(aiScan.resume).toHaveBeenCalledWith('project-1')
    expect(aiScan.retryFailures).toHaveBeenCalledWith('project-1')
  })
})
