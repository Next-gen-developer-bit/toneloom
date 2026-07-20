import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './constants'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    storage: {
      getItem: (key: string) =>
        new Promise((resolve) =>
          chrome.storage.local.get(key, (result: Record<string, unknown>) => resolve((result[key] as string) ?? null))
        ),
      setItem: (key: string, value: string) =>
        new Promise((resolve) =>
          chrome.storage.local.set({ [key]: value }, () => resolve())
        ),
      removeItem: (key: string) =>
        new Promise((resolve) =>
          chrome.storage.local.remove(key, () => resolve())
        ),
    },
  },
})

export type SupabaseUser = {
  id: string
  email: string
  full_name?: string
  avatar_url?: string
  plan: 'free' | 'pro' | 'team'
  rewrites_used: number
  memories_count: number
}
