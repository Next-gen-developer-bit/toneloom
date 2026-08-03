// EchoWrite AI Platforms Content Script
// Targets: ChatGPT, Claude, Gemini, DeepSeek
// Features: auto-save conversations, cross-LLM handoff, memory inject

import {
  showToast, sendToBackground, showLoadingInOverlay, showResultOverlay,
  applyTextReplacement, captureSelectionSnapshot,
} from './shared/toolbar.js'
import { readStorage, writeStorage, removeStorage } from './shared/storage-bridge.js'
import { ACTIONS, STORAGE_KEYS, AI_HANDOFF_TARGETS } from '../utils/constants.js'

const PLATFORM_CONFIG = {
  'chatgpt.com': {
    id: 'chatgpt',
    name: 'ChatGPT',
    inputSelector: '#prompt-textarea, [contenteditable="true"]#prompt-textarea, div[contenteditable="true"][id="prompt-textarea"]',
    sendSelector: '[data-testid="send-button"], button[data-testid="send-button"]',
    userSelector: '[data-message-author-role="user"]',
    assistantSelector: '[data-message-author-role="assistant"]',
  },
  'chat.openai.com': {
    id: 'chatgpt',
    name: 'ChatGPT',
    inputSelector: '#prompt-textarea, [contenteditable="true"]#prompt-textarea',
    sendSelector: '[data-testid="send-button"]',
    userSelector: '[data-message-author-role="user"]',
    assistantSelector: '[data-message-author-role="assistant"]',
  },
  'claude.ai': {
    id: 'claude',
    name: 'Claude',
    inputSelector: '[contenteditable="true"].ProseMirror, div.ProseMirror[contenteditable="true"], div[contenteditable="true"][translate="no"], [data-placeholder*="Reply"][contenteditable], div[role="textbox"][contenteditable="true"]',
    sendSelector: 'button[aria-label="Send message"], button[aria-label="Send Message"], button[aria-label*="Send"]',
    // Claude DOM changes often — keep a wide, ordered set (see scrapeClaudeConversation).
    userSelector: [
      '[data-testid="user-message"]',
      '[data-testid="human-message"]',
      '[data-testid="message-human"]',
      '.font-user-message',
      '[class*="font-user-message"]',
      '.human-turn',
      '.HumanTurn',
    ].join(', '),
    assistantSelector: [
      '.font-claude-response',
      '.font-claude-message',
      '[data-testid="ai-message"]',
      '[data-testid="message-assistant"]',
      '[data-is-streaming]',
      // One response-content row per assistant turn (never inside user subtree)
      '.row-start-2',
      '.standard-markdown',
      '.progressive-markdown',
    ].join(', '),
  },
  'gemini.google.com': {
    id: 'gemini',
    name: 'Gemini',
    inputSelector: 'rich-textarea .ql-editor, .ql-editor[contenteditable="true"]',
    sendSelector: 'button.send-button, button[aria-label*="Send"]',
    userSelector: '.query-text, .user-query, .query-content',
    assistantSelector: '.model-response-text, .response-content, message-content',
  },
  'chat.deepseek.com': {
    id: 'deepseek',
    name: 'DeepSeek',
    inputSelector: [
      'textarea#chat-input',
      'textarea[placeholder*="Message"]',
      'textarea[placeholder*="Ask"]',
      '.chat-input textarea',
      'textarea',
    ].join(', '),
    sendSelector: 'div[role="button"].send-button, button[aria-label*="Send"], .send-button, button.send-button',
    userSelector: '[class*="user"] .ds-message, .chat-message-user, [data-role="user"]',
    assistantSelector: '[class*="assistant"] .ds-message, .chat-message-assistant, [data-role="assistant"]',
  },
}

const hostname = window.location.hostname
const config = Object.entries(PLATFORM_CONFIG).find(([key]) => hostname.includes(key))?.[1]
if (!config) {
  throw new Error('EchoWrite: unsupported platform')
}

let contextInjected = false
let inputObserver = null
let lastSavedHash = ''
let dockInstalled = false

function init() {
  waitForInput()
  checkPendingBootstrap()
}

