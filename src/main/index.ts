import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, safeStorage } from 'electron'
import { AiConfigStore } from './ai-config-store.js'
import { AiProviderClient } from './ai-provider.js'
import { CodexAdapter } from './codex-adapter.js'
import { SeePalDatabase } from './database.js'
import { GitAdapter } from './git-adapter.js'
import { registerIpcHandlers } from './ipc.js'
import { ProjectService } from './project-service.js'
import { ProjectAiScanService } from './project-ai-scan-service.js'

const currentDirectory = fileURLToPath(new URL('.', import.meta.url))
let database: SeePalDatabase | undefined
let codex: CodexAdapter | undefined
let mainWindow: BrowserWindow | undefined

function rendererEntry(): string {
  return join(currentDirectory, '../renderer/index.html')
}

function createWindow(): void {
  const preload = join(currentDirectory, '../preload/index.js')
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: 'SeePal',
    backgroundColor: '#eef1f4',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  const developmentUrl = process.env.ELECTRON_RENDERER_URL
  if (developmentUrl) {
    void mainWindow.loadURL(developmentUrl)
  } else {
    void mainWindow.loadFile(rendererEntry())
  }

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const allowed = developmentUrl
      ? new URL(targetUrl).origin === new URL(developmentUrl).origin
      : targetUrl === new URL(`file://${rendererEntry()}`).href
    if (!allowed) event.preventDefault()
  })
  mainWindow.on('closed', () => {
    mainWindow = undefined
  })
}

app.whenReady().then(() => {
  database = new SeePalDatabase(join(app.getPath('userData'), 'seepal.sqlite'))
  database.markInterruptedSyncsFailed(new Date().toISOString())
  database.markInterruptedAiScansUnknown(new Date().toISOString())
  const git = new GitAdapter()
  codex = new CodexAdapter()
  const service = new ProjectService(database, git, codex)
  const aiConfig = new AiConfigStore(
    join(app.getPath('userData'), 'ai-provider.json'),
    {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) =>
        safeStorage.encryptString(value).toString('base64'),
      decrypt: (value) =>
        safeStorage.decryptString(Buffer.from(value, 'base64')),
    },
  )
  const aiProvider = new AiProviderClient(aiConfig)
  const aiScan = new ProjectAiScanService(
    database,
    git,
    codex,
    aiConfig,
    aiProvider,
  )
  const developmentUrl = process.env.ELECTRON_RENDERER_URL
  const allowedRendererUrl = developmentUrl ?? new URL(`file://${rendererEntry()}`).href
  registerIpcHandlers({
    service,
    git,
    aiConfig,
    aiProvider,
    aiScan,
    allowedRendererUrl,
  })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void codex?.close()
  database?.close()
  codex = undefined
  database = undefined
})
