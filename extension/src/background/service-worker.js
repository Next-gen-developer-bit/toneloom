// EchoWrite Background Service Worker (Manifest V3)
// Routes extension actions through the FastAPI backend so ContextOS features
// stay centralized and provider keys never ship in the extension bundle.

import { ACTIONS, STORAGE_KEYS, AI_HANDOFF_TARGETS } from '../utils/constants.js'
import { writeAPI, memoryAPI, toneAPI, migrationAPI } from '../utils/api.js'

let cachedAuthToken = null

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (changes[STORAGE_KEYS.AUTH_TOKEN]) {
    cachedAuthToken = changes[STORAGE_KEYS.AUTH_TOKEN].newValue || null
  }
})

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await getFromStorage(STORAGE_KEYS.AUTH_TOKEN)
  cachedAuthToken = stored || null
  chrome.contextMenus.removeAll(() => {
    const createMenu = (options) => {
      chrome.contextMenus.create(options, () => {
        if (chrome.runtime.lastError) {
          console.debug('Context menu creation issue:', chrome.runtime.lastError.message)
        }
      })
    }

    createMenu({ id: 'echowrite-rewrite', title: 'EchoWrite: Rewrite', contexts: ['selection'] })
    createMenu({ id: 'echowrite-summarize', title: 'EchoWrite: Summarize', contexts: ['selection'] })
    createMenu({ id: 'echowrite-expand', title: 'EchoWrite: Expand', contexts: ['selection'] })
    createMenu({ id: 'echowrite-train-tone', title: 'EchoWrite: Train My Tone', contexts: ['selection'] })
    createMenu({ id: 'echowrite-save-memory', title: 'EchoWrite: Save to Memory', contexts: ['selection'] })
  })
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id || !info.selectionText) return

  const actionMap = {
    'echowrite-rewrite': ACTIONS.REWRITE,
    'echowrite-summarize': ACTIONS.SUMMARIZE,
    'echowrite-expand': ACTIONS.EXPAND,
    'echowrite-train-tone': ACTIONS.TONE_TRAIN,
    'echowrite-save-memory': ACTIONS.STORE_MEMORY,
  }
  const action = actionMap[info.menuItemId]
  if (!action) return

  if (!isSupportedTabUrl(tab.url)) {
    console.warn('EchoWrite: context menu not supported on this page', tab.url)
    return
  }

  const payload = {
    action,
    text: info.selectionText,
    source: 'context_menu',
  }

  const delivered = await deliverToContentScript(tab.id, payload)
  if (delivered) return

  // Content script unavailable — run action in service worker and show inline UI.
  try {
    await runContextMenuFallback(tab.id, payload)
  } catch (err) {
    console.warn('EchoWrite: context menu fallback failed', err?.message || err)
    await showInlineToast(tab.id, err?.message || 'EchoWrite action failed', 'error')
  }
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message || 'Unknown error' }))
  return true
})

async function handleMessage(message) {
  const { action } = message

  switch (action) {
    case ACTIONS.GET_AUTH:
      return getAuthState()

    case ACTIONS.GET_STORAGE:
      return { value: await getFromStorage(message.key) }

    case ACTIONS.SET_STORAGE:
      await new Promise((resolve) =>
        chrome.storage.local.set({ [message.key]: message.value }, resolve)
      )
      return { success: true }

    case ACTIONS.REMOVE_STORAGE:
      await new Promise((resolve) => chrome.storage.local.remove(message.key, resolve))
      return { success: true }

    case ACTIONS.SIGN_OUT:
      cachedAuthToken = null
      await chrome.storage.local.clear()
      return { success: true }

    case ACTIONS.REWRITE: {
      await ensureAuthenticated()
      const tone = message.tone || 'professional'
      const personal = ['my_style', 'personal', 'my style', 'match_me'].includes(
        String(tone).toLowerCase().trim()
      )
      // Only attach the active profile for My style — preset tones must stay clean.
      const toneProfileId = personal
        ? (message.toneProfileId || (await getActiveToneProfileId(true)))
        : undefined
      return writeAPI.rewrite(message.text, tone, toneProfileId)
    }

    case ACTIONS.SUMMARIZE:
      await ensureAuthenticated()
      return writeAPI.summarize(message.text)

    case ACTIONS.EXPAND:
      await ensureAuthenticated()
      return writeAPI.expand(
        message.text,
        message.context,
        message.toneProfileId || (await getActiveToneProfileId(true))
      )

    case ACTIONS.STORE_MEMORY:
      await ensureAuthenticated()
      return memoryAPI.store(message.text, message.source || 'unknown', message.tags || [])

    case ACTIONS.RECALL_MEMORY:
      await ensureAuthenticated()
      return memoryAPI.recall(
        message.query || message.text || 'recent writing context',
        message.limit || 5
      )

    case ACTIONS.TONE_TRAIN:
      await ensureAuthenticated()
      return toneAPI.train(
        message.text,
        // Prefer explicit profileId from side panel; otherwise resolve the
        // server-side active profile (avoids stale chrome.storage IDs).
        message.profileId || (await getActiveToneProfileId(true)),
        message.source || 'unknown'
      )

    case ACTIONS.INJECT_CONTEXT:
    case ACTIONS.MIGRATE_CONTEXT:
      await ensureAuthenticated()
      return migrationAPI.injectContext(
        message.platform || 'unknown',
        message.conversation_text || message.text || '',
        message.source_platform || message.source || 'imported'
      )

    case ACTIONS.SAVE_THREAD:
      await ensureAuthenticated()
      return saveActiveThread(message)

    case ACTIONS.GET_THREAD:
      return getActiveThread()

    case ACTIONS.SAVE_ACTIVE_CHAT:
      await ensureAuthenticated()
      return captureChatFromOpenAiTab()

    case ACTIONS.CONTINUE_ON_PLATFORM:
      await ensureAuthenticated()
      return continueOnPlatform(message)

    case ACTIONS.OPEN_SIDEPANEL: {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (tab?.windowId) chrome.sidePanel.open({ windowId: tab.windowId })
      return { success: true }
    }

    default:
      throw new Error(`Unknown action: ${action}`)
  }
}

