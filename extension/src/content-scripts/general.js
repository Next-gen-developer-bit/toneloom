// EchoWrite General Content Script
// Runs on ALL websites — shows floating toolbar and handles context menu actions inline.
// Calls the FastAPI backend directly via the background service worker.

import {
  createToolbar, positionToolbar, showLoadingInOverlay,
  showResultOverlay, showToast, sendToBackground,
  captureSelectionSnapshot, applyTextReplacement,
} from './shared/toolbar.js'
import { readStorage, removeStorage } from './shared/storage-bridge.js'
import { ACTIONS, STORAGE_KEYS } from '../utils/constants.js'

let toolbar = null
let lastSelection = null
let lastRect = null
let lastSnapshot = null
let floatingEnabled = true

function init() {
  document.addEventListener('mouseup', onMouseUp)
  document.addEventListener('keyup', onSelectionKey)
  // Reposition / hide on scroll so fixed toolbar stays sensible
  document.addEventListener('scroll', onScrollOrResize, true)
  window.addEventListener('resize', onScrollOrResize)

  // Pick up Settings → Floating Toolbar toggles without a page refresh
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[STORAGE_KEYS.SETTINGS]) return
      const next = changes[STORAGE_KEYS.SETTINGS].newValue
      floatingEnabled = next?.showFloatingToolbar !== false
      if (!floatingEnabled && toolbar) {
        toolbar.classList.add('ew-hidden')
      }
    })
  } catch {
    // ignore
  }

  refreshFloatingPref()
  tryUniversalHandoffBootstrap()
}

async function refreshFloatingPref() {
  try {
    const settings = await readStorage(STORAGE_KEYS.SETTINGS)
    floatingEnabled = settings?.showFloatingToolbar !== false
  } catch {
    floatingEnabled = true
  }
}

function onSelectionKey(event) {
  // Shift+arrows / Cmd+A can create a selection without mouseup
  if (event.key === 'Shift' || event.key?.startsWith('Arrow') || event.key === 'a' || event.key === 'A') {
    onMouseUp(event)
  }
}

function onScrollOrResize() {
  if (!toolbar || toolbar.classList.contains('ew-hidden') || !lastRect) return
  // Refresh rect from current selection if still present
  const sel = window.getSelection()
  if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
    lastRect = sel.getRangeAt(0).getBoundingClientRect()
    positionToolbar(toolbar, lastRect)
  } else {
    toolbar.classList.add('ew-hidden')
  }
}

/* ─── Floating toolbar on text selection ─── */
async function onMouseUp(event) {
  // Ignore mouseup on the toolbar itself — otherwise the toolbar hides
  // before button click handlers fire.
  if (toolbar && event?.target && (toolbar.contains(event.target) || event.target.closest?.('.ew-tone-menu'))) {
    return
  }

  // Slight delay so the browser finishes updating the selection
  setTimeout(async () => {
    try {
      await refreshFloatingPref()
      if (!floatingEnabled) {
        if (toolbar) toolbar.classList.add('ew-hidden')
        return
      }

      const sel = window.getSelection()
      const text = sel?.toString()?.trim() || ''
      if (!sel || sel.isCollapsed || text.length < 8 || sel.rangeCount === 0) {
        if (toolbar) toolbar.classList.add('ew-hidden')
        return
      }

      // Skip selections inside our own UI
      const anchor = sel.anchorNode?.nodeType === Node.ELEMENT_NODE
        ? sel.anchorNode
        : sel.anchorNode?.parentElement
      if (anchor?.closest?.('#echowrite-toolbar, #echowrite-result-overlay, .ew-tone-menu')) {
        return
      }

      lastSelection = text
      lastSnapshot = captureSelectionSnapshot(sel)
      lastRect = lastSnapshot?.rect || sel.getRangeAt(0).getBoundingClientRect()
      // Ignore zero-size rects (hidden / weird hosts)
      if (lastRect.width === 0 && lastRect.height === 0) {
        if (toolbar) toolbar.classList.add('ew-hidden')
        return
      }

      if (!toolbar) {
        toolbar = createToolbar({
          onRewrite: (tone) => doAction(ACTIONS.REWRITE, tone),
          onSummarize: () => doAction(ACTIONS.SUMMARIZE),
          onExpand: () => doAction(ACTIONS.EXPAND),
          onTrainTone: () => doAction(ACTIONS.TONE_TRAIN),
          onSaveMemory: () => doAction(ACTIONS.STORE_MEMORY),
          onOpenPanel: () => sendToBackground(ACTIONS.OPEN_SIDEPANEL).catch(() => {}),
        })
        toolbar.classList.add('ew-hidden')
        document.documentElement.appendChild(toolbar)
      }

      positionToolbar(toolbar, lastRect)
      toolbar.classList.remove('ew-hidden')
    } catch {
      // Extension reloaded / context invalidated — ignore quietly.
      if (toolbar) toolbar.classList.add('ew-hidden')
    }
  }, 20)
}

async function doAction(action, tone) {
  if (!lastSelection || !lastRect) return
  // Refresh snapshot right before the action so the Range is still valid.
  const live = captureSelectionSnapshot()
  if (live?.text?.trim() === lastSelection.trim()) {
    lastSnapshot = live
  }
  await handleAction(action, lastSelection, tone, lastSnapshot, lastRect)
}

const ACTION_LABELS = {
  [ACTIONS.REWRITE]: 'Rewrite',
  [ACTIONS.SUMMARIZE]: 'Summarize',
  [ACTIONS.EXPAND]: 'Expand',
  [ACTIONS.TONE_TRAIN]: 'Train tone',
  [ACTIONS.STORE_MEMORY]: 'Save to memory',
  rewrite: 'Rewrite',
  summarize: 'Summarize',
  expand: 'Expand',
  tone_train: 'Train tone',
  store_memory: 'Save to memory',
}

