import type { WebLensService } from '../services/mockWebLensService'
import { mockWebLensService } from '../services/mockWebLensService'
import { backendWebLensService } from './webLensApiService'

export const isBackendMode = import.meta.env.VITE_API_MODE === 'backend'
export const webLensService: WebLensService = isBackendMode ? backendWebLensService : mockWebLensService