function waitForInput() {
  const observer = new MutationObserver(() => {
    const input = getInput()
    if (input && !input.dataset.ewWatched) {
      input.dataset.ewWatched = '1'
      onInputReady(input)
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  const existing = getInput()
  if (existing && !existing.dataset.ewWatched) {
    existing.dataset.ewWatched = '1'
    onInputReady(existing)
  }
}

function getInput() {
  const nodes = Array.from(document.querySelectorAll(config.inputSelector))
  const visible = nodes.find((el) => {
    const r = el.getBoundingClientRect()
    return r.width > 80 && r.height > 18 && el.offsetParent !== null
  })
  return visible || nodes[0] || null
}

async function onInputReady(input) {
  const authState = await sendToBackground(ACTIONS.GET_AUTH)
  if (!authState?.isAuthenticated) return

  injectContextBadge(input)

  if (!contextInjected) {
    await autoInjectContext(input)
  }

  observeConversation()
}

/* ─── Clean message text (strip ChatGPT/Claude Edit/Copy chrome) ─── */
function extractCleanMessageText(el) {
  if (!el) return ''
  const clone = el.cloneNode(true)
  clone
    .querySelectorAll(
      [
        'button',
        '[role="button"]',
        'nav',
        'svg',
        'img',
        '[data-testid*="copy"]',
        '[data-testid*="edit"]',
        '[data-testid*="share"]',
        '[data-testid*="feedback"]',
        '[aria-label*="Copy" i]',
        '[aria-label*="Edit" i]',
        '[aria-label*="Share" i]',
        '[aria-label*="Good response" i]',
        '[aria-label*="Bad response" i]',
        '[aria-label*="Regenerate" i]',
        '.text-token-text-secondary',
      ].join(',')
    )
    .forEach((n) => n.remove())

  // Prefer markdown body when present (ChatGPT / Claude)
  const body =
    clone.querySelector(
      [
        '.standard-markdown',
        '.progressive-markdown',
        '.font-claude-response',
        '.markdown',
        '.prose',
        '[class*="markdown"]',
        '.message-content',
        '.model-response-text',
        '.query-text',
      ].join(', ')
    ) || clone

  return sanitizeTurnBody(body.innerText || clone.innerText || '')
}

function sanitizeTurnBody(raw = '') {
  let t = String(raw || '').replace(/\u00a0/g, ' ').trim()
  if (!t) return ''

  // ChatGPT often leaves "Edit" glued to the next label: "EditAssistant: Edit"
  t = t.replace(/\bEdit(?=\s*(?:Assistant|User)\s*:)/gi, '')
  t = t.replace(/^(?:Assistant|User)\s*:\s*/i, '') // role added by caller
  t = t.replace(/^(ChatGPT|Claude|Gemini|DeepSeek)\s*(said|:)\s*/i, '')

  // Drop common action / chrome lines
  t = t
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => {
      const s = line.trim()
      if (!s) return true
      if (/^(Edit|Copy|Share|Regenerate|Retry|Continue generating|Good response|Bad response|Read aloud|Listen)$/i.test(s)) {
        return false
      }
      if (/^(Copy code|Insert|Download)$/i.test(s)) return false
      return true
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  // Leading lone "Edit" leftovers
  t = t.replace(/^Edit\s+/i, '').replace(/\s+Edit$/i, '').trim()
  return t
}

/* ─── Scrape full user+assistant conversation in DOM order ─── */
function scrapeConversation({ maxChars = 12000 } = {}) {
  if (config.id === 'claude') {
    const claude = scrapeClaudeConversation()
    if (claude) return clampText(claude, maxChars)
  }

  const roleNodes = document.querySelectorAll('[data-message-author-role]')
  if (roleNodes.length > 0) {
    const lines = Array.from(roleNodes)
      .map((n) => {
        const role = n.getAttribute('data-message-author-role')
        if (role !== 'user' && role !== 'assistant') return null
        const label = role === 'user' ? 'User' : 'Assistant'
        const text = extractCleanMessageText(n)
        return text && text.length > 1 ? `${label}: ${text}` : null
      })
      .filter(Boolean)
    return clampText(lines.join('\n\n'), maxChars)
  }

  return clampText(scrapeBySelectors(config.userSelector, config.assistantSelector), maxChars)
}

/** Claude-specific: current UI uses human-message / font-claude-response / row-start-2. */
function scrapeClaudeConversation() {
  const userSelectors = [
    '[data-testid="user-message"]',
    '[data-testid="human-message"]',
    '[data-testid="message-human"]',
    '.font-user-message',
    '[class*="font-user-message"]',
    '.human-turn',
    '.HumanTurn',
  ]
  const assistantSelectors = [
    '.font-claude-response',
    '.font-claude-message',
    '[data-testid="ai-message"]',
    '[data-testid="message-assistant"]',
    '[data-is-streaming]',
    // One response-content row per assistant turn (never inside user subtree)
    '.row-start-2',
    '.standard-markdown',
    '.progressive-markdown',
  ]

  let transcript = scrapeBySelectors(userSelectors.join(', '), assistantSelectors.join(', '))

  // Fallback: pair human turns with nearby assistant markdown blocks
  if (!transcript || !/(?:^|\n)User:/i.test(transcript)) {
    const paired = scrapeClaudePairedTurns()
    if (paired && paired.length > (transcript || '').length) transcript = paired
  }

  // Last resort: any visible turn-like blocks in the main chat column
  if (!transcript || transcript.length < 40) {
    const main =
      document.querySelector('main, [data-testid="conversation"], .chat-messages, [class*="conversation"]') ||
      document.body
    const blocks = Array.from(
      main.querySelectorAll(
        '[data-testid="user-message"], [data-testid="human-message"], .font-user-message, [class*="font-user-message"], .human-turn, .font-claude-response, .font-claude-message, [data-is-streaming], .standard-markdown, .progressive-markdown'
      )
    )
    const seen = new Set()
    const lines = []
    for (const el of blocks) {
      if (blocks.some((other) => other !== el && other.contains(el))) continue
      const text = extractCleanMessageText(el)
      if (!text || text.length < 8) continue
      const key = text.slice(0, 100)
      if (seen.has(key)) continue
      seen.add(key)
      const isUser =
        el.matches(
          '[data-testid="user-message"], [data-testid="human-message"], .font-user-message, [class*="font-user-message"], .human-turn, .HumanTurn'
        ) ||
        !!el.closest(
          '[data-testid="user-message"], [data-testid="human-message"], .font-user-message, [class*="font-user-message"], .human-turn, .HumanTurn'
        )
      lines.push(`${isUser ? 'User' : 'Assistant'}: ${text}`)
    }
    if (lines.length) transcript = lines.join('\n\n')
  }

  return transcript || ''
}

function scrapeClaudePairedTurns() {
  const users = Array.from(
    document.querySelectorAll(
      '[data-testid="user-message"], [data-testid="human-message"], .font-user-message'
    )
  )
  if (!users.length) return ''

  const lines = []
  const seen = new Set()

  for (const userEl of users) {
    const userText = extractCleanMessageText(userEl)
    if (userText && userText.length > 4) {
      const key = `U:${userText.slice(0, 80)}`
      if (!seen.has(key)) {
        seen.add(key)
        lines.push(`User: ${userText}`)
      }
    }

    // Walk forward in document order for the next assistant block
    let asst = null
    let node = userEl
    for (let i = 0; i < 40 && node; i++) {
      node = node.nextElementSibling || node.parentElement?.nextElementSibling || null
      if (!node) break
      asst =
        node.matches?.(
          '.font-claude-response, .font-claude-message, .row-start-2, [data-testid="ai-message"]'
        )
          ? node
          : node.querySelector?.(
              '.font-claude-response, .font-claude-message, .row-start-2, [data-testid="ai-message"], .standard-markdown'
            )
      if (asst && !asst.closest('[data-testid="user-message"], [data-testid="human-message"], .font-user-message')) {
        break
      }
      asst = null
    }
    if (asst) {
      const asstText = extractCleanMessageText(asst)
      if (asstText && asstText.length > 8) {
        const key = `A:${asstText.slice(0, 80)}`
        if (!seen.has(key)) {
          seen.add(key)
          lines.push(`Assistant: ${asstText}`)
        }
      }
    }
  }

  return lines.join('\n\n')
}

function scrapeBySelectors(userSelector, assistantSelector) {
  const nodes = []
  document.querySelectorAll(userSelector).forEach((el) => {
    nodes.push({ role: 'User', el, top: el.getBoundingClientRect().top + window.scrollY })
  })
  document.querySelectorAll(assistantSelector).forEach((el) => {
    // Never treat a node inside a user turn as an assistant reply
    if (
      el.closest(
        '[data-testid="user-message"], [data-testid="human-message"], .font-user-message, [class*="font-user-message"], .human-turn, .HumanTurn, [data-message-author-role="user"]'
      )
    ) {
      return
    }
    nodes.push({ role: 'Assistant', el, top: el.getBoundingClientRect().top + window.scrollY })
  })

  const seen = new Set()
  const ordered = nodes
    .sort((a, b) => a.top - b.top || (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .filter(({ el }, _i, arr) => !arr.some((other) => other.el !== el && other.el.contains(el)))
    .map(({ role, el }) => {
      const text = extractCleanMessageText(el)
      if (!text || text.length < 2) return null
      const key = `${role}:${text.slice(0, 100)}`
      if (seen.has(key)) return null
      seen.add(key)
      return `${role}: ${text}`
    })
    .filter(Boolean)

  return ordered.join('\n\n')
}

function clampText(text, maxChars) {
  if (!text) return ''
  if (text.length <= maxChars) return text
  return `…(earlier turns truncated)…\n\n${text.slice(text.length - maxChars)}`
}

function hashText(text) {
  let h = 0
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0
  return String(h)
}

/** Last User + Assistant only — keeps handoff under typical LLM input limits. */
function extractLastExchangeForInject(text = '', maxChars = 2800) {
  // Gemini's Quill composer truncates long pastes from the start.
  if (config.id === 'gemini') maxChars = Math.min(maxChars, 1600)

  let t = String(text || '').trim()
  if (!t) return ''

  const chunks = t
    .split(/(?=^\s*(?:User|Assistant):)/gim)
    .map((c) => c.trim())
    .filter(Boolean)

  if (chunks.length) {
    let lastUserIdx = -1
    let lastAssistantIdx = -1
    for (let i = 0; i < chunks.length; i++) {
      if (/^\s*User:/i.test(chunks[i])) lastUserIdx = i
      if (/^\s*Assistant:/i.test(chunks[i])) lastAssistantIdx = i
    }
    const parts = []
    if (lastUserIdx >= 0 && (lastAssistantIdx < 0 || lastUserIdx <= lastAssistantIdx)) {
      parts.push(chunks[lastUserIdx])
    }
    if (lastAssistantIdx >= 0 && lastAssistantIdx !== lastUserIdx) {
      parts.push(chunks[lastAssistantIdx])
    }
    if (!parts.length) parts.push(chunks[chunks.length - 1])
    t = parts.join('\n\n')
  }

  if (t.length > maxChars) {
    const userMatch = t.match(/^\s*User:\s*[\s\S]*?(?=\n\s*Assistant:|$)/i)
    const asstMatch = t.match(/\n\s*Assistant:\s*([\s\S]*)$/i)
    if (userMatch && asstMatch) {
      let userBody = userMatch[0].replace(/^\s*User:\s*/i, '').trim()
      let asstBody = asstMatch[1].trim()
      const asstBudget = Math.max(450, Math.floor(maxChars * 0.5))
      if (asstBody.length > asstBudget) asstBody = `…${asstBody.slice(-(asstBudget - 1))}`
      const userBudget = Math.max(250, maxChars - asstBody.length - 30)
      if (userBody.length > userBudget) userBody = `…${userBody.slice(-(userBudget - 1))}`
      t = `User: ${userBody}\n\nAssistant: ${asstBody}`
    } else {
      t = t.slice(0, maxChars - 1)
    }
  }
  return `${t}\n\nContinue from the last turn above.`
}

/* ─── Auto-inject: prefer pending handoff thread, else memories ─── */
async function autoInjectContext(input) {
  try {
    const settings = await readStorage(STORAGE_KEYS.SETTINGS)
    if (settings?.autoInjectContext === false) return

    // If we already have a pending bootstrap, checkPendingBootstrap handles it.
    const pending = await readStorage(STORAGE_KEYS.PENDING_BOOTSTRAP)
    if (pending?.prompt && pending.platform === config.id) return

    const active = await readStorage(STORAGE_KEYS.ACTIVE_THREAD)
    const dayMs = 24 * 60 * 60 * 1000
    if (
      active?.transcript &&
      active.platform &&
      active.platform !== config.id &&
      Date.now() - (active.updatedAt || 0) < dayMs
    ) {
      // Prefer the saved dialogue itself — never inject migration meta stubs.
      const cleaned = String(active.transcript || '')
        .replace(/^You are continuing an ongoing conversation[\s\S]*?(?=User:|Assistant:|$)/i, '')
        .replace(/^\[EchoWrite Context Migration\]\s*/i, '')
        .trim()
      if (cleaned && !/User:\s*\[EchoWrite Context Migration\]/i.test(cleaned)) {
        // Only inject the last exchange — not the whole saved thread.
        const lastExchange = extractLastExchangeForInject(cleaned)
        await insertTextIntoInput(input, lastExchange, { replace: true })
        contextInjected = true
        showToast(`Continuing from ${active.platform} → ${config.name} ✨`, 'success')
        return
      }
    }

    const pageContext = `${document.title} continue previous AI conversation ${window.location.href}`
    const memRes = await sendToBackground(ACTIONS.RECALL_MEMORY, { query: pageContext, limit: 3 })
    if (!memRes?.memories?.length) return

    const contextBlock = buildContextBlock(memRes.memories)
    await insertTextIntoInput(input, contextBlock)
    contextInjected = true
    showToast(`${memRes.memories.length} memories injected into ${config.name}`, 'success')
  } catch {
    // non-critical
  }
}

function buildContextBlock(memories) {
  const items = memories.map((m) => `• ${m.content}`).join('\n')
  return `[EchoWrite Context — from your memory]\n${items}\n\n[Continue the conversation below]\n`
}

async function insertTextIntoInput(input, text, { replace = false } = {}) {
  input.focus()
  await new Promise((r) => setTimeout(r, 30))

  // Gemini uses Quill (ql-editor) — execCommand often drops the start of long text.
  const isGeminiQuill =
    config.id === 'gemini' ||
    input.classList?.contains('ql-editor') ||
    !!input.closest?.('rich-textarea, .ql-container')

  if (isGeminiQuill) {
    await insertIntoGeminiEditor(input, text, { replace })
    return
  }

  if (input.tagName === 'TEXTAREA') {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )?.set
    const next = replace || !(input.value || '').trim()
      ? text
      : `${input.value}\n\n${text}`
    nativeInputValueSetter?.call(input, next)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  } else if (input.isContentEditable) {
    const existing = (input.innerText || '').trim()
    if (replace || !existing) {
      input.innerHTML = ''
      document.execCommand('insertText', false, text)
    } else {
      const range = document.createRange()
      range.selectNodeContents(input)
      range.collapse(false)
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
      document.execCommand('insertText', false, `\n\n${text}`)
    }
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

/** Reliable fill for Gemini's Quill rich-textarea (avoids truncated head). */
async function insertIntoGeminiEditor(input, text, { replace = false } = {}) {
  const editor = input.closest?.('.ql-editor') || input
  editor.focus()

  const existing = (editor.innerText || '').trim()
  const next = replace || !existing ? text : `${existing}\n\n${text}`

  // 1) Prefer beforeinput / input events Quill listens to
  try {
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(editor)
    if (replace || !existing) {
      sel.removeAllRanges()
      sel.addRange(range)
      // Delete existing
      document.execCommand('selectAll', false, null)
      document.execCommand('delete', false, null)
    } else {
      range.collapse(false)
      sel.removeAllRanges()
      sel.addRange(range)
    }
  } catch {
    // continue
  }

  // 2) Paste simulation — Quill handles clipboardData most reliably
  let pasted = false
  try {
    const dt = new DataTransfer()
    dt.setData('text/plain', next)
    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    })
    pasted = !editor.dispatchEvent(pasteEvent) || (editor.innerText || '').includes(next.slice(0, 40))
  } catch {
    pasted = false
  }

  // 3) Fallback: direct text + InputEvent
  if (!pasted || !(editor.innerText || '').trim()) {
    editor.textContent = ''
    editor.innerText = next
    editor.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: next,
      })
    )
    editor.dispatchEvent(new Event('change', { bubbles: true }))
  }

  // 4) If Gemini still chopped the start, retry with a shorter Gemini-safe payload
  await new Promise((r) => setTimeout(r, 50))
  const shown = (editor.innerText || '').trim()
  const head = next.slice(0, 32).replace(/\s+/g, ' ')
  const shownHead = shown.slice(0, 32).replace(/\s+/g, ' ')
  if (next.length > 400 && shown.length > 0 && !shownHead.includes(head.slice(0, 16)) && !next.startsWith(shown.slice(0, 20))) {
    // Composer truncated from the start — shrink and rewrite so User+Assistant both fit
    const safe = shrinkPromptForGemini(next, 1600)
    editor.focus()
    document.execCommand('selectAll', false, null)
    document.execCommand('delete', false, null)
    try {
      const dt = new DataTransfer()
      dt.setData('text/plain', safe)
      editor.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
      )
    } catch {
      editor.innerText = safe
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: safe, inputType: 'insertText' }))
    }
  }
}