async function saveActiveThread(message) {
  const platform = (message.platform || 'unknown').toLowerCase()
  let transcript = unwrapTranscript((message.conversation_text || message.text || '').trim())
  transcript = extractRealDialogue(transcript) || transcript.trim()
  if (transcript.length < 20) throw new Error('Conversation is too short to save')

  // Allow saving from any tab. Only reject if NOTHING real remains after stripping stubs.
  const cleaned = extractRealDialogue(transcript) || transcript
  if (!cleaned || cleaned.length < 20) {
    throw new Error('Nothing useful to save — open a chat with real messages.')
  }
  // Pure stub only (no substantial assistant/user body)
  const looksLikeStubOnly =
    (/\[EchoWrite Context Migration\]/i.test(cleaned) || /You are continuing an ongoing conversation/i.test(cleaned)) &&
    cleaned.replace(/User:\s*\[EchoWrite Context[\s\S]*?(?=User:|Assistant:|$)/gi, '').trim().length < 60
  if (looksLikeStubOnly) {
    throw new Error('Only an EchoWrite handoff stub found. Save a chat that has real messages.')
  }

  transcript = cleaned

  const title = message.title || `Conversation on ${platform}`
  const localThread = {
    platform,
    title,
    transcript: transcript.slice(0, 12000),
    updatedAt: Date.now(),
    url: message.url || null,
  }
  await new Promise((resolve) =>
    chrome.storage.local.set({
      [STORAGE_KEYS.ACTIVE_THREAD]: localThread,
      [STORAGE_KEYS.LAST_GOOD_THREAD]: localThread,
    }, resolve)
  )

  try {
    const saved = await migrationAPI.saveSession(platform, transcript, title)
    return { ...saved, local: true }
  } catch (err) {
    return {
      success: true,
      local: true,
      warning: err?.message || 'Saved locally; cloud sync failed',
      platform,
      chars: transcript.length,
    }
  }
}

async function getActiveThread() {
  const local = await getFromStorage(STORAGE_KEYS.ACTIVE_THREAD)
  try {
    await ensureAuthenticated()
    const remote = await migrationAPI.getSession()
    return { local, remote: remote?.session || null }
  } catch {
    return { local, remote: null }
  }
}

function unwrapTranscript(text = '') {
  let t = String(text || '').trim()
  if (!t) return ''

  if (t.startsWith('[Active Thread')) {
    const parts = t.split('\n\n')
    if (parts.length > 1) t = parts.slice(1).join('\n\n').trim()
  }

  const soFar = t.match(/=== CONVERSATION SO FAR ===\s*([\s\S]*?)\s*=== END ===/i)
  if (soFar?.[1]) t = soFar[1].trim()

  t = t
    .replace(/^You are continuing an ongoing conversation[\s\S]*?(?=User:|Assistant:|$)/i, '')
    .replace(/^Pick up EXACTLY where we left off\.[\s\S]*?(?=User:|Assistant:|$)/i, '')
    .replace(/^Quick briefing \(for orientation only\):[\s\S]*?(?=User:|Assistant:|===|$)/i, '')
    .replace(/^\[EchoWrite Context Migration\]\s*/i, '')
    .replace(/^\[EchoWrite Context[^\]]*\]\s*/i, '')
    .replace(/\n*Continue from here:\s*$/i, '')
    .replace(/\n*Continue from the last turn above\.?\s*$/i, '')
    .trim()

  // Fix ChatGPT toolbar chrome baked into older saves: "EditAssistant: Edit"
  t = t.replace(/\bEdit(?=\s*(?:Assistant|User)\s*:)/gi, '')
  t = t.replace(/(^|\n)\s*Assistant:\s*Edit(?:\s*Assistant:\s*Edit)*\s*/gi, '$1Assistant: ')
  t = t.replace(/(^|\n)\s*Assistant:\s*Edit\s+/gi, '$1Assistant: ')
  t = t.replace(/\n(?:Edit|Copy|Share|Regenerate)\s*(?=\n|$)/gi, '\n')

  return t.trim()
}

