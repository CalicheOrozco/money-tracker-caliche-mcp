import { RANGES } from './constants.js'
import { daysAgo, parseDay } from './dates.js'

const DAY = 86400000
// How far apart the two sides of a transfer can post.
const PAIR_WINDOW_DAYS = 3
const cents = amount => Math.round(Math.abs(amount) * 100)

const PAYMENT_NAME = /\b(card payment|credit card payment|payment thank you|pago (de )?(tarjeta|tdc)|pago tdc)\b/i
const RECEIVED_PAYMENT_NAME = /\b(payment|pago|abono)\b/i
const TRANSFER_CATEGORIES = ['Debts', 'Savings & Investments']

export const isCreditAccount = card => !card.type || card.type === 'credit'
export const isCashAccount = card => card.type === 'cash'

// Transactions without a card are cash, so they belong to the cash account.
export const belongsTo = card => t => t.card === card.name || (isCashAccount(card) && !t.card)
const isStorageAccount = card => card.type === 'savings' || card.type === 'investment'

// `amount` stays 0 so a transfer shown among transactions never changes a total.
// A converted transfer counts from when its original transactions were added, so a
// balance set in between does not count them twice.
const oldestId = t => [t._id, ...(t.source || []).map(s => String(s._id))].sort()[0]

export const fromApiTransfer = t => ({
  id: t._id,
  createdId: oldestId(t),
  transfer: true,
  from: t.from,
  to: t.to,
  value: t.amount,
  amount: 0,
  date: t.date,
  note: t.note || '',
  restorable: (t.source || []).length > 0,
  name: `Transfer to ${t.to}`,
  desc: t.note || '',
  category: 'Transfer',
  card: '',
  tags: [],
  merchant: 'none'
})

export const transfersInRange = (transfers, range) =>
  transfers.filter(t => daysAgo(t.date) >= 0 && daysAgo(t.date) < RANGES[range])

export const byNewest = (a, b) => b.date.localeCompare(a.date)

const createdSecond = id => parseInt(String(id).slice(0, 8), 16)

// Whether a movement came after the balance the user entered, which already includes
// anything earlier. On the balance's own day, only what was added after setting it counts.
function afterBalance (card, item) {
  if (daysAgo(item.date) < 0) return false
  if (item.date !== card.balanceDate) return item.date > card.balanceDate
  return createdSecond(item.createdId || item.id) >= Math.floor(new Date(card.balanceSetAt).getTime() / 1000)
}

// The balance today, or null if it isn't tracked. On a credit card it is the amount owed.
export function accountBalance (card, transactions, transfers) {
  if (typeof card.balance !== 'number') return null
  const counted = list => list.filter(item => afterBalance(card, item))
  const change = counted(transactions.filter(belongsTo(card))).reduce((total, t) => total + t.amount, 0) +
    counted(transfers.filter(t => t.to === card.name)).reduce((total, t) => total + t.value, 0) -
    counted(transfers.filter(t => t.from === card.name)).reduce((total, t) => total + t.value, 0)
  return isCreditAccount(card) ? card.balance - change : card.balance + change
}

// What is owed on each credit card: its tracked balance when there is one, otherwise
// the last 30 days of charges minus payments and refunds on that same card.
export function creditCardEstimate (transactions, transfers, cards) {
  const recent = t => daysAgo(t.date) >= 0 && daysAgo(t.date) < 30
  return cards.filter(isCreditAccount).reduce((total, card) => {
    if (typeof card.balance === 'number') return total + Math.max(0, accountBalance(card, transactions, transfers))
    const spent = transactions.filter(t => t.card === card.name && recent(t)).reduce((sum, t) => sum - t.amount, 0)
    const moved = transfers.filter(recent).reduce((sum, t) => {
      const value = t.value ?? t.amount
      return sum + (t.from === card.name ? value : 0) - (t.to === card.name ? value : 0)
    }, 0)
    return total + Math.max(0, spent + moved)
  }, 0)
}

function mentionedAccount (t, cards) {
  const text = `${t.name} ${t.desc || ''}`.toLowerCase()
  return cards.find(c => c.name !== t.card && c.name.length >= 3 && text.includes(c.name.toLowerCase()))
}

function guessDestination (t, cards) {
  const mentioned = mentionedAccount(t, cards)
  if (mentioned) return mentioned.name
  // A "Debts" expense can be any loan, so only a clear card payment points to a credit card.
  const savings = t.category === 'Savings & Investments'
  if (!savings && !PAYMENT_NAME.test(t.name)) return ''
  const candidates = cards.filter(c => c.name !== t.card).filter(savings ? isStorageAccount : isCreditAccount)
  return candidates.length === 1 ? candidates[0].name : ''
}

// Possible transfers, newest first. They are only suggestions: the same amount on two
// cards can be a coincidence, so nothing changes until the user confirms.
export function transferSuggestions (transactions, dismissedKeys, cards) {
  const dismissed = new Set(dismissedKeys)
  const past = transactions.filter(t => daysAgo(t.date) >= 0)
  // Incomes grouped by exact amount, so each expense only looks at the same amount.
  const incomesByAmount = new Map()
  for (const t of past) {
    if (!(t.amount > 0 && t.card)) continue
    const key = cents(t.amount)
    if (!incomesByAmount.has(key)) incomesByAmount.set(key, [])
    incomesByAmount.get(key).push({ t, day: parseDay(t.date).getTime() })
  }
  const used = new Set()
  const found = []

  for (const out of past.filter(t => t.amount < 0 && t.card)) {
    const day = parseDay(out.date).getTime()
    let match = null
    let closest = Infinity
    for (const candidate of incomesByAmount.get(cents(out.amount)) || []) {
      const distance = Math.abs(candidate.day - day)
      const usable = !used.has(candidate.t.id) && candidate.t.card !== out.card &&
        distance <= PAIR_WINDOW_DAYS * DAY && !dismissed.has(`pair:${out.id}:${candidate.t.id}`)
      if (usable && distance < closest) {
        match = candidate.t
        closest = distance
      }
    }
    if (!match) continue
    used.add(match.id)
    used.add(out.id)
    found.push({
      key: `pair:${out.id}:${match.id}`,
      kind: 'pair',
      ids: [out.id, match.id],
      items: [out, match],
      amount: Math.abs(out.amount),
      date: out.date,
      from: out.card,
      to: match.card
    })
  }

  // Transactions from a pair the user said is not a transfer aren't offered alone either.
  const rejected = new Set([...dismissed].filter(key => key.startsWith('pair:')).flatMap(key => key.split(':').slice(1)))

  for (const t of past) {
    if (used.has(t.id) || rejected.has(t.id)) continue
    const card = cards.find(c => c.name === t.card)
    if (t.amount < 0) {
      const looksLikeTransfer = TRANSFER_CATEGORIES.includes(t.category) || PAYMENT_NAME.test(t.name) || mentionedAccount(t, cards)
      if (looksLikeTransfer) {
        found.push({ key: `single:${t.id}`, kind: 'single', ids: [t.id], items: [t], amount: -t.amount, date: t.date, from: t.card, to: guessDestination(t, cards) })
      }
    } else if (card && isCreditAccount(card) && RECEIVED_PAYMENT_NAME.test(t.name)) {
      // A payment received by a credit card, as banks usually name it.
      found.push({ key: `single:${t.id}`, kind: 'single', ids: [t.id], items: [t], amount: t.amount, date: t.date, from: '', to: t.card })
    }
  }

  return found.filter(s => !dismissed.has(s.key)).sort(byNewest)
}