function shrinkPromptForGemini(text = '', maxChars = 1600) {
  let t = String(text || '').trim()
  if (t.length <= maxChars) return t

  const userMatch = t.match(/^\s*User:\s*[\s\S]*?(?=\n\s*Assistant:|$)/i)
  const asstMatch = t.match(/\n\s*Assistant:\s*([\s\S]*?)(?:\n\nContinue from the last turn above\.?)?$/i)
  const continueCue = /\n\nContinue from the last turn above\.?\s*$/i.test(t)
    ? '\n\nContinue from the last turn above.'
    : ''

  if (userMatch && asstMatch) {
    let userBody = userMatch[0].replace(/^\s*User:\s*/i, '').trim()
    let asstBody = asstMatch[1].trim()
    const asstBudget = Math.max(450, Math.floor(maxChars * 0.5))
    if (asstBody.length > asstBudget) asstBody = `…${asstBody.slice(-(asstBudget - 1))}`
    const userBudget = Math.max(250, maxChars - asstBody.length - continueCue.length - 30)
    if (userBody.length > userBudget) userBody = `…${userBody.slice(-(userBudget - 1))}`
    return `User: ${userBody}\n\nAssistant: ${asstBody}${continueCue}`
  }

  return `${t.slice(0, maxChars - 1 - continueCue.length).trim()}${continueCue}`
}

