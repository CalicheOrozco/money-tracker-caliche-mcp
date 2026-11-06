import { z } from 'zod'
import { AppError, appClient } from './appApi.js'
import { replaceAppSession } from './oauth.js'
import { CURRENCIES, EXPENSE, INCOME, RANGES, TONES } from './shared/constants.js'
import { daysAgo, parseDay, startOfToday, toISODate } from './shared/dates.js'
import { matchesPatterns, merchantKey, patternMatch, resolveMerchant } from './shared/merchants.js'
import { monthlyCashflow } from './shared/metrics.js'
import { currentMonthKey, expensesOf, inMonth, incomeOf, monthLabel, shiftMonth } from './shared/periods.js'
import { daysUntil, monthlyAmount, recurringState } from './shared/recurring.js'
import { normalizeTag, parseTags } from './shared/tags.js'
import { accountBalance, creditCardEstimate, fromApiTransfer, isCreditAccount, transferSuggestions } from './shared/transfers.js'

const CATEGORIES = [...INCOME, ...EXPENSE].map(([name]) => name)
const round = n => Math.round(n * 100) / 100

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
const month = z.string().regex(/^\d{4}-\d{2}$/, 'Use the format YYYY-MM')
const category = z.enum(CATEGORIES)
const rangeKey = z.enum(Object.keys(RANGES))
const money = z.number().positive()
// Ids go into API paths, so only real ids are accepted.
const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Use an id returned by a list tool')
const manualKey = z.string().regex(/^manual:[a-f0-9]{24}$/i, 'Use a key starting with manual: from list_recurring')

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
const DESTROY = { readOnlyHint: false, destructiveHint: true, openWorldHint: false }

// Same shape the app uses internally, so the copied helpers work unchanged.
function toTx (t) {
  return {
    id: t._id,
    name: t.name,
    desc: t.description || '',
    amount: parseFloat(String(t.price).replace(/[,\s+]/g, '')) || 0,
    date: String(t.datetime).slice(0, 10),
    category: t.category || 'Other',
    card: t.card || '',
    icon: t.icon || '',
    tags: Array.isArray(t.tags) ? t.tags : [],
    merchant: t.merchant || ''
  }
}

const present = (t, merchant) => ({
  id: t.id,
  date: t.date,
  name: t.name,
  description: t.desc || undefined,
  amount: t.amount,
  type: t.amount >= 0 ? 'income' : 'expense',
  category: t.category,
  card: t.card || undefined,
  tags: t.tags.length ? t.tags : undefined,
  merchant: merchant ? merchant.name : undefined
})

const priceOf = amount => (amount < 0 ? '-' : '+') + Math.abs(amount).toFixed(2)

function toApi (t) {
  return {
    name: t.name,
    price: priceOf(t.amount),
    datetime: t.date,
    description: t.desc || '',
    category: t.category || 'Other',
    card: t.card || '',
    icon: t.icon || '',
    tags: t.tags || [],
    merchant: t.merchant || ''
  }
}

function inPeriod ({ range, start_date: start, end_date: end }) {
  if (start || end) {
    return t => (!start || t.date >= start) && (!end || t.date <= end) && daysAgo(t.date) >= 0
  }
  const days = RANGES[range || '1M']
  return t => daysAgo(t.date) >= 0 && daysAgo(t.date) < days
}

function groupTotals (list, keyOf) {
  const totals = {}
  for (const t of list) {
    const key = keyOf(t)
    if (key) totals[key] = (totals[key] || 0) - t.amount
  }
  return Object.entries(totals).sort((a, b) => b[1] - a[1])
}

