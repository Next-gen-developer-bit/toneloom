// EchoWrite Gmail Content Script
// Injects an EchoWrite action bar directly inside Gmail compose windows.
// Selection toolbar + context menu handling is covered by general.js (runs on all pages).

import {
  createTonePicker, getTonePickerValue,
  showLoadingInOverlay, showResultOverlay, showToast, sendToBackground,
} from './shared/toolbar.js'
import { ACTIONS } from '../utils/constants.js'

function init() {
  observeCompose()
}

/* ─── Observe Gmail Compose windows ─── */
function observeCompose() {
  const observer = new MutationObserver(() => {
    document.querySelectorAll('[aria-label="Message Body"][role="textbox"]').forEach(injectComposeToolbar)
  })
  observer.observe(document.body, { childList: true, subtree: true })
}

function injectComposeToolbar(composeBox) {
  if (composeBox.dataset.ewInjected) return
  composeBox.dataset.ewInjected = '1'

  const bar = document.createElement('div')
  bar.className = 'ew-compose-bar'
  bar.style.cssText = `
    display:flex; gap:6px; align-items:center; padding:6px 10px;
    background:#0f0f1a; border-top:1px solid rgba(139,92,246,0.2);
    font-family:'Inter',sans-serif;
  `
  bar.innerHTML = `
    <span style="font-size:11px;font-weight:700;color:#8b5cf6">ECHO</span>
    <button class="ew-btn ew-primary" data-action="rewrite">✍️ Rewrite</button>
    <button class="ew-btn" data-action="summarize">📝 Summarize</button>
    <button class="ew-btn" data-action="expand">📖 Expand</button>
    <span id="ew-gmail-tone-slot"></span>
    <button class="ew-btn ew-icon" data-action="train" title="Train tone">🎨</button>
    <button class="ew-btn ew-icon" data-action="memory" title="Save to memory">🧠</button>
  `

  const tonePicker = createTonePicker()
  bar.querySelector('#ew-gmail-tone-slot').replaceWith(tonePicker)

  const wrapper = composeBox.closest('[role="dialog"]') || composeBox.parentElement
  wrapper?.appendChild(bar)

  bar.addEventListener('click', async (e) => {
    if (e.target.closest('.ew-tone-picker, .ew-tone-menu')) return
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const text = composeBox.innerText.trim()
    if (!text) { showToast('No text in compose window', 'error'); return }
    const tone = getTonePickerValue(tonePicker)
    await handleAction(btn.dataset.action, text, tone, composeBox, composeBox.getBoundingClientRect())
  })
}

async function handleAction(action, text, tone, replaceTarget, rect) {
  const loadingOverlay = showLoadingInOverlay(action, rect)

  try {
    let result
    if (action === ACTIONS.REWRITE || action === 'rewrite') {
      result = await sendToBackground(ACTIONS.REWRITE, { text, tone })
      showResultOverlay(result.result, 'Rewrite', rect,
        (output) => replaceInTarget(output, replaceTarget), () => {})
    } else if (action === ACTIONS.SUMMARIZE || action === 'summarize') {
      result = await sendToBackground(ACTIONS.SUMMARIZE, { text })
      showResultOverlay(result.result, 'Summary', rect,
        (output) => replaceInTarget(output, replaceTarget), () => {})
    } else if (action === ACTIONS.EXPAND || action === 'expand') {
      result = await sendToBackground(ACTIONS.EXPAND, { text })
      showResultOverlay(result.result, 'Expanded', rect,
        (output) => replaceInTarget(output, replaceTarget), () => {})
    } else if (action === ACTIONS.TONE_TRAIN || action === 'train') {
      await sendToBackground(ACTIONS.TONE_TRAIN, { text, source: 'gmail' })
      loadingOverlay?.remove()
      showToast('Tone sample saved! ContextOS is learning your style. 🎨', 'success')
      return
    } else if (action === ACTIONS.STORE_MEMORY || action === 'memory') {
      await sendToBackground(ACTIONS.STORE_MEMORY, { text, source: 'gmail' })
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

function replaceInTarget(text, target) {
  if (target) {
    target.focus()
    target.innerText = text
    showToast('Email draft updated! ✨', 'success')
  }
}

init()