/** Drop EchoWrite handoff stubs / migration injects that are not real chats. */
function isJunkTranscript(text = '') {
  const t = unwrapTranscript(text)
  if (!t || t.length < 40) return true

  const hasRealAssistant = /(?:^|\n)Assistant:\s+\S[\s\S]{60,}/i.test(t)
  const hasRealUser = hasNonMigrationUserTurn(t)

  // Real chat wins even if a stub turn is also present
  if (hasRealUser || hasRealAssistant) {
    // Only junk if after removing stub-like user turns almost nothing remains
    const withoutStubs = t
      .replace(/User:\s*\[EchoWrite Context[\s\S]*?(?=User:|Assistant:|$)/gi, '')
      .replace(/User:\s*You are continuing an ongoing conversation[\s\S]*?(?=User:|Assistant:|$)/gi, '')
      .trim()
    if (withoutStubs.length >= 60) return false
  }

  if (/^\s*User:\s*\[EchoWrite Context/i.test(t) && !hasRealUser && !hasRealAssistant) return true
  if (/User:\s*\[EchoWrite Context Migration\]/i.test(t) && !hasRealUser && !hasRealAssistant) return true
  if (/You are continuing an ongoing conversation/i.test(t) && !hasRealUser && !hasRealAssistant) return true
  if (/Pick up EXACTLY where we left off/i.test(t) && !hasRealUser && !hasRealAssistant) return true
  if (
    /Key Facts\s*&\s*Decisions/i.test(t) &&
    /User Preferences/i.test(t) &&
    !hasRealUser &&
    !hasRealAssistant
  ) {
    return true
  }
  return false
}

function hasNonMigrationUserTurn(text = '') {
  const parts = String(text).split(/(?=^\s*User:)/gim)
  return parts.some((p) => {
    if (!/^\s*User:/im.test(p)) return false
    if (/EchoWrite Context/i.test(p)) return false
    if (/continuing an ongoing conversation/i.test(p)) return false
    const body = p.replace(/^\s*User:\s*/i, '').trim()
    return body.length > 25
  })
}

function sanitizeTurnChunk(chunk = '') {
  let body = String(chunk || '')
  const isUser = /^\s*User:/i.test(body)
  const isAssistant = /^\s*Assistant:/i.test(body)
  body = body.replace(/^\s*(?:User|Assistant):\s*/i, '')
  body = body
    .replace(/^(ChatGPT|Claude|Gemini|DeepSeek)\s*(said|:)\s*/i, '')
    .replace(/^Edit\s+/i, '')
    .replace(/\n(?:Edit|Copy|Share|Regenerate)\s*(?=\n|$)/gi, '\n')
    .trim()
  if (!body) return ''
  if (isUser) return `User: ${body}`
  if (isAssistant) return `Assistant: ${body}`
  return body
}

/** Keep only real user/assistant turns; drop migration stub turns. */
function extractRealDialogue(text = '') {
  let t = unwrapTranscript(text)
  if (!t) return ''

  if (/User:|Assistant:/i.test(t)) {
    const chunks = t.split(/(?=^\s*(?:User|Assistant):)/gim).map((c) => c.trim()).filter(Boolean)
    const kept = chunks
      .map(sanitizeTurnChunk)
      .filter((chunk) => {
        if (/^\s*User:/i.test(chunk)) {
          if (/EchoWrite Context/i.test(chunk)) return false
          if (/continuing an ongoing conversation/i.test(chunk)) return false
          if (/Pick up EXACTLY where we left off/i.test(chunk)) return false
          if (/Key Facts\s*&\s*Decisions/i.test(chunk) && /User Preferences/i.test(chunk)) return false
          return chunk.replace(/^\s*User:\s*/i, '').trim().length > 15
        }
        if (/^\s*Assistant:/i.test(chunk)) {
          if (/Clarifying the Prompt/i.test(chunk)) return false
          const body = chunk.replace(/^\s*Assistant:\s*/i, '').trim()
          if (/^Edit$/i.test(body)) return false
          return body.length > 15
        }
        return true
      })
    if (kept.length) return kept.join('\n\n').trim()
  }

  // Plain text (e.g. one long assistant draft) — OK unless it's clearly a stub
  const plain = t.replace(/^Edit\s+/i, '').trim()
  if (
    plain.length >= 40 &&
    !/^\s*\[EchoWrite Context/i.test(plain) &&
    !/^You are continuing an ongoing conversation/i.test(plain) &&
    !( /Key Facts\s*&\s*Decisions/i.test(plain) && /User Preferences/i.test(plain) )
  ) {
    return plain
  }
  return ''
}

function isThinMigrationPrompt(text = '') {
  return isJunkTranscript(text)
}

/**
 * Send only the last chat exchange (last User + last Assistant) so target LLMs
 * with input limits are not flooded with the full thread.
 * Gemini's composer is stricter — use a lower cap so the START isn't chopped.
 */
const HANDOFF_MAX_CHARS = 2800
const HANDOFF_MAX_CHARS_BY_PLATFORM = {
  gemini: 1800,
  deepseek: 2400,
  chatgpt: 2800,
  claude: 2800,
}

function extractLastExchange(transcript, maxChars = HANDOFF_MAX_CHARS) {
  const cleaned = extractRealDialogue(transcript)
  if (!cleaned) return ''

  const chunks = cleaned
    .split(/(?=^\s*(?:User|Assistant):)/gim)
    .map((c) => c.trim())
    .filter(Boolean)

  if (!chunks.length) return clampHandoffText(cleaned, maxChars)

  let lastUserIdx = -1
  let lastAssistantIdx = -1
  for (let i = 0; i < chunks.length; i++) {
    if (/^\s*User:/i.test(chunks[i])) lastUserIdx = i
    if (/^\s*Assistant:/i.test(chunks[i])) lastAssistantIdx = i
  }

  const parts = []
  // Prefer the most recent User turn that still belongs with the last Assistant.
  if (lastUserIdx >= 0 && (lastAssistantIdx < 0 || lastUserIdx <= lastAssistantIdx)) {
    parts.push(chunks[lastUserIdx])
  }
  if (lastAssistantIdx >= 0 && lastAssistantIdx !== lastUserIdx) {
    parts.push(chunks[lastAssistantIdx])
  }
  if (!parts.length) parts.push(chunks[chunks.length - 1])

  return clampHandoffText(parts.join('\n\n'), maxChars)
}

function clampHandoffText(text = '', maxChars = HANDOFF_MAX_CHARS) {
  let t = String(text || '').trim()
  if (!t) return ''
  if (t.length <= maxChars) return t

  const userMatch = t.match(/^\s*User:\s*[\s\S]*?(?=\n\s*Assistant:|$)/i)
  const asstMatch = t.match(/\n\s*Assistant:\s*([\s\S]*)$/i)

  if (userMatch && asstMatch) {
    let userPart = userMatch[0].trim()
    let asstBody = asstMatch[1].trim()

    // Always keep a usable slice of BOTH turns within maxChars.
    // Reserve ~45% for the assistant (what the new LLM continues from).
    const asstBudget = Math.min(
      asstBody.length,
      Math.max(500, Math.floor(maxChars * 0.45))
    )
    if (asstBody.length > asstBudget) {
      asstBody = `…${asstBody.slice(-(asstBudget - 1))}`
    }

    const userBudget = Math.max(300, maxChars - asstBody.length - 24)
    if (userPart.length > userBudget) {
      const body = userPart.replace(/^\s*User:\s*/i, '').trim()
      userPart = `User: …${body.slice(-(userBudget - 10))}`
    }

    return `${userPart}\n\nAssistant: ${asstBody}`.trim()
  }

  // Plain / user-only: keep the end, but snap to a sentence when possible
  let tail = t.slice(-(maxChars - 1))
  const snap = tail.search(/(?:^|\n)(?:User|Assistant):\s/)
  if (snap > 0 && snap < 200) tail = tail.slice(snap)
  return `…${tail}`.slice(0, maxChars)
}

function buildLocalContinuationPrompt(transcript, platform = '') {
  const maxChars =
    HANDOFF_MAX_CHARS_BY_PLATFORM[String(platform || '').toLowerCase()] || HANDOFF_MAX_CHARS
  const exchange = extractLastExchange(transcript, maxChars)
  if (!exchange) return ''
  return `${exchange}\n\nContinue from the last turn above.`
}

async function resolveBestTranscript(preferred = '') {
  let transcript = extractRealDialogue(preferred)
  if (transcript && !isJunkTranscript(transcript)) return transcript

  const lastGood = await getFromStorage(STORAGE_KEYS.LAST_GOOD_THREAD)
  transcript = extractRealDialogue(lastGood?.transcript || '')
  if (transcript && !isJunkTranscript(transcript)) return transcript

  const active = await getFromStorage(STORAGE_KEYS.ACTIVE_THREAD)
  transcript = extractRealDialogue(active?.transcript || '')
  if (transcript && !isJunkTranscript(transcript)) return transcript

  try {
    const history = await migrationAPI.history()
    for (const row of history?.migrations || []) {
      const candidate = extractRealDialogue(row.original_text || row.processed_summary || '')
      if (candidate && !isJunkTranscript(candidate)) return candidate
    }
  } catch {
    // ignore
  }

  return ''
}

async function continueOnPlatform(message) {
  const customLlms = (await getFromStorage(STORAGE_KEYS.CUSTOM_LLMS)) || []
  const builtins = AI_HANDOFF_TARGETS.map((t) => ({
    id: t.id,
    label: t.label,
    url: t.url,
    builtin: true,
  }))
  const allTargets = [
    ...builtins,
    ...customLlms.map((t) => ({
      id: String(t.id || '').toLowerCase(),
      label: t.label || t.id,
      url: t.url,
      builtin: false,
    })),
  ]

  const targetId = (message.platform || '').toLowerCase()
  let target = allTargets.find((t) => t.id === targetId)
  if (!target && message.url) {
    target = {
      id: targetId || 'custom',
      label: message.label || targetId || 'Custom LLM',
      url: message.url,
      builtin: false,
    }
  }
  if (!target?.url) throw new Error(`Unknown platform: ${targetId || 'custom'}`)

  let prompt = (message.prompt || '').trim()
  let transcript = await resolveBestTranscript(message.conversation_text || message.text || '')

  if (isJunkTranscript(prompt)) prompt = ''

  if (!transcript && !prompt) {
    throw new Error('No real saved chat found. Open the original AI tab, click Save this chat, then continue.')
  }

  const sourcePlatform = (message.source_platform || message.source || 'imported').toLowerCase()

  // Always send the last real chat only — never migration stubs.
  // Gemini gets a tighter char budget so its composer doesn't chop the start.
  if (transcript) {
    const localPrompt = buildLocalContinuationPrompt(transcript, target.id)
    try {
      // Log handoff in backend, but prefer the cleaned local dialogue for inject.
      migrationAPI.injectContext(target.id, transcript, sourcePlatform).catch(() => {})
    } catch {}
    prompt = localPrompt
  } else if (prompt) {
    prompt = buildLocalContinuationPrompt(prompt, target.id)
  }

  if (!prompt) {
    throw new Error('Could not recover the last chat to continue. Save the conversation again, then retry.')
  }
  // Freshly built User/Assistant continuations are never junk — only reject empty/stub leftovers.
  if (
    isJunkTranscript(prompt) &&
    !/(?:^|\n)User:\s+\S/i.test(prompt) &&
    !/(?:^|\n)Assistant:\s+\S/i.test(prompt)
  ) {
    throw new Error('Could not recover the last chat to continue. Save the conversation again, then retry.')
  }

  // Preserve the good source chat for future handoffs (don't overwrite with stubs).
  if (transcript && !isJunkTranscript(transcript)) {
    const preserved = {
      platform: sourcePlatform,
      title: message.title || `Handoff to ${target.label}`,
      transcript: transcript.slice(0, 12000),
      updatedAt: Date.now(),
    }
    await new Promise((resolve) =>
      chrome.storage.local.set({
        [STORAGE_KEYS.ACTIVE_THREAD]: preserved,
        [STORAGE_KEYS.LAST_GOOD_THREAD]: preserved,
      }, resolve)
    )
  }

  // Always stash bootstrap for ANY chosen LLM (builtin + custom).
  await new Promise((resolve) =>
    chrome.storage.local.set({
      [STORAGE_KEYS.PENDING_BOOTSTRAP]: {
        platform: target.id,
        prompt,
        source_platform: sourcePlatform,
        url: target.url,
        label: target.label,
        timestamp: Date.now(),
      },
    }, resolve)
  )

  const tab = await chrome.tabs.create({ url: target.url })
  // Don't block the side panel — autofill runs in the background until the composer is ready.
  autofillTabWithPrompt(tab?.id, prompt, target.url).catch(() => {})

  return {
    success: true,
    platform: target.id,
    url: target.url,
    prompt,
    autofilled: true,
    needsPaste: false,
    label: target.label,
  }
}

/**
 * Wait for the new LLM tab to load, then inject the last saved context into
 * its chat composer. Retries for a few minutes (covers login walls).
 */
async function autofillTabWithPrompt(tabId, prompt, targetUrl = '') {
  if (!tabId || !prompt) return false

  const started = Date.now()
  const maxMs = 3 * 60 * 1000
  let host = ''
  try {
    host = new URL(targetUrl).hostname.replace(/^www\./, '')
  } catch {
    host = ''
  }

  const attempt = async () => {
    try {
      // Content script may have already filled + cleared pending — stop then.
      const pending = await getFromStorage(STORAGE_KEYS.PENDING_BOOTSTRAP)
      if (!pending?.prompt) return true

      const tab = await chrome.tabs.get(tabId)
      if (!tab?.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
        return false
      }
      if (host && tab.url) {
        try {
          const tabHost = new URL(tab.url).hostname.replace(/^www\./, '')
          if (!tabHost.includes(host) && !host.includes(tabHost)) return false
        } catch {
          // continue
        }
      }
      if (tab.status && tab.status !== 'complete') return false

      const isGemini = /gemini\.google\.com/i.test(tab.url || '')
      let payload = pending.prompt || prompt
      if (isGemini && payload.length > 1800) {
        // Pre-shrink so Gemini's Quill composer doesn't chop the beginning.
        payload = buildLocalContinuationPrompt(payload, 'gemini')
        if (!payload || payload.length > 1900) {
          payload = `${String(pending.prompt || prompt).slice(0, 1700).trim()}\n\nContinue from the last turn above.`
        }
      }

      const [{ result } = {}] = await chrome.scripting.executeScript({
        target: { tabId },
        args: [payload, isGemini],
        func: (text, gemini) => {
          const isVisible = (el) => {
            if (!el) return false
            const r = el.getBoundingClientRect()
            const style = window.getComputedStyle(el)
            return (
              r.width > 80 &&
              r.height > 18 &&
              style.visibility !== 'hidden' &&
              style.display !== 'none' &&
              !el.disabled
            )
          }

          const preferred = gemini
            ? [
                'rich-textarea .ql-editor',
                '.ql-editor[contenteditable="true"]',
                '[contenteditable="true"][role="textbox"]',
                '[contenteditable="true"]',
              ]
            : [
                '#prompt-textarea',
                '[data-testid="prompt-textarea"]',
                'div.ProseMirror[contenteditable="true"]',
                'rich-textarea .ql-editor',
                '.ql-editor[contenteditable="true"]',
                'textarea#chat-input',
                'textarea[placeholder*="Message" i]',
                'textarea[placeholder*="Ask" i]',
                'textarea[placeholder*="Send" i]',
                '[contenteditable="true"][role="textbox"]',
                '[role="textbox"]',
                'textarea',
                '[contenteditable="true"]',
              ]

          let input = null
          for (const sel of preferred) {
            const nodes = Array.from(document.querySelectorAll(sel))
            input = nodes.find(isVisible) || null
            if (input) break
          }
          if (!input) return { ok: false, reason: 'no-input' }

          const ph = (input.getAttribute('placeholder') || '').toLowerCase()
          if (/password|email|sign in|log in/.test(ph)) return { ok: false, reason: 'auth-field' }
          if (/sign[_-]?in|login|auth/i.test(location.pathname)) return { ok: false, reason: 'login-page' }

          const fillContentEditable = (el, value) => {
            el.focus()
            try {
              document.execCommand('selectAll', false, null)
              document.execCommand('delete', false, null)
            } catch {
              el.innerHTML = ''
            }
            // Paste path works best with Gemini Quill
            try {
              const dt = new DataTransfer()
              dt.setData('text/plain', value)
              el.dispatchEvent(
                new ClipboardEvent('paste', {
                  bubbles: true,
                  cancelable: true,
                  clipboardData: dt,
                })
              )
            } catch {
              // ignore
            }
            const shown = (el.innerText || '').trim()
            if (!shown || shown.length < Math.min(40, value.length / 4)) {
              el.innerText = value
              el.dispatchEvent(
                new InputEvent('input', {
                  bubbles: true,
                  inputType: 'insertText',
                  data: value,
                })
              )
            }
          }

          input.focus()
          if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
            const proto =
              input.tagName === 'TEXTAREA'
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
            setter?.call(input, text)
            input.value = text
            input.dispatchEvent(new Event('input', { bubbles: true }))
            input.dispatchEvent(new Event('change', { bubbles: true }))
          } else {
            fillContentEditable(input, text)
          }

          const shown = (input.innerText || input.value || '').trim()
          // Detect Gemini chopping the head off (shows only the tail)
          if (gemini && text.length > 200 && shown.length > 40) {
            const expectedHead = text.slice(0, 24).replace(/\s+/g, ' ')
            const gotHead = shown.slice(0, 24).replace(/\s+/g, ' ')
            if (!gotHead.includes(expectedHead.slice(0, 12)) && !text.startsWith(shown.slice(0, 16))) {
              // Retry with a shorter payload that fits Gemini's composer
              let safe = text
              if (safe.length > 1500) {
                const userM = safe.match(/^\s*User:\s*([\s\S]*?)(?=\n\s*Assistant:|$)/i)
                const asstM = safe.match(/\n\s*Assistant:\s*([\s\S]*?)(?:\n\nContinue from the last turn above\.?)?$/i)
                if (userM && asstM) {
                  let u = userM[1].trim()
                  let a = asstM[1].trim()
                  if (a.length > 700) a = `…${a.slice(-699)}`
                  if (u.length > 700) u = `…${u.slice(-699)}`
                  safe = `User: ${u}\n\nAssistant: ${a}\n\nContinue from the last turn above.`
                } else {
                  safe = `${safe.slice(0, 1480).trim()}\n\nContinue from the last turn above.`
                }
              }
              fillContentEditable(input, safe)
            }
          }

          const finalShown = (input.innerText || input.value || '').trim()
          return { ok: finalShown.length > 20, chars: finalShown.length }
        },
      })

      if (result?.ok) {
        await new Promise((resolve) =>
          chrome.storage.local.remove(STORAGE_KEYS.PENDING_BOOTSTRAP, resolve)
        )
        return true
      }
      return false
    } catch {
      return false
    }
  }

  // Immediate tries + polling while the chat UI mounts
  if (await attempt()) return true

  return await new Promise((resolve) => {
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      try {
        chrome.tabs.onUpdated.removeListener(onUpdated)
      } catch {}
      clearInterval(timer)
      resolve(ok)
    }

    const onUpdated = (id, info) => {
      if (id !== tabId) return
      if (info.status === 'complete' || info.url) {
        attempt().then((ok) => {
          if (ok) finish(true)
        })
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated)

    const timer = setInterval(async () => {
      if (Date.now() - started > maxMs) {
        finish(false)
        return
      }
      if (await attempt()) finish(true)
    }, 700)
  })
}

async function captureChatFromOpenAiTab() {
  const hosts = AI_HANDOFF_TARGETS.flatMap((t) => [...t.hosts])
  const isAiUrl = (url = '') => hosts.some((h) => url.includes(h))

  // Prefer the active tab in the current window (side panel keeps that tab active).
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  let tab = active && isAiUrl(active.url) ? active : null

  if (!tab) {
    const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (focused && isAiUrl(focused.url)) tab = focused
  }

  if (!tab) {
    const all = await chrome.tabs.query({ currentWindow: true })
    // Prefer the most recently accessed AI tab in this window
    tab =
      all
        .filter((t) => isAiUrl(t.url))
        .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null
  }

  if (!tab?.id) {
    throw new Error('Open a ChatGPT, Claude, Gemini, or DeepSeek tab with a chat, then try Save again.')
  }

  try {
    const res = await sendTabMessage(tab.id, {
      action: 'ew_capture_chat',
      source: 'sidepanel',
    })
    return {
      success: true,
      platform: res?.platform,
      chars: res?.chars,
      hasUser: res?.hasUser,
      hasAssistant: res?.hasAssistant,
      message: res?.message || 'Chat saved',
      tabUrl: tab.url,
    }
  } catch (err) {
    throw new Error(
      err?.message?.includes('Receiving end')
        ? 'Refresh the AI tab, then click Save this chat again.'
        : err?.message || 'Could not save chat from the open tab'
    )
  }
}

async function getAuthState() {
  const token = cachedAuthToken || await getFromStorage(STORAGE_KEYS.AUTH_TOKEN)
  const user = await getFromStorage(STORAGE_KEYS.USER)
  return { token, user, isAuthenticated: !!token }
}

async function ensureAuthenticated() {
  const token = cachedAuthToken || await getFromStorage(STORAGE_KEYS.AUTH_TOKEN)
  if (!token) {
    // Also check Supabase auth storage key as a fallback.
    const all = await new Promise((resolve) =>
      chrome.storage.local.get(null, (result) => resolve(result))
    )
    for (const [key, value] of Object.entries(all)) {
      if (!key.endsWith('-auth-token')) continue
      try {
        const session = typeof value === 'string' ? JSON.parse(value) : value
        const accessToken =
          session?.currentSession?.access_token ||
          session?.session?.access_token ||
          session?.access_token
        if (accessToken) {
          cachedAuthToken = accessToken
          await chrome.storage.local.set({ [STORAGE_KEYS.AUTH_TOKEN]: accessToken })
          return
        }
      } catch {
        // ignore malformed auth storage entries
      }
    }
    throw new Error('Please sign in from the EchoWrite side panel first.')
  }
  cachedAuthToken = token
}

async function getActiveToneProfileId(refreshFromServer = false) {
  if (refreshFromServer) {
    try {
      const res = await toneAPI.getProfiles()
      const active = res?.profiles?.find((p) => p.is_active) || null
      if (active?.id) {
        await chrome.storage.local.set({ [STORAGE_KEYS.TONE_PROFILE]: active })
        return active.id
      }
      await chrome.storage.local.remove(STORAGE_KEYS.TONE_PROFILE)
      return null
    } catch (err) {
      console.debug('EchoWrite: could not refresh active tone profile', err?.message || err)
    }
  }

  const toneProfile = await getFromStorage(STORAGE_KEYS.TONE_PROFILE)
  return toneProfile?.id || null
}

function getFromStorage(key) {
  return new Promise((resolve) =>
    chrome.storage.local.get(key, (result) => resolve(result[key] ?? null))
  )
}

function isSupportedTabUrl(url) {
  if (!url) return false
  return url.startsWith('http://') || url.startsWith('https://')
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }
      if (response?.error) {
        reject(new Error(response.error))
        return
      }
      resolve(response)
    })
  })
}

