import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { AppError, endSession, login } from './appApi.js'
import { config } from './config.js'
import { decrypt, encrypt, hashToken, jwtExpiry, randomToken } from './crypto.js'
import { collections } from './db.js'
import { renderLogin, sendPage } from './loginPage.js'
import { hit, isBlocked } from './rateLimit.js'

const ACCESS_TTL = 60 * 60 * 1000
const REFRESH_TTL = 30 * 24 * 60 * 60 * 1000
const CODE_TTL = 5 * 60 * 1000
const SIGN_IN_TTL = 10 * 60 * 1000
const CLIENT_TTL = 90 * 24 * 60 * 60 * 1000
const LOGIN_WINDOW = 15 * 60 * 1000
const TRUSTED_HOSTS = ['claude.ai', 'claude.com']

const withoutId = doc => {
  if (!doc) return undefined
  const client = { ...doc }
  delete client._id
  delete client.createdAt
  delete client.expiresAt
  return client
}

function redirectAllowed (uri) {
  try {
    const url = new URL(uri)
    const loopback = ['localhost', '127.0.0.1'].includes(url.hostname)
    // Loopback only over http(s), so a custom scheme cannot hand the code to another app.
    if (loopback ? !['http:', 'https:'].includes(url.protocol) : url.protocol !== 'https:') return false
    return config.allowedRedirectHosts.includes(url.hostname)
  } catch {
    return false
  }
}

const clientsStore = {
  async getClient (clientId) {
    const { clients } = await collections()
    return withoutId(await clients.findOneAndUpdate(
      { client_id: clientId },
      { $set: { expiresAt: new Date(Date.now() + CLIENT_TTL) } },
      { returnDocument: 'after' }
    ))
  },

  // Dynamic Client Registration. Only redirect hosts we trust may register, so a
  // stranger cannot create a client that sends sign-in codes to their own site.
  async registerClient (client) {
    const uris = client.redirect_uris || []
    if (!uris.length || !uris.every(redirectAllowed)) {
      throw new InvalidClientMetadataError(`redirect_uris must use one of: ${config.allowedRedirectHosts.join(', ')}`)
    }
    const { clients } = await collections()
    await clients.insertOne({ ...client, createdAt: new Date(), expiresAt: new Date(Date.now() + CLIENT_TTL) })
    return client
  }
}

// The name a client registers is chosen by whoever registers it, so it is only
// trusted when the sign-in returns to Claude.
const displayName = (client, redirectUri) => {
  const host = new URL(redirectUri).hostname
  const trusted = TRUSTED_HOSTS.some(name => host === name || host.endsWith(`.${name}`))
  return trusted ? 'Claude' : `${client.client_name || 'An app'} (not verified)`
}

// Every token issued from one sign-in shares a family, so revoking or a reused
// refresh token ends all of them together with the Money Tracker session.
async function endFamily (doc) {
  const { tokens } = await collections()
  if (doc.family) await tokens.deleteMany({ family: doc.family })
  else await tokens.deleteOne({ hash: doc.hash })
  if (doc.appSession) {
    try {
      await endSession(decrypt(doc.appSession))
    } catch {
      // A session that cannot be read has nothing left to end.
    }
  }
}

async function issueTokens ({ clientId, userId, userName, appSession, appSessionExpiresAt, scopes, resource, family = randomToken() }) {
  const { tokens } = await collections()
  const now = Date.now()
  const accessToken = randomToken()
  const refreshToken = randomToken()
  // Our refresh token cannot outlive the Money Tracker session it relies on.
  const refreshExpires = Math.min(now + REFRESH_TTL, appSessionExpiresAt || Infinity)
  const shared = { clientId, userId, userName, appSession, appSessionExpiresAt, scopes, resource, family }

  await tokens.insertMany([
    { ...shared, kind: 'access', hash: hashToken(accessToken), expiresAt: new Date(now + ACCESS_TTL) },
    { ...shared, kind: 'refresh', hash: hashToken(refreshToken), expiresAt: new Date(refreshExpires) }
  ])

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL / 1000,
    refresh_token: refreshToken,
    scope: (scopes || []).join(' ')
  }
}