/* ─── Action bar — fixed dock OUTSIDE the AI text field ─── */
function removeMisplacedActionBars() {
  document.querySelectorAll('.ew-ai-actions, #ew-ai-actions-dock').forEach((el) => el.remove())
}

function injectContextBadge(_input) {
  if (dockInstalled && document.getElementById('ew-ai-actions-dock')?.isConnected) {
    const dock = document.getElementById('ew-ai-actions-dock')
    if (
      !dock.closest('[contenteditable="true"]') &&
      !dock.closest('.ProseMirror') &&
      !dock.closest('[role="textbox"]')
    ) {
      return
    }
  }

  removeMisplacedActionBars()
  dockInstalled = true

  const bar = document.createElement('div')
  bar.id = 'ew-ai-actions-dock'
  bar.className = 'ew-ai-actions ew-ai-actions-fixed'
  bar.setAttribute('data-platform', config.id)
  bar.innerHTML = `
    <button type="button" class="ew-ai-chip" id="ew-ai-menu-btn" aria-haspopup="true" aria-expanded="false" title="Drag to move · click for actions">
      <span class="ew-ai-chip-grip" aria-hidden="true">⋮⋮</span>
      <span class="ew-ai-chip-mark">✦</span>
      <span class="ew-ai-chip-label">EchoWrite</span>
      <span class="ew-ai-chip-caret">▾</span>
    </button>
    <div class="ew-ai-menu ew-hidden" role="menu" id="ew-ai-menu">
      <button type="button" class="ew-ai-menu-item" data-ew-action="inject" role="menuitem">🧠 Inject Memory</button>
      <button type="button" class="ew-ai-menu-item" data-ew-action="save" role="menuitem">💾 Save this chat</button>
      <button type="button" class="ew-ai-menu-item" data-ew-action="continue" role="menuitem">🔀 Continue on another AI</button>
      <button type="button" class="ew-ai-menu-item" data-ew-action="import" role="menuitem">📥 Import Paste</button>
    </div>
  `

  document.documentElement.appendChild(bar)

  const chip = bar.querySelector('#ew-ai-menu-btn')
  const menu = bar.querySelector('#ew-ai-menu')
  const dockPosKey = `ew_dock_pos_${config.id}`
  let userPlaced = false
  let dragging = false
  let dragMoved = false
  let startX = 0
  let startY = 0
  let originLeft = 0
  let originTop = 0

  const closeMenu = () => {
    menu.classList.add('ew-hidden')
    chip.setAttribute('aria-expanded', 'false')
  }
  const openMenu = () => {
    menu.classList.remove('ew-hidden')
    chip.setAttribute('aria-expanded', 'true')
  }

  function clampDock(left, top) {
    const margin = 8
    const w = bar.offsetWidth || 140
    const h = bar.offsetHeight || 40
    return {
      left: Math.min(Math.max(margin, left), window.innerWidth - w - margin),
      top: Math.min(Math.max(margin, top), window.innerHeight - h - margin),
    }
  }

  function applyDockPos(left, top) {
    const pos = clampDock(left, top)
    bar.style.left = `${pos.left}px`
    bar.style.top = `${pos.top}px`
    bar.style.right = 'auto'
    bar.style.bottom = 'auto'
    bar.style.transform = 'none'
    return pos
  }

  function defaultDockPos() {
    const w = bar.offsetWidth || 140
    const h = bar.offsetHeight || 40
    return {
      left: window.innerWidth - w - 20,
      top: window.innerHeight - h - 24,
    }
  }

  async function restoreDockPos() {
    try {
      const saved = await readStorage(dockPosKey)
      if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
        userPlaced = true
        applyDockPos(saved.left, saved.top)
        return
      }
    } catch {}
    const d = defaultDockPos()
    applyDockPos(d.left, d.top)
  }

  async function persistDockPos(left, top) {
    try {
      await writeStorage(dockPosKey, { left, top, updatedAt: Date.now() })
    } catch {}
  }

  function keepOutsideEditor() {
    if (
      bar.closest('[contenteditable="true"]') ||
      bar.closest('.ProseMirror') ||
      bar.closest('[role="textbox"]')
    ) {
      document.documentElement.appendChild(bar)
    }
  }

  restoreDockPos()

  window.addEventListener('resize', () => {
    keepOutsideEditor()
    if (userPlaced) {
      applyDockPos(parseFloat(bar.style.left) || 0, parseFloat(bar.style.top) || 0)
    } else {
      const d = defaultDockPos()
      applyDockPos(d.left, d.top)
    }
  }, { passive: true })

  chip.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragging = true
    dragMoved = false
    startX = e.clientX
    startY = e.clientY
    const rect = bar.getBoundingClientRect()
    originLeft = rect.left
    originTop = rect.top
    bar.classList.add('ew-ai-dragging')
    closeMenu()

    const onMove = (ev) => {
      if (!dragging) return
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragMoved = true
      applyDockPos(originLeft + dx, originTop + dy)
    }
    const onUp = () => {
      dragging = false
      bar.classList.remove('ew-ai-dragging')
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (dragMoved) {
        userPlaced = true
        persistDockPos(parseFloat(bar.style.left) || 0, parseFloat(bar.style.top) || 0)
      }
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  })

  chip.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (dragMoved) {
      dragMoved = false
      return
    }
    if (menu.classList.contains('ew-hidden')) openMenu()
    else closeMenu()
  })

  menu.addEventListener('click', async (e) => {
    const item = e.target.closest('[data-ew-action]')
    if (!item) return
    e.preventDefault()
    e.stopPropagation()
    closeMenu()
    const action = item.dataset.ewAction
    if (action === 'inject') {
      contextInjected = false
      const el = getInput()
      if (el) await autoInjectContext(el)
    } else if (action === 'save') {
      await saveConversationToMemory({ manual: true })
    } else if (action === 'continue') {
      showContinueModal()
    } else if (action === 'import') {
      showMigrationModal()
    }
  })

  document.addEventListener('click', (e) => {
    if (!bar.contains(e.target)) closeMenu()
  }, true)
}

