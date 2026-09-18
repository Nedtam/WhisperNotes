import type { WhisperNotesApi } from '../../shared/types'

declare global {
  interface Window {
    api: WhisperNotesApi
  }
}

export {}
