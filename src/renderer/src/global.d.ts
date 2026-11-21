import type { TixingApi } from '../../shared/api'

declare global {
  interface Window {
    tixing: TixingApi
  }
}

export {}