async function deliverToContentScript(tabId, payload) {
  try {
    await sendTabMessage(tabId, payload)
    return true
  } catch {
    try {
      await injectGeneralContentScript(tabId)
      await sendTabMessage(tabId, payload)
      return true
    } catch {
      return false
    }
  }
}

async function injectGeneralContentScript(tabId) {
  const manifest = chrome.runtime.getManifest()
  const generalScript = manifest.content_scripts?.find((cs) =>
    cs.matches?.some((match) => match === 'http://*/*' || match === 'https://*/*')
  )
  if (!generalScript) return

  const target = { tabId }
  if (generalScript.css?.length) {
    await chrome.scripting.insertCSS({ target, files: generalScript.css })
  }
  if (generalScript.js?.length) {
    await chrome.scripting.executeScript({ target, files: generalScript.js })
  }
}

async function runContextMenuFallback(tabId, payload) {
  const { action, text } = payload
  const source = (await chrome.tabs.get(tabId)).url || 'context_menu'

  await showInlineToast(tabId, 'EchoWrite is thinking...', 'info')

  const result = await handleMessage({
    action,
    text,
    tone: 'professional',
    source: new URL(source).hostname,
  })

  if (action === ACTIONS.STORE_MEMORY) {
    await showInlineToast(tabId, 'Saved to EchoWrite memory', 'success')
    return
  }
  if (action === ACTIONS.TONE_TRAIN) {
    await showInlineToast(tabId, 'Tone sample saved to EchoWrite', 'success')
    return
  }

  const label = action === ACTIONS.REWRITE
    ? 'Rewrite'
    : action === ACTIONS.SUMMARIZE
      ? 'Summary'
      : 'Expanded'

  await showInlineResult(tabId, result?.result || '', label)
}

