export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined
if (!apiBaseUrl) {
  throw new Error('VITE_API_BASE_URL is required for EchoWrite production builds.')
}

export const API_BASE_URL = apiBaseUrl.replace(/\/+$/, '')

export const STORAGE_KEYS = {
  AUTH_TOKEN: 'ew_auth_token',
  USER: 'ew_user',
  TONE_PROFILE: 'ew_tone_profile',
  SETTINGS: 'ew_settings',
  PENDING_BOOTSTRAP: 'ew_pending_bootstrap',
  ACTIVE_THREAD: 'ew_active_thread',
  LAST_GOOD_THREAD: 'ew_last_good_thread',
  CUSTOM_LLMS: 'ew_custom_llms',
} as const

export const ACTIONS = {
  REWRITE: 'rewrite',
  SUMMARIZE: 'summarize',
  EXPAND: 'expand',
  TONE_TRAIN: 'tone_train',
  STORE_MEMORY: 'store_memory',
  RECALL_MEMORY: 'recall_memory',
  INJECT_CONTEXT: 'inject_context',
  MIGRATE_CONTEXT: 'migrate_context',
  SAVE_THREAD: 'save_thread',
  GET_THREAD: 'get_thread',
  SAVE_ACTIVE_CHAT: 'save_active_chat',
  CONTINUE_ON_PLATFORM: 'continue_on_platform',
  GET_AUTH: 'get_auth',
  GET_STORAGE: 'get_storage',
  SET_STORAGE: 'set_storage',
  REMOVE_STORAGE: 'remove_storage',
  SIGN_OUT: 'sign_out',
  OPEN_SIDEPANEL: 'open_sidepanel',
} as const

export const PLATFORMS = {
  GMAIL: 'gmail',
  NOTION: 'notion',
  CHATGPT: 'chatgpt',
  CLAUDE: 'claude',
  GEMINI: 'gemini',
  DEEPSEEK: 'deepseek',
} as const

/** Cross-LLM handoff targets — used by content scripts + side panel */
export const AI_HANDOFF_TARGETS = [
  { id: 'chatgpt', label: 'ChatGPT', url: 'https://chatgpt.com/', hosts: ['chatgpt.com', 'chat.openai.com'] },
  { id: 'claude', label: 'Claude', url: 'https://claude.ai/new', hosts: ['claude.ai'] },
  { id: 'gemini', label: 'Gemini', url: 'https://gemini.google.com/app', hosts: ['gemini.google.com'] },
  { id: 'deepseek', label: 'DeepSeek', url: 'https://chat.deepseek.com/', hosts: ['chat.deepseek.com'] },
] as const

export const TONES = [
  { id: 'my_style', label: 'My style', emoji: '✍️' },
  { id: 'professional', label: 'Professional', emoji: '💼' },
  { id: 'casual', label: 'Casual', emoji: '😊' },
  { id: 'concise', label: 'Concise', emoji: '⚡' },
  { id: 'friendly', label: 'Friendly', emoji: '🤝' },
  { id: 'formal', label: 'Formal', emoji: '🎩' },
  { id: 'persuasive', label: 'Persuasive', emoji: '🎯' },
] as const

export const PLANS = {
  FREE: 'free',
  PRO: 'pro',
  TEAM: 'team',
} as const

export const PLAN_LIMITS = {
  free: { rewrites: 30, memories: 50, toneProfiles: 1 },
  // -1 = unlimited
  pro: { rewrites: -1, memories: -1, toneProfiles: -1 },
  team: { rewrites: -1, memories: -1, toneProfiles: -1 },
} as const
