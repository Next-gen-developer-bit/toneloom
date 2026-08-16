// Shared messaging helpers for content scripts.
// After an extension reload/update, open tabs keep stale content scripts whose
// chrome.runtime handle is dead ("Extension context invalidated").

const INVALID_CONTEXT_RE = /extension context invalidated|message port closed|receiving end does not exist/i

let refreshHintShown = false

export function isExtensionContextValid() {
  try {
    return Boolean(chrome?.runtime?.id)
  } catch {
    return false
  }
}

export function isInvalidExtensionContextError(err) {
  const msg = typeof err === 'string' ? err : err?.message || ''
  return INVALID_CONTEXT_RE.test(msg)
}

export function notifyRefreshRequired() {
  if (refreshHintShown || typeof document === 'undefined') return
  refreshHintShown = true

  const existing = document.getElementById('echowrite-refresh-hint')
  if (existing) existing.remove()

  const el = document.createElement('div')
  el.id = 'echowrite-refresh-hint'
  el.textContent = 'ToneLoom was updated — refresh this page to keep using it.'
  el.style.cssText = [
    'position:fixed',
    'bottom:24px',
    'right:24px',
    'z-index:2147483647',
    'padding:12px 16px',
    'border-radius:10px',
    'font:500 13px/1.4 system-ui,-apple-system,sans-serif',
    'color:#fff',
    'background:#7c3aed',
    'box-shadow:0 8px 24px rgba(0,0,0,.25)',
    'max-width:320px',
    'cursor:pointer',
  ].join(';')
  el.title = 'Click to refresh this page'
  el.addEventListener('click', () => window.location.reload())
  document.documentElement.appendChild(el)
  setTimeout(() => el.remove(), 8000)
}

export function sendRuntimeMessage(payload) {
  return new Promise((resolve, reject) => {
    if (!isExtensionContextValid()) {
      notifyRefreshRequired()
      reject(new Error('Extension context invalidated. Refresh this page.'))
      return
    }

    try {
      chrome.runtime.sendMessage(payload, (res) => {
        const lastError = chrome.runtime.lastError
        if (lastError) {
          const message = lastError.message || 'Extension messaging failed'
          if (isInvalidExtensionContextError(message)) notifyRefreshRequired()
          reject(new Error(message))
          return
        }
        if (res?.error) {
          reject(new Error(res.error))
          return
        }
        resolve(res)
      })
    } catch (err) {
      if (isInvalidExtensionContextError(err)) notifyRefreshRequired()
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}