/* ─── Observe + auto-save thread ─── */
function observeConversation() {
  if (inputObserver) return
  inputObserver = new MutationObserver(() => {
    clearTimeout(window._ewSaveTimer)
    window._ewSaveTimer = setTimeout(() => {
      autoSaveKeyExchanges()
    }, 6000)
  })
  const conv = document.querySelector('[role="main"]') || document.body
  inputObserver.observe(conv, { childList: true, subtree: true })
}

async function autoSaveKeyExchanges() {
  const transcript = scrapeConversation()
  if (!transcript || transcript.length < 80) return

  // Auto-save: skip pure handoff stubs only; allow mixed / real chats.
  const cleaned = stripHandoffStubTurns(transcript)
  if (!cleaned || cleaned.length < 80) return
  if (isPureHandoffStub(transcript) && cleaned.length < 120) return

  const h = hashText(cleaned)
  if (h === lastSavedHash) return
  lastSavedHash = h

  try {
    await sendToBackground(ACTIONS.SAVE_THREAD, {
      platform: config.id,
      conversation_text: cleaned,
      title: document.title || `Chat on ${config.name}`,
      url: window.location.href,
    })
  } catch {
    // silent — including rejected junk saves
  }
}

async function saveConversationToMemory({ manual = false } = {}) {
  const transcript = scrapeConversation()
  if (!transcript) {
    showToast('No conversation found on this page yet', 'error')
    return null
  }

  // Always allow manual save from any AI tab: strip stub turns, keep real chat.
  const cleaned = stripHandoffStubTurns(transcript) || transcript.trim()
  if (!cleaned || cleaned.length < 20) {
    if (manual) showToast('Nothing useful to save on this page yet', 'error')
    return null
  }

  // Only block when the page is literally just an EchoWrite inject with no real turns.
  if (isPureHandoffStub(cleaned) && !hasSubstantialChat(cleaned)) {
    if (manual) {
      showToast('Only an EchoWrite handoff stub found here. Open a chat with real messages, then save.', 'error')
    }
    return null
  }

  try {
    const res = await sendToBackground(ACTIONS.SAVE_THREAD, {
      platform: config.id,
      conversation_text: cleaned,
      title: document.title || `Chat on ${config.name}`,
      url: window.location.href,
    })
    lastSavedHash = hashText(cleaned)
    if (manual) {
      const note = res?.warning ? ` (local only: ${res.warning})` : ''
      showToast(`Conversation saved for handoff 🧠${note}`, 'success')
    }
    return cleaned
  } catch (err) {
    if (manual) showToast(err.message || 'Failed to save', 'error')
    return null
  }
}

