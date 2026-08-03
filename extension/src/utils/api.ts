import { storage } from './storage'
import { supabase } from './supabase'
import { API_BASE_URL, STORAGE_KEYS, SUPABASE_URL } from './constants'

function getSupabaseProjectRef(url: string): string | null {
  try {
    return new URL(url).hostname.split('.')[0] || null
  } catch {
    return null
  }
}

const SUPABASE_PROJECT_REF = getSupabaseProjectRef(SUPABASE_URL)
const SUPABASE_AUTH_STORAGE_KEY = SUPABASE_PROJECT_REF
  ? `sb-${SUPABASE_PROJECT_REF}-auth-token`
  : null

function decodeJwtPayload(token: string): { exp?: number; iss?: string } | null {
  try {
    const [, payload] = token.split('.')
    if (!payload) return null

    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    return JSON.parse(atob(padded))
  } catch {
    return null
  }
}

function isUsableJwt(token: string | null | undefined): token is string {
  if (!token) return false

  const payload = decodeJwtPayload(token)
  if (!payload) return false

  // Reject tokens from a different Supabase project if issuer is present.
  if (payload.iss && !payload.iss.startsWith(`${SUPABASE_URL}/auth/v1`)) return false

  if (!payload?.exp) return true

  // Leave a small buffer so requests do not race token expiry.
  return payload.exp > Math.floor(Date.now() / 1000) + 30
}

function extractAccessToken(value: unknown): string | null {
  try {
    const session = typeof value === 'string' ? JSON.parse(value) : value
    const accessToken =
      session?.currentSession?.access_token ||
      session?.session?.access_token ||
      session?.access_token

    return isUsableJwt(accessToken) ? accessToken : null
  } catch {
    return null
  }
}

async function getStoredAuthToken(): Promise<string | null> {
  // Fast path: token explicitly synced by sidepanel/popup.
  const cachedToken = await storage.get<string>(STORAGE_KEYS.AUTH_TOKEN)
  if (isUsableJwt(cachedToken)) return cachedToken

  const allStorage = await new Promise<Record<string, unknown>>((resolve) =>
    chrome.storage.local.get(null, (result) => resolve(result))
  )

  // Prefer the exact Supabase storage key for this project.
  if (SUPABASE_AUTH_STORAGE_KEY) {
    const scopedToken = extractAccessToken(allStorage[SUPABASE_AUTH_STORAGE_KEY])
    if (scopedToken) {
      await storage.set(STORAGE_KEYS.AUTH_TOKEN, scopedToken)
      return scopedToken
    }
  }

  for (const [key, value] of Object.entries(allStorage)) {
    if (!key.endsWith('-auth-token')) continue

    const accessToken = extractAccessToken(value)
    if (accessToken) {
      await storage.set(STORAGE_KEYS.AUTH_TOKEN, accessToken)
      return accessToken
    }
  }

  const { data } = await supabase.auth.getSession()
  if (isUsableJwt(data.session?.access_token)) {
    await storage.set(STORAGE_KEYS.AUTH_TOKEN, data.session.access_token)
    return data.session.access_token
  }

  return null
}

export async function syncAuthToken(accessToken: string | null | undefined): Promise<void> {
  if (isUsableJwt(accessToken)) {
    await storage.set(STORAGE_KEYS.AUTH_TOKEN, accessToken)
    return
  }
  await storage.remove(STORAGE_KEYS.AUTH_TOKEN)
}

