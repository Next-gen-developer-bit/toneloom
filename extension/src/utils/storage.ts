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

export type ToolbarDomainMode = 'blacklist' | 'whitelist'

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
  /** blacklist = hide on listed hosts; whitelist = only show on listed hosts */
  toolbarDomainMode: ToolbarDomainMode
  /** Hostnames like bank.com or mail.company.com (no protocol) */
  toolbarDomains: string[]
  selectedToneProfileId: string | null
}

export const DEFAULT_SETTINGS: Settings = {
  defaultTone: 'my_style',
  defaultLLM: 'gpt-4o-mini',
  autoInjectContext: true,
  showFloatingToolbar: true,
  toolbarDomainMode: 'blacklist',
  toolbarDomains: [],
  selectedToneProfileId: null,
}

/** Returns true when the floating toolbar is allowed on this hostname. */
export function isToolbarAllowedOnHost(
  hostname: string,
  settings: Pick<Settings, 'showFloatingToolbar' | 'toolbarDomainMode' | 'toolbarDomains'> | null | undefined,
): boolean {
  if (!settings || settings.showFloatingToolbar === false) return false
  const host = (hostname || '').toLowerCase().replace(/^www\./, '')
  const list = (settings.toolbarDomains || [])
    .map((d) => d.toLowerCase().trim().replace(/^www\./, ''))
    .filter(Boolean)
  if (!list.length) return true
  const match = list.some((d) => host === d || host.endsWith(`.${d}`))
  return settings.toolbarDomainMode === 'whitelist' ? match : !match
}
