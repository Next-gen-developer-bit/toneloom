// ToneLoom Shared Toolbar — used by Gmail, Notion, AI platform content scripts

import { sendRuntimeMessage } from './messaging.js'

export const TONES = [
  { id: 'my_style', label: '✍️ My style' },
  { id: 'professional', label: '💼 Professional' },
  { id: 'casual', label: '😊 Casual' },
  { id: 'concise', label: '⚡ Concise' },
  { id: 'friendly', label: '🤝 Friendly' },
  { id: 'formal', label: '🎩 Formal' },
  { id: 'persuasive', label: '🎯 Persuasive' },
]

/**
 * Custom tone dropdown — native <select> fails in Gmail compose (overflow/focus)
 * and when toolbar mousedown is preventDefault'd to preserve text selection.
 */
export function createTonePicker({ value = 'my_style', onChange } = {}) {
  const wrap = document.createElement('div')
  wrap.className = 'ew-tone-picker'
  wrap.dataset.tone = value

  const initial = TONES.find((t) => t.id === value) || TONES[0]

  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'ew-tone-trigger'
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.title = 'Choose writing tone'
  trigger.innerHTML = `<span class="ew-tone-label">${initial.label}</span><span class="ew-tone-caret">▾</span>`

  const menu = document.createElement('div')
  menu.className = 'ew-tone-menu ew-hidden'
  menu.setAttribute('role', 'listbox')
  menu.innerHTML = TONES.map(
    (t) =>
      `<button type="button" class="ew-tone-option${t.id === initial.id ? ' ew-tone-option-active' : ''}" role="option" data-tone-id="${t.id}" aria-selected="${t.id === initial.id}">${t.label}</button>`
  ).join('')

  wrap.appendChild(trigger)

  const labelEl = () => trigger.querySelector('.ew-tone-label')
  let open = false

  function setValue(id) {
    const tone = TONES.find((t) => t.id === id)
    if (!tone) return
    wrap.dataset.tone = id
    labelEl().textContent = tone.label
    menu.querySelectorAll('.ew-tone-option').forEach((el) => {
      const active = el.dataset.toneId === id
      el.classList.toggle('ew-tone-option-active', active)
      el.setAttribute('aria-selected', active ? 'true' : 'false')
    })
    onChange?.(id)
  }

  function closeMenu() {
    if (!open) return
    open = false
    menu.classList.add('ew-hidden')
    trigger.setAttribute('aria-expanded', 'false')
    if (menu.parentElement === document.body) {
      wrap.appendChild(menu)
    }
  }

  function openMenu() {
    if (open) return
    open = true
    // Portal to body so Gmail overflow:hidden parents can't clip the list
    document.body.appendChild(menu)
    const rect = trigger.getBoundingClientRect()
    menu.style.position = 'fixed'
    menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 8)}px`
    menu.style.left = `${Math.min(rect.left, window.innerWidth - 180)}px`
    menu.style.zIndex = '2147483647'
    menu.classList.remove('ew-hidden')
    trigger.setAttribute('aria-expanded', 'true')

    // Flip upward if near bottom of viewport
    requestAnimationFrame(() => {
      const menuRect = menu.getBoundingClientRect()
      if (menuRect.bottom > window.innerHeight - 8) {
        menu.style.top = `${Math.max(8, rect.top - menuRect.height - 4)}px`
      }
    })
  }

  trigger.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  trigger.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (open) closeMenu()
    else openMenu()
  })

  menu.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  menu.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const opt = e.target.closest('[data-tone-id]')
    if (!opt) return
    setValue(opt.dataset.toneId)
    closeMenu()
  })

  const onDocClick = (e) => {
    if (!open) return
    if (wrap.contains(e.target) || menu.contains(e.target)) return
    closeMenu()
  }
  document.addEventListener('click', onDocClick, true)

  wrap._ewTonePicker = {
    getValue: () => wrap.dataset.tone || 'my_style',
    setValue,
    close: closeMenu,
    destroy: () => document.removeEventListener('click', onDocClick, true),
  }

  return wrap
}

export function getTonePickerValue(root) {
  const picker = root?.querySelector?.('.ew-tone-picker') || (root?.classList?.contains('ew-tone-picker') ? root : null)
  return picker?._ewTonePicker?.getValue?.() || picker?.dataset?.tone || 'my_style'
}

export function createToolbar({ onRewrite, onSummarize, onExpand, onTrainTone, onSaveMemory, onOpenPanel, defaultTone = 'my_style' }) {
  const el = document.createElement('div')
  el.id = 'echowrite-toolbar'
  el._ewUserMoved = false

  el.innerHTML = `
    <span class="ew-drag-handle" id="ew-toolbar-drag" title="Drag to move toolbar" aria-label="Drag to move">⋮⋮</span>
    <span class="ew-brand" id="ew-toolbar-brand" title="Drag to move toolbar"><img class="ew-brand-mark" src="${chrome.runtime.getURL('icons/icon32.png')}" alt="ToneLoom" /></span>
    <div class="ew-divider"></div>
    <button class="ew-btn ew-primary" id="ew-rewrite-btn">✍️ Rewrite</button>
    <button class="ew-btn" id="ew-summarize-btn">📝 Summarize</button>
    <button class="ew-btn" id="ew-expand-btn">📖 Expand</button>
    <div class="ew-divider"></div>
    <span id="ew-tone-slot"></span>
    <div class="ew-divider"></div>
    <button class="ew-btn ew-icon" id="ew-train-btn" title="Train tone with selection">🎨</button>
    <button class="ew-btn ew-icon" id="ew-memory-btn" title="Save to memory">🧠</button>
    <button class="ew-btn ew-icon" id="ew-panel-btn" title="Open ToneLoom panel">⚡</button>
    <button class="ew-btn ew-icon" id="ew-close-btn" title="Close toolbar">✕</button>
  `

  const tonePicker = createTonePicker({ value: defaultTone })
  el.querySelector('#ew-tone-slot').replaceWith(tonePicker)
  el._ewTonePicker = tonePicker._ewTonePicker

  const getTone = () => getTonePickerValue(tonePicker)

  el.querySelector('#ew-rewrite-btn').addEventListener('click', () => onRewrite(getTone()))
  el.querySelector('#ew-summarize-btn').addEventListener('click', () => onSummarize())
  el.querySelector('#ew-expand-btn').addEventListener('click', () => onExpand())
  el.querySelector('#ew-train-btn').addEventListener('click', () => onTrainTone())
  el.querySelector('#ew-memory-btn').addEventListener('click', () => onSaveMemory())
  el.querySelector('#ew-panel-btn').addEventListener('click', () => onOpenPanel())
  el.querySelector('#ew-close-btn').addEventListener('click', () => hideToolbar(el))

  // Keep page selection; allow tone picker mousedown so the menu can open.
  // Drag handle / brand manage their own mousedown for moving.
  el.addEventListener('mousedown', (e) => {
    if (e.target.closest('.ew-tone-picker, .ew-tone-menu, #ew-toolbar-drag, #ew-toolbar-brand, .ew-drag-handle, .ew-brand')) return
    e.preventDefault()
  })

  makeToolbarDraggable(el)
  return el
}

export function positionToolbar(toolbar, selectionRect, { force = false } = {}) {
  // After the user drags, keep their spot until the toolbar is hidden.
  if (toolbar?._ewUserMoved && !force) return

  // Toolbar is position:fixed — use viewport coordinates only (no scrollY/X).
  const margin = 8
  const width = toolbar.offsetWidth || 420
  const height = toolbar.offsetHeight || 48

  let top = selectionRect.top - height - margin
  if (top < 8) {
    top = selectionRect.bottom + margin
  }
  // Keep inside the viewport
  top = Math.min(top, window.innerHeight - height - 8)
  top = Math.max(8, top)

  let left = selectionRect.left
  left = Math.min(left, window.innerWidth - width - 16)
  left = Math.max(8, left)

  toolbar.style.position = 'fixed'
  toolbar.style.top = `${Math.round(top)}px`
  toolbar.style.left = `${Math.round(left)}px`
  toolbar.style.right = 'auto'
  toolbar.style.bottom = 'auto'
}

export function showToolbar(toolbar) {
  toolbar.classList.remove('ew-hidden')
}

export function hideToolbar(toolbar) {
  if (!toolbar) return
  toolbar.classList.add('ew-hidden')
  toolbar._ewUserMoved = false
  toolbar.classList.remove('ew-dragging')
}

/** Drag the floating toolbar anywhere in the viewport (handle = grip + ToneLoom mark). */
function makeToolbarDraggable(toolbar) {
  const handles = [
    toolbar.querySelector('#ew-toolbar-drag'),
    toolbar.querySelector('#ew-toolbar-brand'),
  ].filter(Boolean)
  if (!handles.length) return

  let dragging = false
  let moved = false
  let startX = 0
  let startY = 0
  let originLeft = 0
  let originTop = 0

  const onMove = (e) => {
    if (!dragging) return
    const dx = e.clientX - startX
    const dy = e.clientY - startY
    if (!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) moved = true
    const margin = 8
    const maxLeft = window.innerWidth - toolbar.offsetWidth - margin
    const maxTop = window.innerHeight - toolbar.offsetHeight - margin
    const nextLeft = Math.min(Math.max(margin, originLeft + dx), Math.max(margin, maxLeft))
    const nextTop = Math.min(Math.max(margin, originTop + dy), Math.max(margin, maxTop))
    toolbar.style.left = `${nextLeft}px`
    toolbar.style.top = `${nextTop}px`
    toolbar.style.right = 'auto'
    toolbar.style.bottom = 'auto'
  }

  const onUp = () => {
    if (!dragging) return
    dragging = false
    toolbar.classList.remove('ew-dragging')
    document.removeEventListener('mousemove', onMove, true)
    document.removeEventListener('mouseup', onUp, true)
    if (moved) toolbar._ewUserMoved = true
    moved = false
  }

  const onDown = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragging = true
    moved = false
    toolbar.classList.add('ew-dragging')
    startX = e.clientX
    startY = e.clientY
    const rect = toolbar.getBoundingClientRect()
    originLeft = rect.left
    originTop = rect.top
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', onUp, true)
  }

  handles.forEach((handle) => {
    handle.addEventListener('mousedown', onDown)
  })
}

export function showResultOverlay(text, actionLabel, selectionRect, onAccept, onReject) {
  let overlay = document.getElementById('echowrite-result-overlay')
  if (overlay) overlay.remove()

  overlay = document.createElement('div')
  overlay.id = 'echowrite-result-overlay'
  overlay.innerHTML = `
    <div class="ew-overlay-header" id="ew-overlay-drag">
      <span class="ew-overlay-title">✨ ${actionLabel} Result</span>
      <span class="ew-overlay-drag-hint" title="Drag to move">⋮⋮</span>
      <button class="ew-btn ew-icon" id="ew-overlay-close" title="Close">✕</button>
    </div>
    <div class="ew-overlay-body" id="ew-overlay-text">${escapeHTML(text)}</div>
    <div class="ew-overlay-footer">
      <button class="ew-btn ew-primary" id="ew-overlay-accept">✅ Replace Text</button>
      <button class="ew-btn" id="ew-overlay-copy">📋 Copy</button>
      <button class="ew-btn ew-icon" id="ew-overlay-reject">✕ Discard</button>
    </div>
  `

  document.body.appendChild(overlay)
  positionOverlayInViewport(overlay, selectionRect)
  makeOverlayDraggable(overlay)

  overlay.querySelector('#ew-overlay-accept').addEventListener('mousedown', (e) => e.preventDefault())
  overlay.querySelector('#ew-overlay-copy').addEventListener('mousedown', (e) => e.preventDefault())
  overlay.querySelector('#ew-overlay-reject').addEventListener('mousedown', (e) => e.preventDefault())
  overlay.querySelector('#ew-overlay-close').addEventListener('mousedown', (e) => e.preventDefault())

  overlay.querySelector('#ew-overlay-accept').addEventListener('click', () => { onAccept(text); overlay.remove() })
  overlay.querySelector('#ew-overlay-copy').addEventListener('click', () => { navigator.clipboard.writeText(text); showToast('Copied!', 'success') })
  overlay.querySelector('#ew-overlay-reject').addEventListener('click', () => overlay.remove())
  overlay.querySelector('#ew-overlay-close').addEventListener('click', () => overlay.remove())
}

export function showLoadingInOverlay(actionLabel, selectionRect) {
  let overlay = document.getElementById('echowrite-result-overlay')
  if (overlay) overlay.remove()
  overlay = document.createElement('div')
  overlay.id = 'echowrite-result-overlay'
  overlay.innerHTML = `
    <div class="ew-overlay-header" id="ew-overlay-drag">
      <span class="ew-overlay-title">⏳ ${actionLabel}...</span>
      <span class="ew-overlay-drag-hint" title="Drag to move">⋮⋮</span>
    </div>
    <div class="ew-overlay-body" style="display:flex;align-items:center;gap:10px;">
      <span class="ew-spinner"></span>
      <span style="color:#94a3b8;font-size:13px;">ToneLoom is thinking...</span>
    </div>
  `
  document.body.appendChild(overlay)
  positionOverlayInViewport(overlay, selectionRect)
  makeOverlayDraggable(overlay)
  return overlay
}

/** Place overlay in the viewport (fixed coords) and keep the full card on-screen. */
function positionOverlayInViewport(overlay, selectionRect) {
  const margin = 12
  const width = Math.min(overlay.offsetWidth || 360, window.innerWidth - margin * 2)
  let left = (selectionRect?.left ?? 24)
  let top = (selectionRect?.bottom ?? 80) + 8

  // Prefer above the selection when there isn't room below
  const estimatedHeight = overlay.offsetHeight || 220
  if (top + estimatedHeight > window.innerHeight - margin) {
    top = (selectionRect?.top ?? estimatedHeight + 24) - estimatedHeight - 8
  }

  left = Math.min(Math.max(margin, left), window.innerWidth - width - margin)
  top = Math.min(Math.max(margin, top), window.innerHeight - estimatedHeight - margin)

  overlay.style.left = `${left}px`
  overlay.style.top = `${top}px`
  overlay.style.right = 'auto'
  overlay.style.bottom = 'auto'
}

/** Drag the result card by its header so readers can reposition it. */
function makeOverlayDraggable(overlay) {
  const handle = overlay.querySelector('#ew-overlay-drag') || overlay.querySelector('.ew-overlay-header')
  if (!handle) return

  let dragging = false
  let startX = 0
  let startY = 0
  let originLeft = 0
  let originTop = 0

  const onMove = (e) => {
    if (!dragging) return
    const dx = e.clientX - startX
    const dy = e.clientY - startY
    const margin = 8
    const maxLeft = window.innerWidth - overlay.offsetWidth - margin
    const maxTop = window.innerHeight - overlay.offsetHeight - margin
    const nextLeft = Math.min(Math.max(margin, originLeft + dx), Math.max(margin, maxLeft))
    const nextTop = Math.min(Math.max(margin, originTop + dy), Math.max(margin, maxTop))
    overlay.style.left = `${nextLeft}px`
    overlay.style.top = `${nextTop}px`
  }

  const onUp = () => {
    if (!dragging) return
    dragging = false
    overlay.classList.remove('ew-dragging')
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }

  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    if (e.target.closest('button, a, input, textarea, select')) return
    e.preventDefault()
    dragging = true
    overlay.classList.add('ew-dragging')
    startX = e.clientX
    startY = e.clientY
    const rect = overlay.getBoundingClientRect()
    originLeft = rect.left
    originTop = rect.top
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  })
}

export function showToast(msg, type = 'success') {
  let t = document.querySelector('.ew-toast')
  if (t) t.remove()
  t = document.createElement('div')
  t.className = `ew-toast ew-toast-${type}`
  t.innerHTML = `<span>${type === 'success' ? '✅' : '❌'}</span> <span>${escapeHTML(msg)}</span>`
  document.body.appendChild(t)
  setTimeout(() => t.remove(), 3000)
}

/**
 * Snapshot the current selection so Replace Text still works after the
 * overlay click steals focus (common on Claude / ProseMirror / contenteditable).
 */
export function captureSelectionSnapshot(selection = window.getSelection()) {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const text = selection.toString()
  if (!text.trim()) return null

  let range = null
  try {
    range = selection.getRangeAt(0).cloneRange()
  } catch {
    range = null
  }

  const node = selection.anchorNode?.nodeType === Node.ELEMENT_NODE
    ? selection.anchorNode
    : selection.anchorNode?.parentElement

  const editable =
    node?.closest?.(
      '[contenteditable="true"], textarea, input[type="text"], input:not([type]), [role="textbox"]'
    ) || null

  let inputStart = null
  let inputEnd = null
  if (editable && (editable.tagName === 'TEXTAREA' || editable.tagName === 'INPUT')) {
    inputStart = editable.selectionStart
    inputEnd = editable.selectionEnd
  }

  return {
    text,
    range,
    editable,
    inputStart,
    inputEnd,
    rect: range ? range.getBoundingClientRect() : null,
  }
}

/**
 * Replace previously selected text. Returns true on success.
 * Prefer restoring the saved Range + execCommand('insertText') so React /
 * ProseMirror editors (Claude, ChatGPT) update their internal state.
 */
export function applyTextReplacement(newText, snapshot = null) {
  const text = String(newText ?? '')
  if (!text) return false

  const editable = snapshot?.editable || null

  // 1) Native <textarea> / <input> with saved indices
  if (
    editable &&
    (editable.tagName === 'TEXTAREA' || editable.tagName === 'INPUT') &&
    typeof snapshot?.inputStart === 'number' &&
    typeof snapshot?.inputEnd === 'number'
  ) {
    try {
      editable.focus()
      const value = editable.value ?? ''
      const start = snapshot.inputStart
      const end = snapshot.inputEnd
      const next = `${value.slice(0, start)}${text}${value.slice(end)}`
      const proto =
        editable.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      setter?.call(editable, next)
      editable.value = next
      const caret = start + text.length
      editable.setSelectionRange(caret, caret)
      editable.dispatchEvent(new Event('input', { bubbles: true }))
      editable.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    } catch {
      // fall through
    }
  }

  // 2) Restore Range (contenteditable / ProseMirror / pages)
  if (snapshot?.range) {
    try {
      const host =
        editable ||
        snapshot.range.commonAncestorContainer?.parentElement ||
        document.activeElement
      if (host && typeof host.focus === 'function') {
        try {
          host.focus({ preventScroll: true })
        } catch {
          host.focus()
        }
      }

      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(snapshot.range.cloneRange())

      // Best path for React / ProseMirror — replaces the live selection.
      if (document.execCommand('insertText', false, text)) {
        host?.dispatchEvent?.(
          new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            data: text,
            inputType: 'insertText',
          })
        )
        return true
      }

      // Fallback: mutate the range directly
      const range = snapshot.range.cloneRange()
      range.deleteContents()
      const node = document.createTextNode(text)
      range.insertNode(node)
      range.setStartAfter(node)
      range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(range)
      host?.dispatchEvent?.(
        new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          data: text,
          inputType: 'insertText',
        })
      )
      return true
    } catch {
      // fall through
    }
  }

  // 3) Whole contenteditable / field when we only have the host
  if (editable) {
    try {
      editable.focus()
      if (editable.tagName === 'TEXTAREA' || editable.tagName === 'INPUT') {
        const proto =
          editable.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        setter?.call(editable, text)
        editable.value = text
        editable.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }
      if (editable.isContentEditable || editable.getAttribute?.('contenteditable') === 'true') {
        document.execCommand('selectAll', false, null)
        if (document.execCommand('insertText', false, text)) {
          editable.dispatchEvent(
            new InputEvent('input', {
              bubbles: true,
              cancelable: true,
              data: text,
              inputType: 'insertText',
            })
          )
          return true
        }
        editable.textContent = text
        editable.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            data: text,
            inputType: 'insertText',
          })
        )
        return true
      }
    } catch {
      // fall through
    }
  }

  // 4) Last chance: whatever is selected right now
  try {
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      if (document.execCommand('insertText', false, text)) return true
      const range = sel.getRangeAt(0)
      range.deleteContents()
      range.insertNode(document.createTextNode(text))
      return true
    }
  } catch {
    // ignore
  }

  return false
}

function escapeHTML(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

export async function sendToBackground(action, data = {}) {
  return sendRuntimeMessage({ action, ...data })
}
