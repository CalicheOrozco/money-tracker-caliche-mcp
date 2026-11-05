const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export function renderLogin ({ request, clientName, redirectHost, username = '', error, fatal }) {
  const body = fatal
    ? `<p class="error" role="alert">${escape(fatal)}</p>`
    : `
      <p class="lead"><strong>${escape(clientName)}</strong> wants to use your Money Tracker account: read and change your transactions, cards, budgets, goals and settings.</p>
      <p class="host">You will be sent back to <strong>${escape(redirectHost)}</strong></p>
      ${error ? `<p class="error" role="alert">${escape(error)}</p>` : ''}
      <form method="post" action="/login">
        <input type="hidden" name="request" value="${escape(request)}">
        <label>Username<input name="username" autocomplete="username" autocapitalize="none" value="${escape(username)}" required></label>
        <label>Password
          <span class="pw">
            <input name="password" type="password" autocomplete="current-password" required>
            <button type="button" class="eye" aria-label="Show password" onclick="const i=this.previousElementSibling;const s=i.type==='password';i.type=s?'text':'password';this.setAttribute('aria-label',s?'Hide password':'Show password');this.textContent=s?'Hide':'Show'">Show</button>
          </span>
        </label>
        <button class="primary" name="action" value="allow">Sign in and allow</button>
        <button class="secondary" name="action" value="deny" formnovalidate>Cancel</button>
      </form>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect Money Tracker</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap">
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:#090b0a;color:#e9efea;font:15px/1.5 Geist,system-ui,sans-serif}
  main{width:100%;max-width:400px;display:flex;flex-direction:column;gap:18px}
  .brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:17px}
  .logo{width:32px;height:32px;border-radius:9px;background:#34d27b;display:grid;place-items:center;color:#06110a;font-weight:700}
  h1{margin:0;font-size:26px;letter-spacing:-.02em}
  .lead{margin:0;color:#c9d1cb}
  .host{margin:0;font-size:13px;color:#8b958e}
  form{display:flex;flex-direction:column;gap:14px}
  label{display:flex;flex-direction:column;gap:7px;font-size:12px;font-weight:500;color:#8b958e}
  input{height:46px;padding:0 14px;border-radius:11px;background:#101412;border:1px solid #232b26;color:#e9efea;font:inherit;outline:none;width:100%}
  input:focus{border-color:#34d27b}
  .pw{position:relative;display:block}
  .pw input{padding-right:64px}
  .eye{position:absolute;right:6px;top:7px;height:32px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:#8b958e;font:inherit;font-size:12px;cursor:pointer}
  .primary{height:48px;border:0;border-radius:12px;background:#34d27b;color:#06110a;font:inherit;font-weight:600;cursor:pointer}
  .secondary{height:46px;border-radius:12px;background:transparent;border:1px solid #232b26;color:#e9efea;font:inherit;cursor:pointer}
  .error{margin:0;padding:12px 14px;border-radius:10px;background:rgba(242,109,109,.1);border:1px solid rgba(242,109,109,.25);color:#f59a9a}
  :focus-visible{outline:2px solid #34d27b;outline-offset:2px}
</style>
</head>
<body>
<main>
  <div class="brand"><span class="logo">$</span>Money Tracker</div>
  <h1>Connect to Claude</h1>
  ${body}
</main>
</body>
</html>`
}
