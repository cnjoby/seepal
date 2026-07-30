import type { SeePalApi } from '../shared/ipc'

declare global {
  interface Window {
    seepal: SeePalApi
  }
}

export {}
