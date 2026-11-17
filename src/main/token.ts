import { safeStorage } from 'electron'
import crypto from 'node:crypto'
import type { DatabaseStore } from './db'
import { logInfo } from './logger'

const TOKEN_KEY = 'bridgeToken'

export function generateBridgeToken(store: DatabaseStore): string {
  const token = crypto.randomBytes(32).toString('base64url')
  let stored: string
  if (safeStorage.isEncryptionAvailable()) {
    stored = `enc:${safeStorage.encryptString(token).toString('base64')}`
  } else {
    stored = `plain:${token}`
    logInfo('系统安全存储不可用，配对 token 以本机明文形式保存')
  }
  store.setSetting(TOKEN_KEY, stored)
  store.save()
  return token
}

export function getBridgeToken(store: DatabaseStore): string | null {
  const stored = store.getSetting(TOKEN_KEY)
  if (!stored) return null
  try {
    if (stored.startsWith('enc:')) {
      if (!safeStorage.isEncryptionAvailable()) return null
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    }
    if (stored.startsWith('plain:')) return stored.slice(6)
    return stored
  } catch {
    return null
  }
}

export function hasBridgeToken(store: DatabaseStore): boolean {
  return getBridgeToken(store) !== null
}