async function refreshStoredAuthToken(): Promise<string | null> {
  const existingToken = await storage.get<string>(STORAGE_KEYS.AUTH_TOKEN)
  const { data, error } = await supabase.auth.refreshSession()
  if (error || !isUsableJwt(data.session?.access_token)) {
    return isUsableJwt(existingToken) ? existingToken : null
  }

  await storage.set(STORAGE_KEYS.AUTH_TOKEN, data.session.access_token)
  return data.session.access_token
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  let token = await getStoredAuthToken()
  if (!token) {
    token = await refreshStoredAuthToken()
  }
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = await getAuthHeaders()
  let res: Response
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers: { ...headers, ...options.headers },
    })
  } catch {
    throw new Error(
      `Cannot reach EchoWrite backend at ${API_BASE_URL}. ` +
        'Start the backend (port 8000) and reload the extension.'
    )
  }

  if (res.status === 401) {
    const refreshedToken = await refreshStoredAuthToken()
    if (refreshedToken) {
      try {
        res = await fetch(`${API_BASE_URL}${path}`, {
          ...options,
          headers: {
            ...headers,
            ...options.headers,
            Authorization: `Bearer ${refreshedToken}`,
          },
        })
      } catch {
        throw new Error(
          `Cannot reach EchoWrite backend at ${API_BASE_URL}. ` +
            'Start the backend (port 8000) and reload the extension.'
        )
      }
    }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    const detail = err.detail || err.message || res.statusText || 'API error'
    if (res.status === 401) {
      throw new Error('Please sign in again from the EchoWrite side panel.')
    }
    if (res.status === 404) {
      throw new Error(
        `Backend route not found (${path}). Make sure the EchoWrite API is running on ${API_BASE_URL}, not another app.`
      )
    }
    if (res.status === 503) {
      throw new Error(detail)
    }
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
  return res.json()
}

