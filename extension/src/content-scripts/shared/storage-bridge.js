// Content scripts loaded via dynamic import cannot access chrome.storage.
// Route storage reads/writes through the background service worker instead.

import { ACTIONS } from '../../utils/constants.js'
import { sendRuntimeMessage, isInvalidExtensionContextError } from './messaging.js'

export async function readStorage(key) {
  try {
    const res = await sendRuntimeMessage({ action: ACTIONS.GET_STORAGE, key })
    return res?.value ?? null
  } catch (err) {
    // Stale content script after extension reload — treat as empty settings.
    if (isInvalidExtensionContextError(err)) return null
    throw err
  }
}

export async function writeStorage(key, value) {
  try {
    await sendRuntimeMessage({ action: ACTIONS.SET_STORAGE, key, value })
  } catch (err) {
    if (isInvalidExtensionContextError(err)) return
    throw err
  }
}

export async function removeStorage(key) {
  try {
    await sendRuntimeMessage({ action: ACTIONS.REMOVE_STORAGE, key })
  } catch (err) {
    if (isInvalidExtensionContextError(err)) return
    throw err
  }
}