/** True only when the transcript is basically just an EchoWrite inject. */
function isPureHandoffStub(text = '') {
  const t = String(text || '').trim()
  if (!t) return true
  if (hasSubstantialChat(t)) return false
  if (/User:\s*\[EchoWrite Context Migration\]/i.test(t)) return true
  if (/You are continuing an ongoing conversation/i.test(t) && t.length < 500) return true
  if (/Key Facts\s*&\s*Decisions/i.test(t) && /User Preferences/i.test(t) && !hasSubstantialChat(t)) {
    return true
  }
  return false
}

function hasSubstantialChat(text = '') {
  const t = String(text || '')
  // Real assistant/user content beyond migration chrome
  const withoutStub = stripHandoffStubTurns(t)
  if (withoutStub.length >= 80) return true
  // Assistant-only drafts (common when user message scrolled out / single reply)
  if (/(?:^|\n)Assistant:\s+\S[\s\S]{60,}/i.test(t) && !/User:\s*\[EchoWrite Context/i.test(withoutStub)) {
    return true
  }
  return false
}

/** Remove EchoWrite migration / continue-preamble turns; keep real dialogue. */
function stripHandoffStubTurns(text = '') {
  let t = String(text || '').trim()
  if (!t) return ''

  if (/User:|Assistant:/i.test(t)) {
    const chunks = t.split(/(?=^\s*(?:User|Assistant):)/gim).map((c) => c.trim()).filter(Boolean)
    const kept = chunks.filter((chunk) => {
      if (/^\s*User:/i.test(chunk)) {
        if (/EchoWrite Context/i.test(chunk)) return false
        if (/continuing an ongoing conversation/i.test(chunk)) return false
        if (/Pick up EXACTLY where we left off/i.test(chunk)) return false
        if (/Key Facts\s*&\s*Decisions/i.test(chunk) && /User Preferences/i.test(chunk)) return false
        return chunk.replace(/^\s*User:\s*/i, '').trim().length > 8
      }
      if (/^\s*Assistant:/i.test(chunk)) {
        if (/Clarifying the Prompt/i.test(chunk)) return false
        const body = chunk.replace(/^\s*Assistant:\s*/i, '').trim()
        if (/^Edit$/i.test(body)) return false
        return body.length > 8
      }
      return true
    })
    return kept.join('\n\n').trim()
  }

  // Plain page text — strip migration headers if present
  t = t
    .replace(/^You are continuing an ongoing conversation[\s\S]*?(?=\n\n|$)/i, '')
    .replace(/^\[EchoWrite Context Migration\]\s*/i, '')
    .trim()
  return t
}

// Back-compat alias (older call sites)
function isPageHandoffJunk(text = '') {
  return isPureHandoffStub(text) && !hasSubstantialChat(text)
}

/* ─── Continue on another LLM ─── */
function showContinueModal() {
  let modal = document.getElementById('ew-migration-modal')
  if (modal) {
    modal.remove()
    return
  }

  const others = AI_HANDOFF_TARGETS.filter((t) => t.id !== config.id)
  modal = document.createElement('div')
  modal.id = 'ew-migration-modal'
  modal.style.cssText = `
    position:fixed; inset:0; z-index:2147483647; background:rgba(0,0,0,0.7);
    display:flex; align-items:center; justify-content:center; backdrop-filter:blur(4px);
    font-family:'Inter',sans-serif;
  `
  modal.innerHTML = `
    <div style="
      background:#0f0f1a; border:1px solid rgba(139,92,246,0.3); border-radius:16px;
      padding:28px; width:min(440px,92vw); box-shadow:0 24px 80px rgba(0,0,0,0.5);
    ">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <div>
          <div style="font-size:18px;font-weight:700;color:#f1f5f9;">🔀 Continue elsewhere</div>
          <div style="font-size:13px;color:#94a3b8;margin-top:4px;">
            Save this ${config.name} chat and pick up on another LLM with full context.
          </div>
        </div>
        <button id="ew-modal-close" style="background:transparent;border:none;color:#94a3b8;font-size:20px;cursor:pointer;">✕</button>
      </div>
      <div id="ew-continue-targets" style="display:grid;gap:8px;"></div>
      <p style="font-size:11px;color:#64748b;margin:14px 0 0;">
        EchoWrite summarizes the conversation, opens the target AI, and injects a continue prompt automatically.
      </p>
    </div>
  `
  document.body.appendChild(modal)

  const list = modal.querySelector('#ew-continue-targets')
  others.forEach((t) => {
    const btn = document.createElement('button')
    btn.className = 'ew-btn ew-primary'
    btn.style.cssText = 'width:100%;justify-content:center;padding:10px 12px;'
    btn.textContent = `Continue on ${t.label} →`
    btn.addEventListener('click', async () => {
      btn.disabled = true
      btn.textContent = `Preparing ${t.label}…`
      try {
        await handoffToPlatform(t.id)
        modal.remove()
      } catch (err) {
        showToast(err.message || 'Handoff failed', 'error')
        btn.disabled = false
        btn.textContent = `Continue on ${t.label} →`
      }
    })
    list.appendChild(btn)
  })

  modal.querySelector('#ew-modal-close').addEventListener('click', () => modal.remove())
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove()
  })
}