export const provider = {
  clientsStore,

  async authorize (client, params, res) {
    const request = encrypt({
      clientId: client.client_id,
      clientName: displayName(client, params.redirectUri),
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes || [],
      resource: params.resource?.href,
      expiresAt: Date.now() + SIGN_IN_TTL
    })
    sendPage(res, 200, renderLogin({
      request,
      clientName: displayName(client, params.redirectUri),
      redirectHost: new URL(params.redirectUri).host
    }), params.redirectUri)
  },

  async challengeForAuthorizationCode (client, code) {
    const { codes } = await collections()
    const doc = await codes.findOne({ hash: hashToken(code), clientId: client.client_id })
    if (!doc || doc.expiresAt < new Date()) throw new InvalidGrantError('Invalid or expired authorization code')
    return doc.codeChallenge
  },

  async exchangeAuthorizationCode (client, code, _verifier, redirectUri) {
    const { codes } = await collections()
    // Deleting on read makes every code single use.
    const doc = await codes.findOneAndDelete({ hash: hashToken(code), clientId: client.client_id })
    if (!doc || doc.expiresAt < new Date()) throw new InvalidGrantError('Invalid or expired authorization code')
    if (redirectUri && redirectUri !== doc.redirectUri) throw new InvalidGrantError('redirect_uri does not match')
    return issueTokens({ ...doc, clientId: client.client_id })
  },

  // Refresh tokens rotate. A used one is kept marked until it expires, so if it shows
  // up again (a sign it was stolen) the whole family is ended.
  async exchangeRefreshToken (client, refreshToken) {
    const { tokens } = await collections()
    const hash = hashToken(refreshToken)
    const doc = await tokens.findOneAndUpdate(
      { hash, kind: 'refresh', clientId: client.client_id, used: { $ne: true } },
      { $set: { used: true } }
    )
    if (!doc) {
      const reused = await tokens.findOne({ hash, kind: 'refresh', clientId: client.client_id })
      if (reused) await endFamily(reused)
      throw new InvalidGrantError('Invalid or expired refresh token')
    }
    if (doc.expiresAt < new Date()) throw new InvalidGrantError('Invalid or expired refresh token')
    return issueTokens(doc)
  },

  async verifyAccessToken (token) {
    const { tokens } = await collections()
    const doc = await tokens.findOne({ hash: hashToken(token), kind: 'access' })
    if (!doc || doc.expiresAt < new Date()) throw new InvalidTokenError('Invalid or expired access token')
    return {
      token,
      clientId: doc.clientId,
      scopes: doc.scopes || [],
      expiresAt: Math.floor(doc.expiresAt.getTime() / 1000),
      resource: doc.resource ? new URL(doc.resource) : undefined,
      extra: { userId: doc.userId, userName: doc.userName, appSession: doc.appSession }
    }
  },

  async revokeToken (client, { token }) {
    const { tokens } = await collections()
    const doc = await tokens.findOne({ hash: hashToken(token), clientId: client.client_id })
    if (doc) await endFamily(doc)
  }
}

// After a password change the old Money Tracker session no longer works, so every
// token that used it moves to the new one.
export async function replaceAppSession (oldEncrypted, refreshToken) {
  const { tokens } = await collections()
  await tokens.updateMany(
    { appSession: oldEncrypted },
    { $set: { appSession: encrypt(refreshToken), appSessionExpiresAt: jwtExpiry(refreshToken) } }
  )
}

// Handles the sign-in form shown by authorize(). The request blob is encrypted,
// so its contents (redirect URI, PKCE challenge) cannot be tampered with.
export async function handleLogin (req, res) {
  let request
  try {
    request = decrypt(req.body.request)
  } catch {
    return sendPage(res, 400, renderLogin({ fatal: 'This sign-in link is not valid. Start again from Claude.' }))
  }
  if (request.expiresAt < Date.now()) {
    return sendPage(res, 400, renderLogin({ fatal: 'This sign-in link expired. Start again from Claude.' }))
  }

  const back = new URL(request.redirectUri)
  if (request.state) back.searchParams.set('state', request.state)

  if (req.body.action === 'deny') {
    back.searchParams.set('error', 'access_denied')
    back.searchParams.set('error_description', 'The user declined access')
    return res.redirect(302, back.href)
  }

  const username = String(req.body.username || '').trim()
  const password = String(req.body.password || '')
  const page = { request: req.body.request, clientName: request.clientName, redirectHost: back.host, username }

  const show = (status, error) => sendPage(res, status, renderLogin({ ...page, error }), request.redirectUri)

  if (!username || !password) return show(400, 'Enter your username and password.')

  // Guesses are limited per address and per account, across all server instances.
  const accountKey = `mcp-login-user:${username.toLowerCase()}`
  if (await hit(`mcp-login-ip:${req.ip}`, 30, LOGIN_WINDOW) || await isBlocked(accountKey, 10)) {
    return show(429, 'Too many attempts. Wait a few minutes and try again.')
  }

  let session
  try {
    session = await login(username, password)
  } catch (error) {
    if (error instanceof AppError) await hit(accountKey, 10, LOGIN_WINDOW)
    const message = error instanceof AppError ? error.message : 'Something went wrong. Try again.'
    return show(401, message)
  }

  const code = randomToken()
  const { codes } = await collections()
  await codes.insertOne({
    hash: hashToken(code),
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    scopes: request.scopes,
    resource: request.resource,
    userId: String(session.user.id),
    userName: session.user.name,
    appSession: encrypt(session.refreshToken),
    appSessionExpiresAt: jwtExpiry(session.refreshToken),
    expiresAt: new Date(Date.now() + CODE_TTL)
  })

  back.searchParams.set('code', code)
  res.redirect(302, back.href)
}
