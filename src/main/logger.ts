import fs from 'node:fs'
import { getLogPath } from './paths'

function scrub(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/(cookie\s*:\s*)[^\r\n]+/gi, '$1[redacted]')
    .replace(/(SESSDATA=)[^;,\s]+/gi, '$1[redacted]')
}

function write(level: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${scrub(message)}\n`
  try {
    fs.appendFileSync(getLogPath(), line, 'utf8')
  } catch {
    // Logging must never crash the app.
  }
  if (level === 'ERROR') console.error(line.trim())
  else console.log(line.trim())
}

export function logInfo(message: string): void {
  write('INFO', message)
}

export function logError(context: string, error: unknown): void {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  write('ERROR', `${context}: ${message}`)
}
