function required (name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

const trimSlash = url => url.replace(/\/+$/, '')

// Dates like "today" and "this month" follow this zone, since the server runs in UTC.
process.env.TZ = process.env.TIMEZONE || 'America/Moncton'

export const config = {
  // Public URL of this MCP server, e.g. https://money-tracker-mcp.vercel.app
  get baseUrl () {
    return trimSlash(required('BASE_URL'))
  },
  // Money Tracker app whose API this server calls, e.g. https://money-tracker.vercel.app
  get appUrl () {
    return trimSlash(required('APP_URL'))
  },
  get mongoUri () {
    return required('MONGODB_URI')
  },
  get mongoDb () {
    return process.env.MCP_DB || 'money-tracker-mcp'
  },
  // Encrypts the stored Money Tracker session and signed sign-in requests.
  get secret () {
    const value = required('MCP_SECRET')
    if (value.length < 32) throw new Error('MCP_SECRET must be at least 32 characters')
    return value
  },
  // Only these hosts may receive sign-in codes. Claude's web callback plus the
  // loopback hosts Claude Code uses.
  allowedRedirectHosts: (process.env.ALLOWED_REDIRECT_HOSTS || 'claude.ai,claude.com,localhost,127.0.0.1')
    .split(',')
    .map(host => host.trim())
    .filter(Boolean)
}
