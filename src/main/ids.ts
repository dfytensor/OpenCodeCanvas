// CJS-safe id generator for the main process. nanoid is ESM-only and
// electron-vite externalizes dependencies, so the runtime require would
// crash — this is a drop-in replacement with the same shape (base62).
import { randomBytes } from 'crypto'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

export function nanoid(size = 21): string {
  const bytes = randomBytes(size)
  let id = ''
  for (let i = 0; i < size; i++) id += ALPHABET[bytes[i] % ALPHABET.length]
  return id
}
