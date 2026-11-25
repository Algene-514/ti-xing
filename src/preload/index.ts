import { contextBridge, ipcRenderer } from 'electron'
import type { TixingApi } from '../shared/api'

const api: TixingApi = {
  list: (filter, q, tag) => ipcRenderer.invoke('db:list', filter, q, tag ?? null),
  get: (id) => ipcRenderer.invoke('db:get', id),
  create: (input) => ipcRenderer.invoke('db:create', input),
  update: (id, input) => ipcRenderer.invoke('db:update', id, input),
  remove: (id) => ipcRenderer.invoke('db:remove', id),
  importFiles: (files) => ipcRenderer.invoke('db:import', files),
  tags: () => ipcRenderer.invoke('db:tags'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  status: () => ipcRenderer.invoke('app:status'),
  startQuizNow: () => ipcRenderer.invoke('quiz:start-now'),
  getBatch: () => ipcRenderer.invoke('quiz:get-batch'),
  rate: (id, rating) => ipcRenderer.invoke('quiz:rate', id, rating),
  done: () => ipcRenderer.invoke('quiz:done'),
  skip: (id) => ipcRenderer.invoke('quiz:skip', id),
  snooze: (id) => ipcRenderer.invoke('quiz:snooze', id),
  snoozeState: () => ipcRenderer.invoke('quiz:snooze-state'),
  prenudgeSkip: async () => {
    await ipcRenderer.invoke('prenudge:skip')
  },
  backup: () => ipcRenderer.invoke('app:backup'),
  restore: () => ipcRenderer.invoke('app:restore'),
  quit: async () => {
    await ipcRenderer.invoke('app:quit')
  }
}

contextBridge.exposeInMainWorld('tixing', api)
