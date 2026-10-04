import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export interface OccSettings {
  openrouterKey?: string
  lastProject?: string
}

function settingsFile(): string {
  return join(process.env.OCC_SETTINGS_DIR ?? process.env.HOME ?? process.env.USERPROFILE ?? '.', '.occ-settings.json')
}

export function readSettings(): OccSettings {
  try {
    return JSON.parse(readFileSync(settingsFile(), 'utf8')) as OccSettings
  } catch {
    return {}
  }
}

export function writeSettings(patch: Partial<OccSettings>): void {
  try {
    writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), ...patch }, null, 2), 'utf8')
  } catch { /* best-effort */ }
}
