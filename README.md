# Money Tracker MCP

Remote MCP server that lets Claude (claude.ai on the web and mobile, Claude Desktop, and Claude Code) do everything the Money Tracker app can do, signed in as you.

It calls the Money Tracker API on your behalf. It never touches the app's database directly; its own database only holds OAuth clients and tokens.

## How sign-in works

1. In Claude you add `https://<this-server>/mcp` as a custom connector.
2. Claude registers itself (OAuth Dynamic Client Registration) and opens this server's sign-in page.
3. You sign in with your Money Tracker username and password. The server keeps the resulting app session encrypted and gives Claude its own tokens.
4. Access tokens last an hour and refresh tokens rotate on every use. When the Money Tracker session ends (30 days), Claude asks you to sign in again.

Only redirect hosts in `ALLOWED_REDIRECT_HOSTS` (Claude's by default) can register, so nobody can use this sign-in page to send codes to another site.

## Environment variables

| Name | Purpose |
| --- | --- |
| `BASE_URL` | Public URL of this server, no trailing slash |
| `APP_URL` | URL of the Money Tracker app |
| `MONGODB_URI` | MongoDB for OAuth clients and tokens. The app's cluster works |
| `MCP_DB` | Database name, default `money-tracker-mcp` |
| `MCP_SECRET` | 32+ random characters, encrypts stored sessions. `openssl rand -base64 48` |
| `TIMEZONE` | Zone for "today" and "this month", default `America/Moncton` (Atlantic time) |
| `ALLOWED_REDIRECT_HOSTS` | Optional, default `claude.ai,claude.com,localhost,127.0.0.1` |

Changing `MCP_SECRET` signs everyone out of the connector.

## Run locally

```bash
nvm use
npm install
cp .env.example .env   # fill it in
npm run dev            # http://localhost:8787/mcp
```

## Deploy on Vercel

1. Create a Vercel project from this folder and set the variables above (mark `MONGODB_URI` and `MCP_SECRET` as Sensitive).
2. Set `BASE_URL` to the project's production URL and redeploy.
3. In Claude: Settings, Connectors, Add custom connector, paste `https://<your-project>.vercel.app/mcp`, then Connect and sign in.

## Tools

| Area | Tools |
| --- | --- |
| Transactions | `list_transactions`, `create_transaction`, `update_transaction`, `delete_transaction`, `import_transactions`, `delete_all_transactions`, `list_categories`, `list_tags` |
| Reports | `get_summary`, `get_monthly_report`, `get_cashflow` |
| Cards | `list_cards`, `save_card`, `remove_card` |
| Budgets | `list_budgets`, `set_budget`, `delete_budget` |
| Goals | `list_goals`, `create_goal`, `update_goal`, `add_to_goal`, `delete_goal` |
| Debts | `list_debts`, `create_debt`, `update_debt`, `settle_debt`, `delete_debt` |
| Net worth | `get_net_worth`, `add_holding`, `update_holding`, `delete_holding` |
| Rules | `list_rules`, `create_rule`, `delete_rule`, `apply_rules` |
| Merchants | `list_merchants`, `list_unmatched_merchants`, `create_merchant`, `update_merchant`, `delete_merchant` |
| Transfers | `list_transfers`, `create_transfer`, `update_transfer`, `delete_transfer`, `list_transfer_suggestions`, `convert_to_transfer`, `dismiss_transfer_suggestion` |
| Recurring | `list_recurring`, `update_recurring`, `add_recurring_payment`, `edit_recurring_payment`, `delete_recurring_payment` |
| Account | `whoami`, `get_profile`, `update_profile`, `change_password`, `delete_account` |

Destructive tools are marked as such for Claude, and `delete_all_transactions` and `delete_account` also require an exact confirmation text.

`src/shared` holds copies of the app's calculation helpers so totals here match the app. Copy them again when the app changes them.