async function handoffToPlatform(targetId) {
  let transcript = scrapeConversation()
  if (!transcript || transcript.length < 40) {
    const active = await readStorage(STORAGE_KEYS.ACTIVE_THREAD)
    transcript = active?.transcript || ''
  }
  if (!transcript || transcript.length < 40) {
    throw new Error('Chat is too short — send a few messages first, then try again.')
  }

  showToast(`Saving ${config.name} conversation…`, 'success')
  await sendToBackground(ACTIONS.SAVE_THREAD, {
    platform: config.id,
    conversation_text: transcript,
    title: document.title || `Chat on ${config.name}`,
    url: window.location.href,
  })

  await sendToBackground(ACTIONS.CONTINUE_ON_PLATFORM, {
    platform: targetId,
    conversation_text: transcript,
    source_platform: config.id,
    title: document.title || `From ${config.name}`,
  })
  showToast(`Opening ${targetId} with your context…`, 'success')
}

/* ─── Paste-based import (legacy / backup) ─── */
function showMigrationModal() {
  let modal = document.getElementById('ew-migration-modal')
  if (modal) {
    modal.remove()
    return
  }

  modal = document.createElement('div')
  modal.id = 'ew-migration-modal'
  modal.style.cssText = `
    position:fixed; inset:0; z-index:2147483647; background:rgba(0,0,0,0.7);
    display:flex; align-items:center; justify-content:center; backdrop-filter:blur(4px);
    font-family:'Inter',sans-serif;
  `
  modal.innerHTML = `
    <div style="
      background:#0f0f1a; border:1px solid rgba(139,92,246,0.3); border-radius:16px;
      padding:28px; min-width:380px; max-width:500px; width:92vw; box-shadow:0 24px 80px rgba(0,0,0,0.5);
    ">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
        <div>
          <div style="font-size:18px;font-weight:700;color:#f1f5f9;">📥 Import context</div>
          <div style="font-size:13px;color:#94a3b8;margin-top:2px;">Paste a conversation from another AI into ${config.name}</div>
        </div>
        <button id="ew-modal-close" style="background:transparent;border:none;color:#94a3b8;font-size:20px;cursor:pointer;">✕</button>
      </div>
      <textarea id="ew-migrate-input" placeholder="Paste ChatGPT / Claude / Gemini / DeepSeek conversation…"
        style="width:100%;height:120px;background:rgba(255,255,255,0.05);border:1px solid rgba(139,92,246,0.25);
               border-radius:8px;color:#f1f5f9;font-family:'Inter',sans-serif;font-size:13px;
               padding:10px;resize:vertical;outline:none;box-sizing:border-box;"></textarea>
      <div style="display:flex;gap:10px;margin-top:14px;">
        <button id="ew-migrate-btn-confirm" class="ew-btn ew-primary" style="flex:1;">⚡ Inject into ${config.name}</button>
        <button id="ew-migrate-btn-memory" class="ew-btn" style="flex:1;">🧠 Save thread</button>
      </div>
    </div>
  `
  document.body.appendChild(modal)
  modal.querySelector('#ew-modal-close').addEventListener('click', () => modal.remove())
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove()
  })

  modal.querySelector('#ew-migrate-btn-confirm').addEventListener('click', async () => {
    const text = modal.querySelector('#ew-migrate-input').value.trim()
    if (!text) {
      showToast('Paste some conversation text first', 'error')
      return
    }
    try {
      await writeStorage(STORAGE_KEYS.ACTIVE_THREAD, {
        platform: 'imported',
        title: 'Imported conversation',
        transcript: text.slice(0, 12000),
        updatedAt: Date.now(),
      })
      const res = await sendToBackground(ACTIONS.INJECT_CONTEXT, {
        platform: config.id,
        conversation_text: text,
        source_platform: 'imported',
      })
      const input = getInput()
      if (input && res?.context_prompt) {
        await insertTextIntoInput(input, res.context_prompt)
        showToast(`Context migrated into ${config.name} ✨`, 'success')
      }
    } catch (err) {
      showToast(err.message || 'Migration failed', 'error')
    }
    modal.remove()
  })

  modal.querySelector('#ew-migrate-btn-memory').addEventListener('click', async () => {
    const text = modal.querySelector('#ew-migrate-input').value.trim()
    if (!text) {
      showToast('Nothing to save', 'error')
      return
    }
    await sendToBackground(ACTIONS.SAVE_THREAD, {
      platform: 'imported',
      conversation_text: text,
      title: 'Imported conversation',
    })
    showToast('Saved for handoff 🧠', 'success')
    modal.remove()
  })
}

