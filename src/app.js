import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { config } from './config.js'
import { handleLogin, provider } from './oauth.js'
import { limit } from './rateLimit.js'
import { registerTools } from './tools.js'

const app = express()
app.disable('x-powered-by')
// Vercel sits in front, so client IPs for rate limiting come from X-Forwarded-For.
app.set('trust proxy', 1)

// Registration is open by design, so it is limited per address across instances.
app.post('/register', limit('register', 20, 60 * 60 * 1000))

const baseUrl = new URL(config.baseUrl)
const mcpUrl = new URL('/mcp', baseUrl)

app.use(mcpAuthRouter({
  provider,
  issuerUrl: baseUrl,
  baseUrl,
  resourceServerUrl: mcpUrl,
  resourceName: 'Money Tracker',
  scopesSupported: ['money-tracker'],
  // Client secrets never expire, so a connector Claude registered keeps working.
  clientRegistrationOptions: { clientSecretExpirySeconds: 0 }
}))

app.post('/login', express.urlencoded({ extended: false }), (req, res, next) => {
  handleLogin(req, res).catch(next)
})

const bearer = requireBearerAuth({
  verifier: provider,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl)
})

// Stateless: every request gets its own server bound to the caller's account.
app.post('/mcp', bearer, express.json({ limit: '4mb' }), async (req, res) => {
  const server = new McpServer({ name: 'money-tracker', title: 'Money Tracker', version: '1.0.0' })
  registerTools(server, req.auth)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    transport.close()
    server.close()
  })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (error) {
    console.error('MCP request failed:', error)
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
    }
  }
})

app.all('/mcp', bearer, (req, res) => {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null })
})

app.get('/', (req, res) => {
  res.type('text').send(`Money Tracker MCP server.\nAdd ${mcpUrl.href} as a custom connector in Claude.`)
})

app.use((error, req, res, next) => {
  console.error(error)
  if (res.headersSent) return next(error)
  res.status(500).type('text').send('Something went wrong.')
})

export default app