async function showInlineToast(tabId, message, type = 'success') {
  if (!chrome.scripting?.executeScript) return
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (msg, toastType) => {
        const colors = {
          success: '#10b981',
          error: '#ef4444',
          info: '#8b5cf6',
        }
        const existing = document.getElementById('echowrite-inline-toast')
        if (existing) existing.remove()

        const el = document.createElement('div')
        el.id = 'echowrite-inline-toast'
        el.textContent = msg
        el.style.cssText = [
          'position:fixed',
          'bottom:24px',
          'right:24px',
          'z-index:2147483647',
          'padding:12px 16px',
          'border-radius:10px',
          'font:500 13px/1.4 system-ui,-apple-system,sans-serif',
          'color:#fff',
          `background:${colors[toastType] || colors.success}`,
          'box-shadow:0 8px 24px rgba(0,0,0,.25)',
          'max-width:320px',
        ].join(';')
        document.documentElement.appendChild(el)
        if (toastType !== 'info') {
          setTimeout(() => el.remove(), 4000)
        }
      },
      args: [message, type],
    })
  } catch {
    // Page may block script injection (PDF viewer, restricted frame, etc.)
  }
}

async function showInlineResult(tabId, text, label) {
  if (!chrome.scripting?.executeScript) return

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (resultText, actionLabel) => {
        const existing = document.getElementById('echowrite-inline-toast')
        if (existing) existing.remove()

        const prior = document.getElementById('echowrite-inline-result')
        if (prior) prior.remove()

        const overlay = document.createElement('div')
        overlay.id = 'echowrite-inline-result'
        overlay.style.cssText = [
          'position:fixed',
          'top:50%',
          'left:50%',
          'transform:translate(-50%,-50%)',
          'z-index:2147483647',
          'width:min(520px,calc(100vw - 32px))',
          'max-height:70vh',
          'overflow:auto',
          'background:#0f0f1a',
          'color:#f1f5f9',
          'border:1px solid rgba(139,92,246,.35)',
          'border-radius:12px',
          'padding:16px',
          'font:14px/1.5 system-ui,-apple-system,sans-serif',
          'box-shadow:0 16px 48px rgba(0,0,0,.45)',
        ].join(';')

        const title = document.createElement('div')
        title.textContent = `${actionLabel} Result`
        title.style.cssText = 'font-weight:700;margin-bottom:10px;color:#c4b5fd'

        const body = document.createElement('div')
        body.textContent = resultText
        body.style.cssText = 'white-space:pre-wrap;margin-bottom:12px'

        const actions = document.createElement('div')
        actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end'

        const copyBtn = document.createElement('button')
        copyBtn.textContent = 'Copy'
        copyBtn.style.cssText = 'padding:8px 12px;border:none;border-radius:8px;background:#8b5cf6;color:#fff;cursor:pointer'

        const closeBtn = document.createElement('button')
        closeBtn.textContent = 'Close'
        closeBtn.style.cssText = 'padding:8px 12px;border:1px solid #334155;border-radius:8px;background:transparent;color:#e2e8f0;cursor:pointer'

        copyBtn.onclick = () => navigator.clipboard.writeText(resultText)
        closeBtn.onclick = () => overlay.remove()

        actions.append(copyBtn, closeBtn)
        overlay.append(title, body, actions)
        document.documentElement.appendChild(overlay)
      },
      args: [text, label],
    })
  } catch {
    await showInlineToast(tabId, 'Result ready — copy from EchoWrite side panel', 'success')
  }
}
