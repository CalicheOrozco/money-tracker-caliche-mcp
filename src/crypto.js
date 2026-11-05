import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { config } from './config.js'

const key = () => createHash('sha256').update(config.secret).digest()

export const randomToken = () => randomBytes(32).toString('base64url')

// Tokens are stored only as hashes, so a database leak does not expose them.
export const hashToken = token => createHash('sha256').update(token).digest('hex')

export function encrypt (value) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url')
}

export function decrypt (payload) {
  const raw = Buffer.from(String(payload), 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  const data = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()])
  return JSON.parse(data.toString('utf8'))
}

// Reads a JWT's expiry without verifying it; only used to cap our own token lifetimes.
export function jwtExpiry (token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    return payload.exp ? payload.exp * 1000 : null
  } catch {
    return null
  }
}