/* ─── Writing ─── */
export const writeAPI = {
  rewrite: (text: string, tone: string, toneProfileId?: string) =>
    apiFetch<{ result: string }>('/write/rewrite', {
      method: 'POST',
      body: JSON.stringify({ text, tone, tone_profile_id: toneProfileId }),
    }),
  summarize: (text: string) =>
    apiFetch<{ result: string }>('/write/summarize', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  expand: (text: string, context?: string, toneProfileId?: string) =>
    apiFetch<{ result: string }>('/write/expand', {
      method: 'POST',
      body: JSON.stringify({ text, context, tone_profile_id: toneProfileId }),
    }),
}

/* ─── Tone ─── */
export const toneAPI = {
  analyze: (text: string) =>
    apiFetch<{ blueprint_preview: object; features: object }>('/tone/analyze', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  train: (text: string, profileId?: string | null, source = 'unknown') =>
    apiFetch<{
      success: boolean
      profile_id: string
      profile_name?: string
      samples_count: number
      blueprint: object
      features: object
      learned_habits?: string[]
    }>('/tone/train', {
      method: 'POST',
      body: JSON.stringify({ text, profile_id: profileId || null, source_platform: source }),
    }),
  addHabit: (prefer: string, insteadOf: string, profileId?: string | null) =>
    apiFetch<{
      success: boolean
      profile_id: string
      profile_name?: string
      blueprint: object
      learned_habits?: string[]
    }>('/tone/habits', {
      method: 'POST',
      body: JSON.stringify({
        prefer,
        instead_of: insteadOf,
        profile_id: profileId || null,
      }),
    }),
  getProfiles: () =>
    apiFetch<{ profiles: ToneProfile[] }>('/tone/profiles'),
  createProfile: (name: string) =>
    apiFetch<{ profile: ToneProfile }>('/tone/profiles', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  activateProfile: (id: string) =>
    apiFetch<{ success: boolean }>(`/tone/profiles/${id}/activate`, { method: 'PUT' }),
  deleteProfile: (id: string) =>
    apiFetch<{ success: boolean }>(`/tone/profiles/${id}`, { method: 'DELETE' }),
}

/* ─── Memory ─── */
export const memoryAPI = {
  store: (content: string, source: string, tags?: string[]) =>
    apiFetch<{ id: string }>('/memory/store', {
      method: 'POST',
      body: JSON.stringify({ content, source_platform: source, tags }),
    }),
  recall: (query: string, limit = 5) =>
    apiFetch<{ memories: MemoryEntry[] }>('/memory/recall', {
      method: 'POST',
      body: JSON.stringify({ query, limit }),
    }),
  list: (page = 0, size = 20) =>
    apiFetch<{ memories: MemoryEntry[]; total: number }>(`/memory/entries?page=${page}&size=${size}`),
  delete: (id: string) =>
    apiFetch<{ success: boolean }>(`/memory/entries/${id}`, { method: 'DELETE' }),
}

/* ─── Migration ─── */
export const migrationAPI = {
  exportContext: () =>
    apiFetch<{ bundle: object }>('/migration/export', { method: 'POST' }),
  injectContext: (platform: string, conversationText: string, sourcePlatform = 'imported') =>
    apiFetch<{ context_prompt: string }>('/migration/sync', {
      method: 'POST',
      body: JSON.stringify({
        platform,
        conversation_text: conversationText,
        source_platform: sourcePlatform,
      }),
    }),
  saveSession: (platform: string, conversationText: string, title?: string) =>
    apiFetch<{ id: string; success: boolean; platform: string; chars: number }>('/migration/session', {
      method: 'POST',
      body: JSON.stringify({
        platform,
        conversation_text: conversationText,
        title: title || undefined,
      }),
    }),
  getSession: () =>
    apiFetch<{ session: MemoryEntry | null }>('/migration/session'),
  history: () =>
    apiFetch<{
      migrations: Array<{
        id: string
        source_platform: string
        target_platform: string
        original_text?: string
        processed_summary?: string
        context_prompt?: string
        created_at: string
      }>
    }>('/migration/history'),
}

/* ─── Billing ─── */
export const billingAPI = {
  createCheckout: (plan: string) =>
    apiFetch<{ checkout_url: string }>('/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ plan }),
    }),
  getSubscription: () =>
    apiFetch<{ plan: string; status: string; period_end: string }>('/billing/subscription'),
  createPortal: () =>
    apiFetch<{ portal_url: string }>('/billing/portal', { method: 'POST' }),
}

/* ─── Profile / Preferences ─── */
export const profileAPI = {
  me: () => apiFetch<UserProfile>('/profile/me'),
  updatePreferences: (preferences: Partial<UserPreferences>) =>
    apiFetch<UserProfile>('/profile/preferences', {
      method: 'PATCH',
      body: JSON.stringify(preferences),
    }),
}

/* ─── Types ─── */
export type UserPreferences = {
  default_tone: string
  default_llm: string
  auto_inject_context: boolean
  show_floating_toolbar: boolean
}

export type PlanLimits = {
  rewrites: number
  memories: number
  tone_profiles: number
}

export type UserProfile = {
  id: string
  email?: string
  full_name?: string
  avatar_url?: string
  plan: 'free' | 'pro' | 'team' | string
  subscription_status?: string
  current_period_end?: string | null
  rewrites_used: number
  summarizes_used: number
  expands_used: number
  memories_count: number
  preferences: UserPreferences
  limits: PlanLimits
}

export type ToneProfile = {
  id: string
  name: string
  is_active: boolean
  samples_count: number
  created_at: string
  updated_at?: string
  blueprint: {
    tone: string
    formality: string
    key_phrases: string[]
    voice?: string
    vocabulary_level?: string
    confidence_score?: number
    avg_sentence_length?: number
    formality_score?: number
    active_voice_ratio?: number
    vocabulary_richness?: number
    emoji_usage?: string
    contraction_rate?: number
    writing_rules?: string[]
    lexical_habits?: Array<{
      prefer: string
      instead_of: string
      strength?: number
      informal_count?: number
      formal_count?: number
    }>
  }
}

export type MemoryEntry = {
  id: string
  content: string
  source_platform: string
  tags: string[]
  created_at: string
  importance_score?: number
  access_count?: number
  relevance_score?: number
}