/* ─── Shared action handler — calls backend via service worker ─── */
async function handleAction(action, text, tone, selectionSnapshot, rect) {
  const label = ACTION_LABELS[action] || action
  const loadingOverlay = showLoadingInOverlay(label, rect)

  try {
    let result
    if (action === ACTIONS.REWRITE || action === 'rewrite') {
      result = await sendToBackground(ACTIONS.REWRITE, { text, tone })
      loadingOverlay?.remove()
      showResultOverlay(result.result, 'Rewrite', rect,
        (output) => replaceSelection(output, selectionSnapshot), () => {})
    } else if (action === ACTIONS.SUMMARIZE || action === 'summarize') {
      result = await sendToBackground(ACTIONS.SUMMARIZE, { text })
      loadingOverlay?.remove()
      showResultOverlay(result.result, 'Summary', rect,
        (output) => replaceSelection(output, selectionSnapshot), () => {})
    } else if (action === ACTIONS.EXPAND || action === 'expand') {
      result = await sendToBackground(ACTIONS.EXPAND, { text })
      loadingOverlay?.remove()
      showResultOverlay(result.result, 'Expanded', rect,
        (output) => replaceSelection(output, selectionSnapshot), () => {})
    } else if (action === ACTIONS.TONE_TRAIN || action === 'tone_train') {
      const res = await sendToBackground(ACTIONS.TONE_TRAIN, { text, source: window.location.hostname })
      loadingOverlay?.remove()
      const name = res?.profile_name
      showToast(name ? `Tone sample saved to “${name}” 🎨` : 'Tone sample saved! 🎨', 'success')
    } else if (action === ACTIONS.STORE_MEMORY || action === 'store_memory') {
      await sendToBackground(ACTIONS.STORE_MEMORY, { text, source: window.location.hostname })
      loadingOverlay?.remove()
      showToast('Saved to EchoWrite memory 🧠', 'success')
    }
  } catch (err) {
    loadingOverlay?.remove()
    showToast(err.message || 'Something went wrong', 'error')
  }
}

function replaceSelection(text, snapshot) {
  if (applyTextReplacement(text, snapshot || lastSnapshot)) {
    showToast('Text replaced!', 'success')
    return
  }

  navigator.clipboard.writeText(text).then(() => {
    showToast('Could not replace in place — copied to clipboard', 'error')
  }).catch(() => {
    showToast('Could not replace text', 'error')
  })
}

/**
 * Autofill last saved context on custom LLMs (Perplexity, Grok, etc.).
 * Built-in AI tabs are handled by ai-platforms.js — skip those to avoid double fill.
 */
const AI_HOST_FRAGMENTS = [
  'chatgpt.com',
  'chat.openai.com',
  'claude.ai',
  'gemini.google.com',
  'chat.deepseek.com',
]
function isAiPlatformHost() {
  return AI_HOST_FRAGMENTS.some((h) => window.location.hostname.includes(h))
}

async function tryUniversalHandoffBootstrap() {
  if (isAiPlatformHost()) return

  try {
    const pending = await readStorage(STORAGE_KEYS.PENDING_BOOTSTRAP)
    if (!pending?.prompt) return
    if (Date.now() - (pending.timestamp || 0) > 5 * 60 * 1000) {
      await removeStorage(STORAGE_KEYS.PENDING_BOOTSTRAP)
      return
    }

    if (pending.url) {
      try {
        const host = new URL(pending.url).hostname.replace(/^www\./, '')
        const here = location.hostname.replace(/^www\./, '')
        if (!here.includes(host) && !host.includes(here)) return
      } catch {
        return
      }
    }

    let done = false
    const tryFill = () => {
      if (done) return
      if (/sign[_-]?in|login|auth/i.test(location.pathname)) return

      const preferred = [
        'textarea',
        '[contenteditable="true"][role="textbox"]',
        '[role="textbox"]',
        '[contenteditable="true"]',
      ]
      let input = null
      for (const sel of preferred) {
        input = Array.from(document.querySelectorAll(sel)).find((el) => {
          const r = el.getBoundingClientRect()
          return r.width > 80 && r.height > 18
        })
        if (input) break
      }
      if (!input) return

      done = true
      clearInterval(timer)
      input.focus()
      if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
        const proto =
          input.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, pending.prompt)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      } else {
        input.innerHTML = ''
        document.execCommand('insertText', false, pending.prompt)
        input.dispatchEvent(new InputEvent('input', { bubbles: true }))
      }
      removeStorage(STORAGE_KEYS.PENDING_BOOTSTRAP).catch(() => {})
      showToast('Saved context loaded — press Send to continue.', 'success')
    }

    const timer = setInterval(tryFill, 500)
    tryFill()
    setTimeout(() => clearInterval(timer), 5 * 60 * 1000)
  } catch {
    // ignore
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const { action, text, source } = message
  if (source === 'context_menu') {
    if (isAiPlatformHost()) return false

    const sel = window.getSelection()
    const snapshot = captureSelectionSnapshot(sel)
    const rect = snapshot?.rect || (sel && !sel.isCollapsed && sel.rangeCount > 0
      ? sel.getRangeAt(0).getBoundingClientRect()
      : {
          top: window.innerHeight / 2 - 60,
          bottom: window.innerHeight / 2 + 60,
          left: window.innerWidth / 2 - 250,
          right: window.innerWidth / 2 + 250,
        })

    handleAction(action, text, 'professional', snapshot, rect)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ error: err.message }))
    return true // keep connection open for async response
  }
})

init()
