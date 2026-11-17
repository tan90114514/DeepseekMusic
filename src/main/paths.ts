import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export function ensureAppDirs(): void {
  for (const dir of [getDataDir(), getLogDir(), getCacheDir()]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

export function getUserDataDir(): string {
  return app.getPath('userData')
}

export function getDataDir(): string {
  return path.join(getUserDataDir(), 'data')
}

export function getDbPath(): string {
  return path.join(getDataDir(), 'app.db')
}

export function getLogDir(): string {
  return path.join(getUserDataDir(), 'logs')
}

export function getLogPath(): string {
  return path.join(getLogDir(), 'main.log')
}

export function getCacheDir(): string {
  return path.join(getUserDataDir(), 'cache')
}

export function getExtensionDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'extension')
    : path.join(app.getAppPath(), 'extension')
}

export function getPreloadPath(): string {
  return path.join(__dirname, '../preload/index.js')
}

export function getRendererHtmlPath(): string {
  return path.join(__dirname, '../renderer/index.html')
}
