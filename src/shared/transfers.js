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
export const isStorageAccount = card => card.type === 'savings' || card.type === 'investment'

// `amount` stays 0 so a transfer shown among transactions never changes a total.
export const fromApiTransfer = t => ({
  id: t._id,
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

// Charged in the last 30 days, minus what was paid to each credit card in that time.
export function creditCardEstimate (transactions, transfers, cards) {
  const credit = new Set(cards.filter(isCreditAccount).map(c => c.name))
  const recent = t => daysAgo(t.date) >= 0 && daysAgo(t.date) < 30
  const charged = transactions
    .filter(t => t.amount < 0 && credit.has(t.card) && recent(t))
    .reduce((total, t) => total - t.amount, 0)
  const moved = transfers.filter(recent).reduce((total, t) => {
    const value = t.value ?? t.amount
    return total + (credit.has(t.from) ? value : 0) - (credit.has(t.to) ? value : 0)
  }, 0)
  return Math.max(0, charged + moved)
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
  const incomes = past.filter(t => t.amount > 0 && t.card)
  const used = new Set()
  const found = []

  for (const out of past.filter(t => t.amount < 0 && t.card)) {
    const match = incomes
      .filter(t =>
        !used.has(t.id) && t.card !== out.card && cents(t.amount) === cents(out.amount) &&
        Math.abs(parseDay(t.date) - parseDay(out.date)) <= PAIR_WINDOW_DAYS * DAY
      )
      .sort((a, b) => Math.abs(parseDay(a.date) - parseDay(out.date)) - Math.abs(parseDay(b.date) - parseDay(out.date)))[0]
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

  for (const t of past) {
    if (used.has(t.id)) continue
    const card = cards.find(c => c.name === t.card)
    if (t.amount < 0) {
      const looksLikeTransfer = TRANSFER_CATEGORIES.includes(t.category) || PAYMENT_NAME.test(t.name) || mentionedAccount(t, cards)
      if (looksLikeTransfer) {
        found.push({ key: `single:${t.id}`, kind: 'single', ids: [t.id], items: [t], amount: -t.amount, date: t.date, from: t.card, to: guessDestination(t, cards) })
      }
    } else if (card && isCreditAccount(card) && RECEIVED_PAYMENT_NAME.test(t.name)) {
      // A payment received by a credit card, as it appears on an imported statement.
      found.push({ key: `single:${t.id}`, kind: 'single', ids: [t.id], items: [t], amount: t.amount, date: t.date, from: '', to: t.card })
    }
  }

  return found.filter(s => !dismissed.has(s.key)).sort(byNewest)
}
