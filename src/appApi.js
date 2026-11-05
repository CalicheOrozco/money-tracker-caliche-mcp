import { config } from './config.js'
import { decrypt, encrypt, hashToken, jwtExpiry } from './crypto.js'
import { collections } from './db.js'

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

// Access tokens are cached in memory and in the database, so a fresh serverless
// instance does not have to ask the app for a new one before every first call.
async function accessTokenFor (refreshToken, force = false) {
  const key = hashToken(refreshToken)
  const fresh = entry => entry && entry.expiresAt - Date.now() > 60000
  const { appAccess } = await collections()

  if (!force) {
    if (fresh(accessTokens.get(key))) return accessTokens.get(key).token
    const stored = await appAccess.findOne({ key })
    if (stored && fresh({ expiresAt: stored.expiresAt.getTime() })) {
      const token = decrypt(stored.token)
      accessTokens.set(key, { token, expiresAt: stored.expiresAt.getTime() })
      return token
    }
  }

  const { ok, json } = await send('/refresh-token', { method: 'POST', body: { refreshToken } })
  if (!ok) {
    accessTokens.delete(key)
    await appAccess.deleteOne({ key })
    throw new AppError('Your Money Tracker session ended. Remove and reconnect the connector in Claude to sign in again.')
  }
  const token = json.body.accessToken
  const expiresAt = jwtExpiry(token) || Date.now() + 50 * 60000
  accessTokens.set(key, { token, expiresAt })
  await appAccess.updateOne({ key }, { $set: { token: encrypt(token), expiresAt: new Date(expiresAt) } }, { upsert: true })
  return token
}

// Ends the Money Tracker session behind a connection. Failures are ignored: the
// session also expires on its own.
export async function endSession (refreshToken) {
  accessTokens.delete(hashToken(refreshToken))
  await (await collections()).appAccess.deleteOne({ key: hashToken(refreshToken) }).catch(() => {})
  await send('/signout', { method: 'DELETE', token: refreshToken }).catch(() => {})
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
