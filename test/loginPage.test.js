import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderLogin, sendPage } from '../src/loginPage.js'

test('everything shown on the sign-in page is escaped', () => {
  const html = renderLogin({ request: '"><script>x</script>', clientName: '<img src=x onerror=alert(1)>', redirectHost: 'claude.ai', username: '"onfocus="x' })
  assert.ok(!html.includes('<script>x</script>'))
  assert.ok(!html.includes('<img src=x'))
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.ok(!html.includes('value=""onfocus'))
})

test('the page cannot be framed and its form only goes back to where it came from', () => {
  const sent = {}
  const res = {
    status (code) { sent.status = code; return this },
    set (headers) { sent.headers = headers; return this },
    type () { return this },
    send (body) { sent.body = body }
  }
  sendPage(res, 200, '<p>hi</p>', 'https://claude.ai/api/mcp/auth_callback')
  const csp = sent.headers['Content-Security-Policy']
  assert.equal(sent.status, 200)
  assert.match(csp, /frame-ancestors 'none'/)
  assert.match(csp, /form-action 'self' https:\/\/claude\.ai;/)
  assert.match(csp, /script-src 'unsafe-hashes' 'sha256-/)
  assert.equal(sent.headers['X-Frame-Options'], 'DENY')
})
