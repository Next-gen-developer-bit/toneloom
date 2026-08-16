// ToneLoom Notion Content Script
// Injects quick action badges on focused Notion editor blocks.
// Selection toolbar + context menu handling is covered by general.js (runs on all pages).

import {
  showLoadingInOverlay, showResultOverlay, showToast, sendToBackground,
} from './shared/toolbar.js'
import { ACTIONS } from '../utils/constants.js'

function init() {
  observeNotionEditor()
}

function observeNotionEditor() {
  const observer = new MutationObserver(() => {
    document.querySelectorAll('[contenteditable="true"][data-content-editable-leaf="true"]')
      .forEach(block => {
        if (block.dataset.ewInjected) return
        block.dataset.ewInjected = '1'
        block.addEventListener('focus', () => injectBlockActions(block))
      })
  })
  observer.observe(document.body, { childList: true, subtree: true })
}

function injectBlockActions(block) {
  let hint = block.parentElement?.querySelector('.ew-block-hint')
  if (hint) return

  hint = document.createElement('div')
  hint.className = 'ew-block-hint'
  hint.style.cssText = `
    display: inline-flex; align-items: center; gap: 4px; margin-left: 8px;
    vertical-align: middle; opacity: 0.7;
  `
  hint.innerHTML = `
    <span class="ew-context-badge" data-action="rewrite">✍️ Rewrite</span>
    <span class="ew-context-badge" data-action="summarize">📝 Sum</span>
    <span class="ew-context-badge" data-action="expand">📖 Expand</span>
    <span class="ew-context-badge" data-action="memory">🧠 Save</span>
  `

  block.parentElement?.appendChild(hint)

  hint.addEventListener('click', async (e) => {
    const badge = e.target.closest('[data-action]')
    if (!badge) return
    const text = block.innerText.trim()
    if (!text) { showToast('Block is empty', 'error'); return }
    const rect = block.getBoundingClientRect()
    await handleAction(badge.dataset.action, text, 'professional', block, rect)
  })

  block.addEventListener('blur', () => {
    setTimeout(() => hint.remove(), 200)
  }, { once: true })
}

async function handleAction(action, text, tone, replaceTarget, rect) {
  const loadingOverlay = showLoadingInOverlay(action, rect)
  try {
    if (action === ACTIONS.REWRITE || action === 'rewrite') {
      const res = await sendToBackground(ACTIONS.REWRITE, { text, tone })
      loadingOverlay?.remove()
      showResultOverlay(res.result, 'Rewrite', rect,
        (out) => replaceInNotion(out, replaceTarget), () => {})
    } else if (action === ACTIONS.SUMMARIZE || action === 'summarize') {
      const res = await sendToBackground(ACTIONS.SUMMARIZE, { text })
      loadingOverlay?.remove()
      showResultOverlay(res.result, 'Summary', rect,
        (out) => replaceInNotion(out, replaceTarget), () => {})
    } else if (action === ACTIONS.EXPAND || action === 'expand') {
      const res = await sendToBackground(ACTIONS.EXPAND, { text })
      loadingOverlay?.remove()
      showResultOverlay(res.result, 'Expanded', rect,
        (out) => replaceInNotion(out, replaceTarget), () => {})
    } else if (action === ACTIONS.TONE_TRAIN || action === 'train') {
      await sendToBackground(ACTIONS.TONE_TRAIN, { text, source: 'notion' })
      loadingOverlay?.remove()
      showToast('Tone sample saved to ToneLoom 🎨', 'success')
    } else if (action === ACTIONS.STORE_MEMORY || action === 'memory') {
      await sendToBackground(ACTIONS.STORE_MEMORY, { text, source: 'notion' })
      loadingOverlay?.remove()
      showToast('Saved to ToneLoom memory 🧠', 'success')
    }
  } catch (err) {
    loadingOverlay?.remove()
    showToast(err.message || 'Something went wrong', 'error')
  }
}

function replaceInNotion(newText, target) {
  if (target) {
    target.focus()
    document.execCommand('selectAll', false, null)
    document.execCommand('insertText', false, newText)
  } else {
    const sel = window.getSelection()
    if (!sel?.rangeCount) return
    document.execCommand('insertText', false, newText)
  }
  showToast('Block updated! ✨', 'success')
}

init()
