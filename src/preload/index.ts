import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type SeePalApi } from '../shared/ipc.js'

const api: SeePalApi = {
  listProjects: () => ipcRenderer.invoke(IPC_CHANNELS.listProjects),
  selectDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.selectDirectory),
  inspectProject: (path) =>
    ipcRenderer.invoke(IPC_CHANNELS.inspectProject, path),
  addProject: (input) => ipcRenderer.invoke(IPC_CHANNELS.addProject, input),
  getProjectDashboard: (projectId) =>
    ipcRenderer.invoke(IPC_CHANNELS.getProjectDashboard, projectId),
  syncCodex: (projectId, contentPolicy) =>
    ipcRenderer.invoke(IPC_CHANNELS.syncCodex, {
      projectId,
      contentPolicy,
    }),
  updateSessionType: (projectId, sessionId, type) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateSessionType, {
      projectId,
      sessionId,
      type,
    }),
  deleteProject: (projectId) =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteProject, projectId),
  getAiConfig: () => ipcRenderer.invoke(IPC_CHANNELS.getAiConfig),
  saveAiConfig: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveAiConfig, input),
  clearAiApiKey: () => ipcRenderer.invoke(IPC_CHANNELS.clearAiApiKey),
  testAiConnection: () => ipcRenderer.invoke(IPC_CHANNELS.testAiConnection),
  prepareAiScan: (projectId) =>
    ipcRenderer.invoke(IPC_CHANNELS.prepareAiScan, projectId),
  startAiScan: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.startAiScan, input),
  getAiScanStatus: (projectId) =>
    ipcRenderer.invoke(IPC_CHANNELS.getAiScanStatus, projectId),
  cancelAiScan: (projectId) =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelAiScan, projectId),
  resumeAiScan: (projectId) =>
    ipcRenderer.invoke(IPC_CHANNELS.resumeAiScan, projectId),
  retryAiScanFailures: (projectId) =>
    ipcRenderer.invoke(IPC_CHANNELS.retryAiScanFailures, projectId),
}

contextBridge.exposeInMainWorld('seepal', Object.freeze(api))
