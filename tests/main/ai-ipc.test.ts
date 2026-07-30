import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { AiConfigStore } from '../../src/main/ai-config-store.js'
import type { AiProviderClient } from '../../src/main/ai-provider.js'
import type { GitAdapter } from '../../src/main/git-adapter.js'
import type { ProjectService } from '../../src/main/project-service.js'
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
    getPublicConfig: vi.fn(() => publicConfig),
    save: vi.fn(() => publicConfig),
    clearApiKey: vi.fn(() => ({ ...publicConfig, hasApiKey: false })),
  }
  const aiProvider = {
    testConnection: vi.fn(async () => ({
      text: 'OK',
      model: publicConfig.model,
      latencyMs: 12,
    })),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    electronMocks.handlers.clear()
    registerIpcHandlers({
      service: {} as ProjectService,
      git: {} as GitAdapter,
      aiConfig: aiConfig as unknown as AiConfigStore,
      aiProvider: aiProvider as unknown as AiProviderClient,
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
})
