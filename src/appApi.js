import { config } from './config.js'
import { decrypt, hashToken, jwtExpiry } from './crypto.js'

export class AppError extends Error {}

const accessTokens = new Map()

async function send (path, { method = 'GET', body, token } = {}) {
  let response
  try {
    response = await fetch(`${config.appUrl}/api${path}`, {
      method,
      headers: {
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(token && { Authorization: `Bearer ${token}` })
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000)
    })
  } catch {
    throw new AppError('Money Tracker could not be reached. Try again in a moment.')
  }
  const json = await response.json().catch(() => null)
  return { status: response.status, ok: response.ok, json }
}

// A reply without the API's JSON means APP_URL points somewhere that is not the
// Money Tracker app, so the message names the host to make that obvious.
const errorText = (json, status) =>
  json?.error ||
  json?.body?.error ||
  `Money Tracker returned ${status} from ${new URL(config.appUrl).host}. Check that APP_URL is the Money Tracker app's URL.`

// Signs in on the user's behalf. Returns the app's long-lived session.
export async function login (username, password) {
  const { ok, status, json } = await send('/login', { method: 'POST', body: { username, password } })
  if (!ok) throw new AppError(errorText(json, status))
  return {
    refreshToken: json.body.refreshToken,
    user: json.body.user
  }
}

async function accessTokenFor (refreshToken, force = false) {
  const key = hashToken(refreshToken)
  const cached = accessTokens.get(key)
  if (!force && cached && cached.expiresAt - Date.now() > 60000) return cached.token

  const { ok, json } = await send('/refresh-token', { method: 'POST', body: { refreshToken } })
  if (!ok) {
    accessTokens.delete(key)
    throw new AppError('Your Money Tracker session ended. Remove and reconnect the connector in Claude to sign in again.')
  }
  const token = json.body.accessToken
  accessTokens.set(key, { token, expiresAt: jwtExpiry(token) || Date.now() + 50 * 60000 })
  return token
}

// A client bound to the signed-in user, built from the OAuth token's stored session.
export function appClient (auth) {
  const { appSession, userId, userName } = auth.extra
  const refreshToken = decrypt(appSession)

  async function call (path, options = {}) {
    let token = await accessTokenFor(refreshToken)
    let result = await send(path, { ...options, token })
    if (result.status === 401 || result.status === 403) {
      token = await accessTokenFor(refreshToken, true)
      result = await send(path, { ...options, token })
    }
    if (!result.ok) throw new AppError(errorText(result.json, result.status))
    return result.json
  }

  return { userId, userName, call }
}