function ok (data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

function fail (error) {
  return { isError: true, content: [{ type: 'text', text: error.message || String(error) }] }
}

export function registerTools (server, auth) {
  const api = appClient(auth)
  const id = api.userId

  // With dates, the app filters on its side, so only that period is downloaded.
  const transactions = async ({ start, end } = {}) => {
    const period = start || end ? `?startDate=${start || '1900-01-01'}&endDate=${end || '2999-12-31'}` : ''
    return (await api.call(`/transactions/${id}${period}`)).map(toTx).sort((a, b) => b.date.localeCompare(a.date))
  }
  const monthStart = key => `${key}-01`
  const monthEnd = key => {
    const [year, m] = key.split('-').map(Number)
    return `${key}-${String(new Date(year, m, 0).getDate()).padStart(2, '0')}`
  }
  const cards = () => api.call(`/cards/${id}`)
  const list = name => api.call(`/me/${name}`)
  const create = (name, body) => api.call(`/me/${name}`, { method: 'POST', body })
  const update = (name, itemId, body) => api.call(`/me/${name}/${encodeURIComponent(itemId)}`, { method: 'PATCH', body })
  const remove = (name, itemId) => api.call(`/me/${name}/${encodeURIComponent(itemId)}`, { method: 'DELETE' })

  // Mirrors the app: a missing category comes from a matching rule, then the merchant's default.
  async function fillCategory (record) {
    if (record.category) return record
    const [rules, merchants] = await Promise.all([list('rules'), list('merchants')])
    const text = `${record.name} ${record.desc || ''}`.toLowerCase()
    const rule = rules.find(r => r.match && text.includes(r.match))
    const merchant = patternMatch(merchants, text)
    const tags = [...(record.tags || [])]
    if (rule?.tag && !tags.includes(rule.tag)) tags.push(rule.tag)
    return { ...record, tags, category: rule?.category || merchant?.category || 'Other' }
  }

  // Matches an existing card ignoring case, so "nu" uses the card "Nu" instead of making a new one.
  async function resolveCard (name) {
    if (!name || name === 'none') return { card: '', icon: '' }
    const existing = (await cards()).find(c => c.name.toLowerCase() === name.trim().toLowerCase())
    return existing ? { card: existing.name, icon: existing.icon || '' } : { card: name.trim(), icon: '' }
  }

  function tool (name, config, handler) {
    server.registerTool(name, config, async args => {
      try {
        return ok(await handler(args || {}))
      } catch (error) {
        // Expected problems (bad input, the app saying no) are plain errors and only go
        // back to Claude. Anything else, like a database or code error, is also logged,
        // without the arguments, which can hold personal data.
        const expected = error instanceof AppError || error.constructor === Error
        if (!expected) console.error(`Tool ${name} failed:`, error)
        return fail(error)
      }
    })
  }

  // ---------- Transactions ----------

  tool('list_transactions', {
    title: 'List transactions',
    description: 'Search the user\'s transactions, newest first. Amounts are signed: negative for expenses, positive for income. Combine filters freely.',
    inputSchema: {
      start_date: date.optional().describe('First day to include, YYYY-MM-DD'),
      end_date: date.optional().describe('Last day to include, YYYY-MM-DD'),
      type: z.enum(['income', 'expense']).optional(),
      category: z.string().optional(),
      card: z.string().optional().describe('Card name, or "none" for cash'),
      search: z.string().optional().describe('Text found in the name, description, category or tags'),
      tag: z.string().optional(),
      min_amount: z.number().nonnegative().optional().describe('Minimum absolute amount'),
      max_amount: z.number().nonnegative().optional().describe('Maximum absolute amount'),
      limit: z.number().int().min(1).max(1000).optional().describe('Default 100'),
      offset: z.number().int().min(0).optional()
    },
    annotations: READ
  }, async a => {
    const [all, merchants] = await Promise.all([transactions({ start: a.start_date, end: a.end_date }), list('merchants')])
    const query = a.search?.toLowerCase()
    const tag = a.tag && normalizeTag(a.tag)
    const filtered = all.filter(t =>
      (!a.start_date || t.date >= a.start_date) &&
      (!a.end_date || t.date <= a.end_date) &&
      (!a.type || (a.type === 'income' ? t.amount > 0 : t.amount < 0)) &&
      (!a.category || t.category.toLowerCase() === a.category.toLowerCase()) &&
      (!a.card || (a.card === 'none' ? !t.card : t.card.toLowerCase() === a.card.toLowerCase())) &&
      (!tag || t.tags.includes(tag)) &&
      (a.min_amount === undefined || Math.abs(t.amount) >= a.min_amount) &&
      (a.max_amount === undefined || Math.abs(t.amount) <= a.max_amount) &&
      (!query || `${t.name} ${t.desc} ${t.category} ${t.tags.map(x => '#' + x).join(' ')}`.toLowerCase().includes(query))
    )
    const offset = a.offset || 0
    const page = filtered.slice(offset, offset + (a.limit || 100))
    return {
      total_matching: filtered.length,
      returned: page.length,
      offset,
      transactions: page.map(t => present(t, resolveMerchant(merchants, t)))
    }
  })

  tool('create_transaction', {
    title: 'Add transaction',
    description: 'Record an expense or income. For money moved between the user\'s own accounts use create_transfer instead. If no category is given, the user\'s rules and merchants pick one, like in the app.',
    inputSchema: {
      name: z.string().min(1),
      amount: money.describe('Positive number; the type decides the sign'),
      type: z.enum(['expense', 'income']),
      date: date.optional().describe('Defaults to today'),
      category: category.optional(),
      description: z.string().optional(),
      card: z.string().optional().describe('Card name; leave empty for cash'),
      tags: z.array(z.string()).optional(),
      merchant_id: z.union([objectId, z.literal('none')]).optional().describe('Assign a merchant by id, or "none"')
    },
    annotations: WRITE
  }, async a => {
    const record = await fillCategory({
      name: a.name.trim(),
      desc: a.description || '',
      amount: a.type === 'income' ? a.amount : -a.amount,
      date: a.date || toISODate(new Date()),
      category: a.category,
      ...(await resolveCard(a.card)),
      tags: parseTags((a.tags || []).join(',')),
      merchant: a.merchant_id || ''
    })
    const saved = await api.call(`/transaction/${id}`, { method: 'POST', body: toApi(record) })
    return { created: present(toTx(saved)) }
  })

  tool('update_transaction', {
    title: 'Edit transaction',
    description: 'Change any field of an existing transaction. Only the fields you pass are changed.',
    inputSchema: {
      id: objectId,
      name: z.string().min(1).optional(),
      amount: money.optional(),
      type: z.enum(['expense', 'income']).optional(),
      date: date.optional(),
      category: category.optional(),
      description: z.string().optional(),
      card: z.string().optional().describe('Card name, or "" for cash'),
      tags: z.array(z.string()).optional().describe('Replaces all tags'),
      merchant_id: z.union([objectId, z.literal('none'), z.literal('')]).optional().describe('Merchant id, "none", or "" for automatic')
    },
    annotations: WRITE
  }, async a => {
    const current = toTx(await api.call(`/transaction/item/${encodeURIComponent(a.id)}`))
    if (!current) throw new Error('Transaction not found.')
    const type = a.type || (current.amount >= 0 ? 'income' : 'expense')
    const amount = a.amount ?? Math.abs(current.amount)
    const resolved = a.card === undefined ? { card: current.card, icon: current.icon } : await resolveCard(a.card)
    const card = resolved.card
    const next = {
      ...current,
      name: a.name ?? current.name,
      desc: a.description ?? current.desc,
      amount: type === 'income' ? amount : -amount,
      date: a.date ?? current.date,
      category: a.category ?? current.category,
      card,
      icon: card === current.card ? current.icon : resolved.icon,
      tags: a.tags ? parseTags(a.tags.join(',')) : current.tags,
      merchant: a.merchant_id ?? current.merchant
    }
    const saved = await api.call(`/transaction/update/${a.id}`, { method: 'PUT', body: toApi(next) })
    return { updated: present(toTx(saved)) }
  })

  tool('delete_transaction', {
    title: 'Delete transaction',
    description: 'Permanently delete one transaction by id.',
    inputSchema: { id: objectId },
    annotations: DESTROY
  }, async a => {
    const deleted = await api.call(`/transaction/delete/${a.id}`, { method: 'DELETE' })
    return { deleted: present(toTx(deleted)) }
  })

  tool('delete_all_transactions', {
    title: 'Delete all transactions',
    description: 'Permanently delete every transaction and transfer in the account. Only when the user explicitly asks. Needs the user\'s password, which you must ask the user to type; never reuse or guess one.',
    inputSchema: { password: z.string().min(1).describe('The user\'s Money Tracker password, typed by the user for this action') },
    annotations: DESTROY
  }, async a => api.call('/profile/transactions', { method: 'DELETE', body: { password: a.password } }))

  tool('list_categories', {
    title: 'List categories',
    description: 'Every category the app offers, split into income and expense, with how many transactions use each and their total. Categories are fixed in the app; these are the only valid values.',
    annotations: READ
  }, async () => {
    const usage = {}
    for (const t of await transactions()) {
      usage[t.category] ||= { transactions: 0, total: 0 }
      usage[t.category].transactions++
      usage[t.category].total = round(usage[t.category].total + Math.abs(t.amount))
    }
    const describe = ([name]) => ({ name, ...(usage[name] || { transactions: 0, total: 0 }) })
    const known = new Set(CATEGORIES)
    return {
      income: INCOME.map(describe),
      expense: EXPENSE.map(describe),
      // Older transactions can carry names the app no longer offers.
      other_in_use: Object.keys(usage).filter(name => !known.has(name)).map(name => ({ name, ...usage[name] }))
    }
  })

  tool('list_tags', {
    title: 'List tags',
    description: 'Every tag used on transactions, with how many transactions and how much was spent.',
    annotations: READ
  }, async () => {
    const tags = {}
    for (const t of await transactions()) {
      for (const tag of t.tags) {
        tags[tag] ||= { tag, transactions: 0, spent: 0 }
        tags[tag].transactions++
        if (t.amount < 0) tags[tag].spent = round(tags[tag].spent - t.amount)
      }
    }
    return Object.values(tags).sort((a, b) => b.spent - a.spent)
  })

  // ---------- Reports ----------

  tool('get_summary', {
    title: 'Spending summary',
    description: 'Income, expenses, net, savings rate, spending by category and card, and top payees for a period. Use range for presets or start_date/end_date for exact days. Also returns the all-time balance.',
    inputSchema: {
      range: rangeKey.optional().describe('7D, 15D, 1M (default), 6M, 1Y or All'),
      start_date: date.optional(),
      end_date: date.optional()
    },
    annotations: READ
  }, async a => {
    // The all-time balance needs every transaction, not just the period.
    const all = await transactions()
    const period = all.filter(inPeriod(a))
    const income = incomeOf(period)
    const expenses = expensesOf(period)
    const expenseList = period.filter(t => t.amount < 0)
    return {
      period: a.start_date || a.end_date ? { start: a.start_date, end: a.end_date } : a.range || '1M',
      transactions: period.length,
      income: round(income),
      expenses: round(expenses),
      net: round(income - expenses),
      savings_rate_percent: income ? Math.round(((income - expenses) / income) * 100) : null,
      balance_all_time: round(all.filter(t => daysAgo(t.date) >= 0).reduce((s, t) => s + t.amount, 0)),
      by_category: groupTotals(expenseList, t => t.category).map(([name, amount]) => ({
        category: name, amount: round(amount), share_percent: expenses ? Math.round((amount / expenses) * 100) : 0
      })),
      by_card: groupTotals(expenseList, t => t.card || 'Cash / no card').map(([name, amount]) => ({ card: name, amount: round(amount) })),
      top_payees: groupTotals(expenseList, t => t.name).slice(0, 10).map(([name, amount]) => ({ name, amount: round(amount) }))
    }
  })

  tool('get_monthly_report', {
    title: 'Monthly report',
    description: 'Report for one month compared with the month before: totals, daily spending, biggest expenses and categories.',
    inputSchema: { month: month.optional().describe('YYYY-MM, defaults to the current month') },
    annotations: READ
  }, async a => {
    const key = a.month || currentMonthKey()
    const previous = shiftMonth(key, -1)
    const all = await transactions({ start: monthStart(previous), end: monthEnd(key) })
    const now = inMonth(all, key)
    const before = inMonth(all, previous)
    const [year, m] = key.split('-').map(Number)
    const days = new Date(year, m, 0).getDate()
    const change = (x, y) => (y ? Math.round(((x - y) / y) * 100) : null)
    return {
      month: `${monthLabel(key)} ${year}`,
      in_progress: key === currentMonthKey(),
      income: round(incomeOf(now)),
      expenses: round(expensesOf(now)),
      net: round(incomeOf(now) - expensesOf(now)),
      vs_previous_month: {
        month: monthLabel(previous),
        income_change_percent: change(incomeOf(now), incomeOf(before)),
        expenses_change_percent: change(expensesOf(now), expensesOf(before)),
        previous_net: round(incomeOf(before) - expensesOf(before))
      },
      daily_spending: Array.from({ length: days }, (_, i) => ({
        day: i + 1, spent: round(expensesOf(now.filter(t => Number(t.date.slice(8)) === i + 1)))
      })).filter(d => d.spent > 0),
      biggest_expenses: now.filter(t => t.amount < 0).sort((x, y) => x.amount - y.amount).slice(0, 5).map(t => present(t)),
      by_category: [...new Set(now.filter(t => t.amount < 0).map(t => t.category))]
        .map(c => ({ category: c, amount: round(expensesOf(now, c)), previous: round(expensesOf(before, c)) }))
        .sort((x, y) => y.amount - x.amount)
    }
  })

  tool('get_cashflow', {
    title: 'Monthly cashflow',
    description: 'Income, expenses and net for each of the last N months.',
    inputSchema: { months: z.number().int().min(1).max(24).optional().describe('Default 6') },
    annotations: READ
  }, async a => monthlyCashflow(await transactions(), a.months || 6).map(m => ({
    month: m.label, income: round(m.income), expenses: round(m.expense), net: round(m.income - m.expense)
  })))

  // ---------- Cards ----------

  tool('list_cards', {
    title: 'List cards',
    description: 'The user\'s cards and accounts with type, last digits, credit limit, what was spent this month, and the current balance when tracked (balance, or amount_owed on credit cards).',
    annotations: READ
  }, async () => {
    const [cardList, all, moved] = await Promise.all([cards(), transactions(), transferList()])
    const month = inMonth(all, currentMonthKey())
    const shownBalance = c => {
      const value = accountBalance(c, all, moved)
      if (value === null) return { balance_tracked: false }
      const available = isCreditAccount(c) && c.limit ? { credit_available: round(Math.max(0, c.limit - Math.max(0, value))) } : {}
      return { [isCreditAccount(c) ? 'amount_owed' : 'balance']: round(value), ...available, balance_set_on: c.balanceDate }
    }
    return cardList.map(c => ({
      name: c.name,
      ...shownBalance(c),
      type: c.type,
      last4: c.last4 || undefined,
      credit_limit: c.limit || undefined,
      logo: c.icon || undefined,
      color: c.tone || undefined,
      spent_this_month: round(expensesOf(month.filter(t => t.card === c.name)))
    }))
  })

  tool('save_card', {
    title: 'Add or edit card',
    description: 'Create a card, or update one with the same name. Logo is a bundled key (VisaIcon, MastercardIcon, AmericaExpressIcon, BBVAIcon, HSBCIcon, BANAMEXIcon, BanorteIcon, SantanderIcon, ScotiabankIcon, BanCoppelIcon, BancoAztecaIcon) or the bank\'s website, like nu.com.mx. Color is a preset or a #rrggbb hex.',
    inputSchema: {
      name: z.string().min(1),
      logo: z.string().optional(),
      type: z.enum(['credit', 'debit', 'savings', 'investment']).optional(),
      last4: z.string().regex(/^\d{4}$/).optional(),
      credit_limit: z.number().nonnegative().optional(),
      balance: z.number().optional().describe('What the bank shows, or the amount owed on a credit card. Later movements update it'),
      balance_date: date.optional().describe('Date of that balance. Defaults to today'),
      color: z.union([z.enum(Object.keys(TONES)), z.string().regex(/^#[0-9a-fA-F]{6}$/)]).optional()
    },
    annotations: WRITE
  }, async a => api.call(`/cards/${id}`, {
    method: 'POST',
    body: {
      name: a.name, icon: a.logo, type: a.type, last4: a.last4, limit: a.credit_limit, tone: a.color?.toLowerCase(),
      balance: a.balance, balanceDate: a.balance === undefined ? undefined : a.balance_date || toISODate(new Date())
    }
  }))

  tool('rename_card', {
    title: 'Rename card',
    description: 'Rename a card or account. Its transactions, transfers and recurring payments move to the new name.',
    inputSchema: { name: z.string().min(1).describe('Current name'), new_name: z.string().min(1).max(60) },
    annotations: WRITE
  }, async a => {
    const current = (await cards()).find(c => c.name.toLowerCase() === a.name.trim().toLowerCase())
    if (!current) throw new Error(`Unknown card: ${a.name}.`)
    return api.call(`/cards/${id}/rename`, { method: 'POST', body: { from: current.name, to: a.new_name.trim() } })
  })

  tool('remove_card', {
    title: 'Remove card',
    description: 'Hide a card from the wallet. Its transactions keep the card name.',
    inputSchema: { name: z.string() },
    annotations: DESTROY
  }, async a => api.call(`/cards/${id}/${encodeURIComponent(a.name)}`, { method: 'DELETE' }))

  // ---------- Budgets ----------

  tool('list_budgets', {
    title: 'List budgets',
    description: 'Monthly budgets per category with this month\'s spending, the projection to month end and last month.',
    annotations: READ
  }, async () => {
    const [budgets, all] = await Promise.all([
      list('budgets'),
      transactions({ start: monthStart(shiftMonth(currentMonthKey(), -1)), end: monthEnd(currentMonthKey()) })
    ])
    const now = new Date()
    const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
    const thisMonth = inMonth(all, currentMonthKey())
    const lastMonth = inMonth(all, shiftMonth(currentMonthKey(), -1))
    return budgets.map(b => {
      const spent = expensesOf(thisMonth, b.category)
      const projection = (spent / now.getDate()) * days
      return {
        category: b.category,
        monthly_limit: b.limit,
        spent_this_month: round(spent),
        left: round(b.limit - spent),
        projected_month_end: round(projection),
        on_pace_to_go_over: projection > b.limit,
        last_month: round(expensesOf(lastMonth, b.category))
      }
    })
  })

  tool('set_budget', {
    title: 'Set budget',
    description: 'Create or change the monthly budget for an expense category.',
    inputSchema: { category: z.enum(EXPENSE.map(([c]) => c)), monthly_limit: money },
    annotations: WRITE
  }, async a => create('budgets', { category: a.category, limit: a.monthly_limit }))

  tool('delete_budget', {
    title: 'Delete budget',
    description: 'Remove the budget for a category.',
    inputSchema: { category: z.string() },
    annotations: DESTROY
  }, async a => {
    const budget = (await list('budgets')).find(b => b.category === a.category)
    if (!budget) throw new Error(`There is no budget for ${a.category}.`)
    return remove('budgets', budget._id)
  })

  // ---------- Goals ----------

  const monthsUntil = due => {
    if (!due) return 12
    const d = parseDay(due)
    const n = new Date()
    return Math.max(1, (d.getFullYear() - n.getFullYear()) * 12 + d.getMonth() - n.getMonth())
  }

  tool('list_goals', {
    title: 'List savings goals',
    description: 'Savings goals with progress and how much to save per month to reach each on time.',
    annotations: READ
  }, async () => (await list('goals')).map(g => {
    const left = Math.max(0, g.target - g.saved)
    return {
      id: g._id, name: g.name, target: g.target, saved: g.saved, due_date: g.due || undefined, icon: g.icon,
      progress_percent: Math.min(100, Math.round((g.saved / g.target) * 100)),
      remaining: round(left),
      save_per_month: round(left / monthsUntil(g.due)),
      reached: left <= 0
    }
  }))

  tool('create_goal', {
    title: 'Create goal',
    description: 'Create a savings goal.',
    inputSchema: {
      name: z.string().min(1),
      target: money,
      due_date: date.optional(),
      saved: z.number().nonnegative().optional(),
      icon: z.enum(['flight', 'shield', 'laptop_mac', 'home', 'directions_car', 'school', 'celebration', 'savings']).optional()
    },
    annotations: WRITE
  }, async a => create('goals', { name: a.name, target: a.target, due: a.due_date, saved: a.saved ?? 0, icon: a.icon ?? 'savings' }))

  tool('update_goal', {
    title: 'Edit goal',
    description: 'Change a goal\'s name, target, due date, saved amount or icon.',
    inputSchema: {
      id: objectId,
      name: z.string().min(1).optional(),
      target: money.optional(),
      due_date: date.optional(),
      saved: z.number().nonnegative().optional(),
      icon: z.string().optional()
    },
    annotations: WRITE
  }, async a => update('goals', a.id, { name: a.name, target: a.target, due: a.due_date, saved: a.saved, icon: a.icon }))

  tool('add_to_goal', {
    title: 'Add money to goal',
    description: 'Add to (or with a negative amount, take from) what is saved toward a goal.',
    inputSchema: { id: objectId, amount: z.number().refine(n => n !== 0) },
    annotations: WRITE
  }, async a => {
    const goal = (await list('goals')).find(g => g._id === a.id)
    if (!goal) throw new Error('Goal not found.')
    return update('goals', a.id, { saved: Math.max(0, round(goal.saved + a.amount)) })
  })

  tool('delete_goal', {
    title: 'Delete goal',
    description: 'Delete a savings goal.',
    inputSchema: { id: objectId },
    annotations: DESTROY
  }, async a => remove('goals', a.id))

  // ---------- Debts ----------

  const direction = z.enum(['they_owe_me', 'i_owe_them'])
  const toDir = d => (d === 'they_owe_me' ? 'owed' : 'owe')
  const showDebt = d => ({
    id: d._id, person: d.person, direction: d.dir === 'owed' ? 'they_owe_me' : 'i_owe_them',
    amount: d.amount, note: d.note || undefined, date: d.date || undefined, settled: d.settled
  })

  tool('list_debts', {
    title: 'List debts',
    description: 'Money friends owe the user and money the user owes, with totals.',
    annotations: READ
  }, async () => {
    const debts = await list('debts')
    const open = debts.filter(d => !d.settled)
    const owed = open.filter(d => d.dir === 'owed').reduce((s, d) => s + d.amount, 0)
    const owe = open.filter(d => d.dir === 'owe').reduce((s, d) => s + d.amount, 0)
    return {
      owed_to_me: round(owed), i_owe: round(owe), balance: round(owed - owe),
      open: open.map(showDebt), settled: debts.filter(d => d.settled).map(showDebt)
    }
  })

  tool('create_debt', {
    title: 'Record debt',
    description: 'Record money someone owes the user, or that the user owes someone.',
    inputSchema: { person: z.string().min(1), direction, amount: money, note: z.string().optional(), date: date.optional() },
    annotations: WRITE
  }, async a => showDebt(await create('debts', {
    person: a.person, dir: toDir(a.direction), amount: a.amount, note: a.note || '', date: a.date || toISODate(new Date())
  })))

  tool('update_debt', {
    title: 'Edit debt',
    description: 'Change a debt\'s person, direction, amount or note.',
    inputSchema: { id: objectId, person: z.string().min(1).optional(), direction: direction.optional(), amount: money.optional(), note: z.string().optional() },
    annotations: WRITE
  }, async a => showDebt(await update('debts', a.id, {
    person: a.person, dir: a.direction && toDir(a.direction), amount: a.amount, note: a.note
  })))

  tool('settle_debt', {
    title: 'Settle debt',
    description: 'Mark a debt as paid. By default also records the payment as a transaction, like the app does.',
    inputSchema: { id: objectId, record_transaction: z.boolean().optional().describe('Default true') },
    annotations: WRITE
  }, async a => {
    const debt = (await list('debts')).find(d => d._id === a.id)
    if (!debt) throw new Error('Debt not found.')
    if (debt.settled) throw new Error('That debt is already settled.')
    if (a.record_transaction !== false) {
      const owed = debt.dir === 'owed'
      await api.call(`/transaction/${id}`, {
        method: 'POST',
        body: toApi({
          name: debt.person, desc: debt.note, amount: owed ? debt.amount : -debt.amount, date: toISODate(new Date()),
          category: owed ? 'Loaned Money Received' : 'Debts to Friends', card: '', icon: '', tags: [], merchant: ''
        })
      })
    }
    return showDebt(await update('debts', a.id, { settled: true }))
  })

  tool('delete_debt', {
    title: 'Delete debt',
    description: 'Delete a debt record.',
    inputSchema: { id: objectId },
    annotations: DESTROY
  }, async a => remove('debts', a.id))

  // ---------- Net worth ----------

  tool('get_net_worth', {
    title: 'Net worth',
    description: 'Assets, debts, an estimate of credit card balances from the last 30 days (charges minus payments), and the saved history.',
    annotations: READ
  }, async () => {
    const [holdings, history, cardList, all, moved] = await Promise.all([
      list('holdings'), list('networth-snapshots'), cards(), transactions(), transferList()
    ])
    const cardDebt = creditCardEstimate(all, moved, cardList)
    const show = h => ({ id: h._id, name: h.name, kind: h.kind || undefined, value: h.value })
    const assets = holdings.filter(h => h.side === 'asset')
    const debts = holdings.filter(h => h.side === 'liab')
    const totalAssets = assets.reduce((s, h) => s + h.value, 0)
    const totalDebts = debts.reduce((s, h) => s + h.value, 0) + cardDebt
    return {
      net_worth: round(totalAssets - totalDebts),
      total_assets: round(totalAssets),
      total_debts: round(totalDebts),
      credit_card_estimate: round(cardDebt),
      assets: assets.map(show),
      debts: debts.map(show),
      history: history.sort((x, y) => x.date.localeCompare(y.date)).map(s => ({ date: s.date, value: s.value }))
    }
  })

  tool('add_holding', {
    title: 'Add asset or debt',
    description: 'Add something the user owns (asset) or owes (debt) to their net worth.',
    inputSchema: { type: z.enum(['asset', 'debt']), name: z.string().min(1), value: money, kind: z.string().optional().describe('e.g. Cash, Investment, Loan') },
    annotations: WRITE
  }, async a => create('holdings', { side: a.type === 'asset' ? 'asset' : 'liab', name: a.name, value: a.value, kind: a.kind || (a.type === 'asset' ? 'Other' : 'Debt') }))

  tool('update_holding', {
    title: 'Edit asset or debt',
    description: 'Change the name, kind or current value of an asset or debt.',
    inputSchema: { id: objectId, name: z.string().min(1).optional(), kind: z.string().optional(), value: z.number().nonnegative().optional() },
    annotations: WRITE
  }, async a => update('holdings', a.id, { name: a.name, kind: a.kind, value: a.value }))

  tool('delete_holding', {
    title: 'Delete asset or debt',
    description: 'Remove an asset or debt from net worth.',
    inputSchema: { id: objectId },
    annotations: DESTROY
  }, async a => remove('holdings', a.id))

  // ---------- Rules ----------

  tool('list_rules', {
    title: 'List rules',
    description: 'Rules that set a category (and optional tag) when a transaction name contains some text, with how many transactions match.',
    annotations: READ
  }, async () => {
    const [rules, all] = await Promise.all([list('rules'), transactions()])
    return rules.map(r => {
      const matches = all.filter(t => `${t.name} ${t.desc}`.toLowerCase().includes(r.match))
      return {
        id: r._id, contains: r.match, category: r.category, tag: r.tag || undefined,
        matches: matches.length,
        not_yet_applied: matches.filter(t => t.category !== r.category || (r.tag && !t.tags.includes(r.tag))).length
      }
    })
  })

  tool('create_rule', {
    title: 'Create rule',
    description: 'When a transaction name contains this text, set this category (and tag). Applies to new and imported transactions; use apply_rules for existing ones.',
    inputSchema: { contains: z.string().min(1), category, tag: z.string().optional() },
    annotations: WRITE
  }, async a => create('rules', { match: a.contains, category: a.category, tag: a.tag || '' }))

  tool('delete_rule', {
    title: 'Delete rule',
    description: 'Delete a rule. Transactions it already changed stay as they are.',
    inputSchema: { id: objectId },
    annotations: DESTROY
  }, async a => remove('rules', a.id))

  tool('apply_rules', {
    title: 'Apply rules to past transactions',
    description: 'Apply one rule, or all rules when no id is given, to existing transactions.',
    inputSchema: { rule_id: objectId.optional() },
    annotations: WRITE
  }, async a => {
    const ids = a.rule_id ? [a.rule_id] : (await list('rules')).map(r => r._id)
    let changed = 0
    for (const ruleId of ids) changed += (await api.call(`/me/rules/${ruleId}/apply`, { method: 'POST' })).modifiedCount
    return { transactions_updated: changed }
  })

  // ---------- Merchants ----------

  const showMerchant = (m, stats) => ({
    id: m._id, name: m.name, website: m.domain || undefined, patterns: m.patterns,
    default_category: m.category || undefined, ...stats
  })

  tool('list_merchants', {
    title: 'List merchants',
    description: 'Merchants the app recognizes (they give transactions a logo and optional default category), with how many transactions and how much was spent at each.',
    annotations: READ
  }, async () => {
    const [merchants, all] = await Promise.all([list('merchants'), transactions()])
    const stats = {}
    for (const t of all) {
      const m = resolveMerchant(merchants, t)
      if (!m) continue
      stats[m._id] ||= { transactions: 0, spent: 0 }
      stats[m._id].transactions++
      if (t.amount < 0) stats[m._id].spent = round(stats[m._id].spent - t.amount)
    }
    return merchants.map(m => showMerchant(m, stats[m._id] || { transactions: 0, spent: 0 }))
  })

  tool('list_unmatched_merchants', {
    title: 'Names without a merchant',
    description: 'Transaction names no merchant recognizes yet, grouped and sorted by how often they appear. Useful before creating merchants.',
    inputSchema: { limit: z.number().int().min(1).max(200).optional() },
    annotations: READ
  }, async a => {
    const [merchants, all] = await Promise.all([list('merchants'), transactions()])
    const groups = {}
    for (const t of all) {
      if (t.merchant === 'none' || resolveMerchant(merchants, t)) continue
      const key = merchantKey(t.name)
      if (!key) continue
      groups[key] ||= { suggested_pattern: key, example: t.name, transactions: 0, spent: 0 }
      groups[key].transactions++
      if (t.amount < 0) groups[key].spent = round(groups[key].spent - t.amount)
    }
    return Object.values(groups).sort((x, y) => y.transactions - x.transactions).slice(0, a.limit || 30)
  })

  const merchantFields = {
    name: z.string().min(1),
    website: z.string().optional().describe('Domain for the logo, e.g. walmart.com.mx; "" for no logo'),
    patterns: z.array(z.string().min(1)).optional().describe('Text that identifies the merchant in transaction names'),
    default_category: category.or(z.literal('')).optional()
  }

  tool('create_merchant', {
    title: 'Create merchant',
    description: 'Teach the app to recognize a merchant by text patterns in transaction names.',
    inputSchema: merchantFields,
    annotations: WRITE
  }, async a => {
    const merchant = await create('merchants', { name: a.name, domain: a.website || '', patterns: a.patterns || [], category: a.default_category || '' })
    const matches = (await transactions()).filter(t => matchesPatterns(merchant.patterns, t)).length
    return { ...showMerchant(merchant), matching_transactions: matches }
  })

  tool('update_merchant', {
    title: 'Edit merchant',
    description: 'Change a merchant. Passing patterns replaces the whole list.',
    inputSchema: { id: objectId, ...merchantFields, name: z.string().min(1).optional() },
    annotations: WRITE
  }, async a => showMerchant(await update('merchants', a.id, {
    name: a.name, domain: a.website, patterns: a.patterns, category: a.default_category
  })))

  tool('delete_merchant', {
    title: 'Delete merchant',
    description: 'Delete a merchant. Its transactions go back to showing the category icon.',
    inputSchema: { id: objectId },
    annotations: DESTROY
  }, async a => remove('merchants', a.id))

  // ---------- Recurring ----------

  const showRecurring = r => ({
    key: r.key,
    added_manually: r.manual || undefined,
    frequency: r.manual ? r.frequency : 'monthly (detected)',
    name: r.name,
    category: r.category,
    card: r.card || undefined,
    type: r.type === 'sub' ? 'subscription' : r.type === 'income' ? 'income' : 'bill',
    average_amount: round(r.avg),
    amount_range: r.max - r.min > r.avg * 0.04 ? [round(r.min), round(r.max)] : undefined,
    monthly_cost: round(monthlyAmount(r)),
    yearly_cost: round(monthlyAmount(r) * 12),
    last_charged: r.last?.date,
    next_expected: toISODate(r.next),
    days_until_next: daysUntil(r.next),
    charges_found: r.list.length,
    status: r.cancelled ? 'cancelled' : r.inactive ? 'inactive' : r.review ? 'needs_review' : 'active'
  })

  tool('list_recurring', {
    title: 'Recurring payments',
    description: 'Subscriptions, bills and recurring income, detected from repeating monthly transactions or added by hand, ones that need review, inactive ones, and what is due in the next 30 days.',
    annotations: READ
  }, async () => {
    const [all, overrides, manual] = await Promise.all([transactions(), list('recurring-overrides'), list('recurring')])
    const state = recurringState(all, overrides, manual)
    const total = l => round(l.reduce((s, r) => s + monthlyAmount(r), 0))
    return {
      fixed_per_month: round(total(state.lists.subs) + total(state.lists.bills)),
      subscriptions_per_month: total(state.lists.subs),
      bills_per_month: total(state.lists.bills),
      recurring_income_per_month: round(state.income),
      income: state.lists.income.map(showRecurring),
      subscriptions: state.lists.subs.map(showRecurring),
      bills: state.lists.bills.map(showRecurring),
      needs_review: state.review.map(showRecurring),
      inactive: state.lists.inactive.map(showRecurring),
      due_next_30_days: state.upcoming.map(r => ({ name: r.name, date: toISODate(r.next), amount: round(r.avg) }))
    }
  })

  tool('update_recurring', {
    title: 'Update recurring payment',
    description: 'Confirm a payment as recurring, mark it as not recurring, cancelled or active again, or move it between subscriptions and bills. Use the key from list_recurring.',
    inputSchema: {
      key: z.string(),
      action: z.enum(['confirm', 'not_recurring', 'cancel', 'reactivate', 'mark_subscription', 'mark_bill'])
    },
    annotations: WRITE
  }, async a => {
    // Payments added by hand are changed directly instead of through overrides.
    if (a.key.startsWith('manual:')) {
      const manualId = a.key.slice(7)
      const change = {
        cancel: { active: false },
        reactivate: { active: true },
        confirm: { active: true },
        mark_subscription: { type: 'sub' },
        mark_bill: { type: 'bill' }
      }[a.action]
      if (!change) throw new Error('Use delete_recurring_payment to remove a payment you added.')
      await update('recurring', manualId, change)
      return { key: a.key, done: a.action }
    }
    const body = {
      confirm: { status: 'confirmed' },
      not_recurring: { status: 'dismissed' },
      cancel: { status: 'cancelled' },
      reactivate: { status: 'confirmed' },
      mark_subscription: { type: 'sub' },
      mark_bill: { type: 'bill' }
    }[a.action]
    await create('recurring-overrides', { key: a.key, ...body })
    return { key: a.key, done: a.action }
  })

  const paymentFields = {
    name: z.string().min(1),
    amount: money.describe('Amount of each charge, or of each payment for income'),
    type: z.enum(['subscription', 'bill', 'income']).optional().describe('Default subscription. income is money received regularly, like a salary'),
    frequency: z.enum(['weekly', 'biweekly', 'monthly', 'yearly']).optional().describe('Default monthly. biweekly means every 2 weeks'),
    next_charge: date.describe('Date of the next charge or payment, YYYY-MM-DD'),
    category: category.optional().describe('An expense category, or an income category for income'),
    card: z.string().optional(),
    match: z.string().optional().describe('Text in transaction names that identifies its charges. Defaults to the name')
  }
  const paymentBody = a => ({
    name: a.name,
    amount: a.amount,
    type: a.type && ({ bill: 'bill', income: 'income' }[a.type] || 'sub'),
    frequency: a.frequency,
    next: a.next_charge,
    category: a.category,
    card: a.card,
    match: a.match
  })

  tool('add_recurring_payment', {
    title: 'Add recurring payment',
    description: 'Add a subscription, bill or recurring income (like a salary) by hand, for ones the automatic detection misses. If it matches a detected one, the detected one is hidden.',
    inputSchema: paymentFields,
    annotations: WRITE
  }, async a => {
    const saved = await create('recurring', { type: 'sub', frequency: 'monthly', ...paymentBody(a), active: true })
    return { key: `manual:${saved._id}`, ...paymentBody(a), type: { bill: 'bill', income: 'income' }[saved.type] || 'subscription', frequency: saved.frequency }
  })

  tool('edit_recurring_payment', {
    title: 'Edit recurring payment',
    description: 'Change a payment that was added by hand. Use its key from list_recurring (it starts with "manual:").',
    inputSchema: {
      key: manualKey,
      ...Object.fromEntries(Object.entries(paymentFields).map(([k, v]) => [k, v.optional()])),
      active: z.boolean().optional().describe('false pauses it')
    },
    annotations: WRITE
  }, async a => {
    const saved = await update('recurring', a.key.slice(7), { ...paymentBody(a), active: a.active })
    return { key: a.key, name: saved.name, amount: saved.amount, frequency: saved.frequency, next_charge: saved.next, active: saved.active }
  })

  tool('delete_recurring_payment', {
    title: 'Delete recurring payment',
    description: 'Delete a payment that was added by hand. Detected ones cannot be deleted; mark them "not_recurring" with update_recurring instead.',
    inputSchema: { key: manualKey },
    annotations: DESTROY
  }, async a => {
    await remove('recurring', a.key.slice(7))
    return { deleted: a.key }
  })

  // ---------- Profile ----------

  // ---------- Transfers ----------

  const showTransfer = t => ({
    id: t.id,
    date: t.date,
    from: t.from,
    to: t.to,
    amount: t.value,
    note: t.note || undefined,
    converted_from_transactions: t.restorable || undefined
  })
  const transferList = async () => (await list('transfers')).map(fromApiTransfer)

  async function requireAccounts (...names) {
    const known = (await cards()).map(c => c.name)
    const missing = names.filter(name => name !== undefined && !known.includes(name))
    if (missing.length) throw new Error(`Unknown account: ${missing.join(', ')}. Accounts: ${known.join(', ') || 'none yet'}. Create it with save_card first.`)
  }

  tool('list_transfers', {
    title: 'List transfers',
    description: 'Money the user moved between their own accounts, newest first. Transfers are not income or spending and never appear in list_transactions.',
    inputSchema: { start_date: date.optional(), end_date: date.optional(), account: z.string().optional().describe('Only transfers from or to this account') },
    annotations: READ
  }, async a => (await transferList())
    .filter(t => (!a.start_date || t.date >= a.start_date) && (!a.end_date || t.date <= a.end_date) && (!a.account || t.from === a.account || t.to === a.account))
    .sort((x, y) => y.date.localeCompare(x.date))
    .map(showTransfer))

  tool('create_transfer', {
    title: 'Create transfer',
    description: 'Record money moved between two of the user\'s own accounts, like paying a credit card from debit or moving money to investments. Use this instead of create_transaction for those: it does not count as income or spending.',
    inputSchema: { from: z.string().min(1), to: z.string().min(1), amount: money, date: date.optional().describe('Defaults to today'), note: z.string().optional() },
    annotations: WRITE
  }, async a => {
    await requireAccounts(a.from, a.to)
    const saved = await create('transfers', { from: a.from, to: a.to, amount: a.amount, date: a.date || toISODate(new Date()), note: a.note })
    return showTransfer(fromApiTransfer(saved))
  })

  tool('update_transfer', {
    title: 'Update transfer',
    description: 'Change a transfer. Only the fields you send change.',
    inputSchema: { id: objectId, from: z.string().min(1).optional(), to: z.string().min(1).optional(), amount: money.optional(), date: date.optional(), note: z.string().optional() },
    annotations: WRITE
  }, async a => {
    await requireAccounts(a.from, a.to)
    return showTransfer(fromApiTransfer(await update('transfers', a.id, { from: a.from, to: a.to, amount: a.amount, date: a.date, note: a.note })))
  })

  tool('delete_transfer', {
    title: 'Delete transfer',
    description: 'Delete a transfer. With restore_original, a transfer converted from transactions gives those transactions back instead of losing them.',
    inputSchema: { id: objectId, restore_original: z.boolean().optional() },
    annotations: DESTROY
  }, async a => {
    if (a.restore_original) {
      const restored = await api.call(`/me/transfers/${a.id}/revert`, { method: 'POST' })
      return { id: a.id, restored_transactions: restored.length }
    }
    await remove('transfers', a.id)
    return { id: a.id, deleted: true }
  })

  tool('list_transfer_suggestions', {
    title: 'List possible transfers',
    description: 'Transactions that look like money moving between the user\'s own accounts and may be counted as income or spending by mistake. These are guesses: confirm with the user before converting. A blank from or to means the account has to be chosen.',
    inputSchema: {},
    annotations: READ
  }, async () => {
    const [all, cardList, dismissed] = await Promise.all([transactions(), cards(), list('transfer-dismissals')])
    return transferSuggestions(all, dismissed.map(d => d.key), cardList).map(s => ({
      key: s.key,
      transaction_ids: s.ids,
      amount: s.amount,
      date: s.date,
      suggested_from: s.from,
      suggested_to: s.to,
      transactions: s.items.map(t => present(t))
    }))
  })

  tool('convert_to_transfer', {
    title: 'Convert to transfer',
    description: 'Replace one transaction, or the expense and income sides of the same move, with a transfer, so they stop counting as income or spending. Undo with delete_transfer and restore_original.',
    inputSchema: { transaction_ids: z.array(objectId).min(1).max(2), from: z.string().min(1), to: z.string().min(1), note: z.string().optional() },
    annotations: WRITE
  }, async a => {
    const saved = await api.call('/me/transfers/convert', { method: 'POST', body: { transactionIds: a.transaction_ids, from: a.from, to: a.to, note: a.note } })
    return showTransfer(fromApiTransfer(saved))
  })

  tool('dismiss_transfer_suggestion', {
    title: 'Dismiss transfer suggestion',
    description: 'Mark a suggestion from list_transfer_suggestions as not being a transfer, so it stops showing.',
    inputSchema: { key: z.string() },
    annotations: WRITE
  }, async a => {
    await create('transfer-dismissals', { key: a.key })
    return { key: a.key, dismissed: true }
  })

  tool('get_profile', {
    title: 'Profile and settings',
    description: 'The user\'s name, username, email, currency, default range, monthly budget and notification settings.',
    annotations: READ
  }, async () => {
    const p = await api.call('/profile')
    return {
      name: p.name, username: p.username, email: p.email || undefined, member_since: p.memberSince,
      currency: p.settings.currency, default_range: p.settings.defaultRange,
      hide_amounts_on_open: p.settings.privacyOnOpen, monthly_budget: p.settings.budget,
      large_expense_alert_amount: p.settings.largeAmount, notifications: p.settings.notifications
    }
  })

  tool('update_profile', {
    title: 'Update profile and settings',
    description: 'Change name, username, email, display currency (amounts are not converted), default range, overall monthly budget, or notification settings. Turning a notification on here only saves the setting; push delivery also needs the app opened on the device.',
    inputSchema: {
      name: z.string().min(1).optional(),
      username: z.string().min(1).optional(),
      email: z.string().optional(),
      currency: z.enum(Object.keys(CURRENCIES)).optional(),
      default_range: rangeKey.optional(),
      hide_amounts_on_open: z.boolean().optional(),
      monthly_budget: z.number().nonnegative().optional(),
      large_expense_alert_amount: z.number().nonnegative().optional(),
      notifications: z.object({ daily: z.boolean().optional(), weekly: z.boolean().optional(), large: z.boolean().optional() }).optional()
    },
    annotations: WRITE
  }, async a => {
    const settings = {
      currency: a.currency, defaultRange: a.default_range, privacyOnOpen: a.hide_amounts_on_open,
      budget: a.monthly_budget, largeAmount: a.large_expense_alert_amount, notifications: a.notifications
    }
    const p = await api.call('/profile', { method: 'PATCH', body: { name: a.name, username: a.username, email: a.email, settings } })
    return { name: p.name, username: p.username, email: p.email, settings: p.settings }
  })

  tool('change_password', {
    title: 'Change password',
    description: 'Change the account password. Needs the current password. Suggest the app instead if the user prefers not to type passwords in chat.',
    inputSchema: { current_password: z.string().min(1), new_password: z.string().min(8) },
    annotations: WRITE
  }, async a => {
    // Changing it ends every session, this connection's too, so it moves to the new one.
    const { session } = await api.call('/profile/password', { method: 'POST', body: { current: a.current_password, next: a.new_password } })
    await replaceAppSession(auth.extra.appSession, session.refreshToken)
    return { changed: true, note: 'Other devices and connected apps were signed out.' }
  })

  tool('delete_account', {
    title: 'Delete account',
    description: 'Permanently delete the user\'s account and all its data. Only when the user explicitly asks. Needs the user\'s password, which you must ask the user to type; never reuse or guess one.',
    inputSchema: { password: z.string().min(1).describe('The user\'s Money Tracker password, typed by the user for this action') },
    annotations: DESTROY
  }, async a => {
    await api.call('/profile', { method: 'DELETE', body: { password: a.password } })
    return { deleted: true }
  })

  tool('whoami', {
    title: 'Connected account',
    description: 'Which Money Tracker account this connector is signed in to, and today\'s date in the account\'s timezone.',
    annotations: READ
  }, async () => ({ name: api.userName, user_id: id, today: toISODate(startOfToday()) }))
}
