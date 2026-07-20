export const storage = {
  get: <T>(key: string): Promise<T | null> =>
    new Promise((resolve) =>
      chrome.storage.local.get(key, (result: Record<string, unknown>) => resolve(result[key] as T ?? null))
    ),

  set: (key: string, value: unknown): Promise<void> =>
    new Promise((resolve) =>
      chrome.storage.local.set({ [key]: value }, resolve)
    ),

  remove: (key: string): Promise<void> =>
    new Promise((resolve) =>
      chrome.storage.local.remove(key, resolve)
    ),

  clear: (): Promise<void> =>
    new Promise((resolve) =>
      chrome.storage.local.clear(resolve)
    ),
}

export type Settings = {
  defaultTone: string
  defaultLLM:
    | 'gpt-4o'
    | 'gpt-4o-mini'
    | 'claude-sonnet-4'
    | 'claude-3-5-sonnet'
    | 'gemini-2.5-flash'
    | 'gemini-2.5-flash-lite'
    | 'gemini-2.0-flash'
    | 'gemini-3.1-flash-lite'
  autoInjectContext: boolean
  showFloatingToolbar: boolean
  selectedToneProfileId: string | null
}

export const DEFAULT_SETTINGS: Settings = {
  defaultTone: 'professional',
  defaultLLM: 'gpt-4o-mini',
  autoInjectContext: true,
  showFloatingToolbar: true,
  selectedToneProfileId: null,
}