async function handleAction(action, text, tone, replaceTarget, rect) {
  const loadingOverlay = showLoadingInOverlay(action, rect)
  try {
    if (action === ACTIONS.REWRITE || action === 'rewrite') {
      const result = await sendToBackground(ACTIONS.REWRITE, { text, tone })
      showResultOverlay(result.result, 'Rewrite', rect, (output) => replaceSelection(output, replaceTarget), () => {})
    } else if (action === ACTIONS.SUMMARIZE || action === 'summarize') {
      const result = await sendToBackground(ACTIONS.SUMMARIZE, { text })
      showResultOverlay(result.result, 'Summary', rect, (output) => replaceSelection(output, replaceTarget), () => {})
    } else if (action === ACTIONS.EXPAND || action === 'expand') {
      const result = await sendToBackground(ACTIONS.EXPAND, { text })
      showResultOverlay(result.result, 'Expanded', rect, (output) => replaceSelection(output, replaceTarget), () => {})
    } else if (action === ACTIONS.TONE_TRAIN || action === 'train') {
      await sendToBackground(ACTIONS.TONE_TRAIN, { text, source: config.id })
      loadingOverlay?.remove()
      showToast('Tone sample saved! 🎨', 'success')
      return
    } else if (action === ACTIONS.STORE_MEMORY || action === 'memory') {
      await sendToBackground(ACTIONS.STORE_MEMORY, { text, source: config.id })
      loadingOverlay?.remove()
      showToast('Saved to EchoWrite memory 🧠', 'success')
      return
    }
  } catch (err) {
    loadingOverlay?.remove()
    showToast(err.message || 'Something went wrong', 'error')
    return
  }
  loadingOverlay?.remove()
}

function replaceSelection(text, target) {
  const live = captureSelectionSnapshot()
  const snapshot = live || (target
    ? { editable: target, range: null, inputStart: null, inputEnd: null }
    : null)

  // Prefer restoring the exact selected range (Claude ProseMirror, etc.).
  if (applyTextReplacement(text, snapshot)) {
    showToast('Text replaced!', 'success')
    return
  }

  // Fallback: replace/fill the platform composer
  const input = target || getInput()
  if (input) {
    insertTextIntoInput(input, text, { replace: true })
    showToast('Text replaced!', 'success')
    return
  }

  navigator.clipboard.writeText(text).then(() => {
    showToast('Could not replace in place — copied to clipboard', 'error')
  }).catch(() => {
    showToast('Could not replace text', 'error')
  })
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const { action, text, source } = message

  // Scrape only — background saves. Avoids nested SW messaging (port closed errors).
  if (action === 'ew_capture_chat' || action === ACTIONS.SAVE_ACTIVE_CHAT) {
    try {
      const transcript = scrapeConversation()
      const cleaned = stripHandoffStubTurns(transcript) || String(transcript || '').trim()
      if (!cleaned || cleaned.length < 20) {
        sendResponse({
          error: 'No conversation found on this page yet. Send a few messages, then save again.',
        })
        return true
      }
      if (isPureHandoffStub(cleaned) && !hasSubstantialChat(cleaned)) {
        sendResponse({
          error: 'Only an EchoWrite handoff stub found here. Open a chat with real messages, then save.',
        })
        return true
      }
      lastSavedHash = hashText(cleaned)
      sendResponse({
        success: true,
        platform: config.id,
        transcript: cleaned,
        chars: cleaned.length,
        hasUser: /(?:^|\n)User:\s+/i.test(cleaned),
        hasAssistant: /(?:^|\n)Assistant:\s+/i.test(cleaned),
        title: document.title || `Chat on ${config.name}`,
        url: window.location.href,
        message: `Saved ${config.name} chat for handoff (${cleaned.length} chars)`,
      })
    } catch (err) {
      sendResponse({ error: err?.message || 'Failed to capture chat' })
    }
    return true
  }

  if (source === 'context_menu') {
    const sel = window.getSelection()
    const rect =
      sel && !sel.isCollapsed && sel.rangeCount > 0
        ? sel.getRangeAt(0).getBoundingClientRect()
        : {
            top: window.innerHeight / 2 - 100,
            bottom: window.innerHeight / 2 + 100,
            left: window.innerWidth / 2 - 250,
            right: window.innerWidth / 2 + 250,
          }
    handleAction(action, text, 'professional', getInput(), rect)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ error: err.message }))
    return true
  }
})

/* ─── Bootstrap after Continue on… handoff ─── */
async function checkPendingBootstrap() {
  try {
    const pending = await readStorage(STORAGE_KEYS.PENDING_BOOTSTRAP)
    if (!pending?.prompt) return

    const matchesPlatform = pending.platform === config.id
    let matchesHost = false
    if (pending.url) {
      try {
        const host = new URL(pending.url).hostname.replace(/^www\./, '')
        matchesHost = location.hostname.replace(/^www\./, '').includes(host) ||
          host.includes(location.hostname.replace(/^www\./, ''))
      } catch {
        matchesHost = false
      }
    }
    if (!matchesPlatform && !matchesHost) return

    // Allow time for login pages before giving up.
    if (Date.now() - pending.timestamp > 5 * 60 * 1000) {
      await removeStorage(STORAGE_KEYS.PENDING_BOOTSTRAP)
      return
    }

    // Keep pending until we successfully inject (don't clear on sign-in screens).
    waitForInputAndSubmit(pending.prompt, async () => {
      await removeStorage(STORAGE_KEYS.PENDING_BOOTSTRAP)
    })
  } catch (err) {
    console.error('Bootstrap error:', err)
  }
}

function waitForInputAndSubmit(prompt, onSuccess) {
  let done = false
  const tryInject = async () => {
    if (done) return
    const input = getInput()
    if (!input) return
    // Skip login walls / disabled fields
    if (input.closest('form[action*="sign"]') || /sign[_-]?in|login|auth/i.test(location.pathname)) {
      return
    }

    // Already filled by background scripting — don't double-paste.
    const existing = (input.innerText || input.value || '').trim()
    const marker = String(prompt || '').trim().slice(0, 48)
    if (existing.length > 40 && marker && existing.includes(marker.slice(0, 24))) {
      done = true
      clearInterval(checkInterval)
      contextInjected = true
      try {
        await onSuccess?.()
      } catch {}
      return
    }

    done = true
    clearInterval(checkInterval)
    contextInjected = true
    await insertTextIntoInput(input, prompt, { replace: true })
    showToast('Saved context loaded — press Send to continue.', 'success')
    try {
      await onSuccess?.()
    } catch {}
  }

  const checkInterval = setInterval(tryInject, 400)
  tryInject()
  // Keep polling longer so login → chat navigation still picks it up.
  setTimeout(() => clearInterval(checkInterval), 5 * 60 * 1000)
}

init()
