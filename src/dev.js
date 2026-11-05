import app from './app.js'

const port = process.env.PORT || 8787
app.listen(port, () => console.log(`Money Tracker MCP on http://localhost:${port}/mcp`))
