import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { AppError, login } from './appApi.js'
import { config } from './config.js'
import { decrypt, encrypt, hashToken, jwtExpiry, randomToken } from './crypto.js'
import { collections } from './db.js'
import { renderLogin } from './loginPage.js'

const ACCESS_TTL = 60 * 60 * 1000
const REFRESH_TTL = 30 * 24 * 60 * 60 * 1000
const CODE_TTL = 5 * 60 * 1000
const SIGN_IN_TTL = 10 * 60 * 1000

const withoutId = doc => {
  if (!doc) return undefined
  const client = { ...doc }
  delete client._id
  delete client.createdAt
  return client
}

function redirectAllowed (uri) {
  try {
    const url = new URL(uri)
    const loopback = ['localhost', '127.0.0.1'].includes(url.hostname)
    if (!loopback && url.protocol !== 'https:') return false
    return config.allowedRedirectHosts.includes(url.hostname)
  } catch {
    return false
  }
}

const clientsStore = {
  async getClient (clientId) {
    const { clients } = await collections()
    return withoutId(await clients.findOne({ client_id: clientId }))
  },

  // Dynamic Client Registration. Only redirect hosts we trust may register, so a
  // stranger cannot create a client that sends sign-in codes to their own site.
  async registerClient (client) {
    const uris = client.redirect_uris || []
    if (!uris.length || !uris.every(redirectAllowed)) {
      throw new InvalidClientMetadataError(`redirect_uris must use one of: ${config.allowedRedirectHosts.join(', ')}`)
    }
    const { clients } = await collections()
    await clients.insertOne({ ...client, createdAt: new Date() })
    return client
  }
}

async function issueTokens ({ clientId, userId, userName, appSession, appSessionExpiresAt, scopes, resource }) {
  const { tokens } = await collections()
  const now = Date.now()
  const accessToken = randomToken()
  const refreshToken = randomToken()
  // Our refresh token cannot outlive the Money Tracker session it relies on.
  const refreshExpires = Math.min(now + REFRESH_TTL, appSessionExpiresAt || Infinity)
  const shared = { clientId, userId, userName, appSession, appSessionExpiresAt, scopes, resource }

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
      clientName: client.client_name || 'Claude',
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes || [],
      resource: params.resource?.href,
      expiresAt: Date.now() + SIGN_IN_TTL
    })
    res.status(200).type('html').send(renderLogin({
      request,
      clientName: client.client_name || 'Claude',
      redirectHost: new URL(params.redirectUri).host
    }))
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

  // Refresh tokens rotate: the used one is deleted and a new pair is issued.
  async exchangeRefreshToken (client, refreshToken) {
    const { tokens } = await collections()
    const doc = await tokens.findOneAndDelete({
      hash: hashToken(refreshToken),
      kind: 'refresh',
      clientId: client.client_id
    })
    if (!doc || doc.expiresAt < new Date()) throw new InvalidGrantError('Invalid or expired refresh token')
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
    await tokens.deleteOne({ hash: hashToken(token), clientId: client.client_id })
  }
}

// Handles the sign-in form shown by authorize(). The request blob is encrypted,
// so its contents (redirect URI, PKCE challenge) cannot be tampered with.
export async function handleLogin (req, res) {
  let request
  try {
    request = decrypt(req.body.request)
  } catch {
    return res.status(400).type('html').send(renderLogin({ fatal: 'This sign-in link is not valid. Start again from Claude.' }))
  }
  if (request.expiresAt < Date.now()) {
    return res.status(400).type('html').send(renderLogin({ fatal: 'This sign-in link expired. Start again from Claude.' }))
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

  if (!username || !password) {
    return res.status(400).type('html').send(renderLogin({ ...page, error: 'Enter your username and password.' }))
  }

  let session
  try {
    session = await login(username, password)
  } catch (error) {
    const message = error instanceof AppError ? error.message : 'Something went wrong. Try again.'
    return res.status(401).type('html').send(renderLogin({ ...page, error: message }))
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
