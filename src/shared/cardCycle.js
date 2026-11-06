import { accountBalance, isCreditAccount } from './transfers.js'

// Credit card statements and due dates. Days are YYYY-MM-DD text, so the math is the
// same in the browser, the server's reminders and the MCP, whatever their time zone.

const pad = n => String(n).padStart(2, '0')
const fromUTC = date => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
const toUTC = day => new Date(`${day}T00:00:00Z`)
const DAY = 86400000

export const addDays = (day, count) => fromUTC(new Date(toUTC(day).getTime() + count * DAY))
export const daysBetween = (from, to) => Math.round((toUTC(to) - toUTC(from)) / DAY)

// The date with that day of the month, moved to the last day in shorter months.
function onDay (year, month, day) {
  const first = new Date(Date.UTC(year, month, 1))
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  return fromUTC(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, last))))
}

const parts = day => day.split('-').map(Number)

// The first date on or after `from` that falls on that day of the month.
export function nextOnDay (from, day) {
  const [year, month] = parts(from)
  const thisMonth = onDay(year, month - 1, day)
  return thisMonth >= from ? thisMonth : onDay(year, month, day)
}

// The last date strictly before `before` that falls on that day of the month.
export function previousOnDay (before, day) {
  const [year, month] = parts(before)
  const thisMonth = onDay(year, month - 1, day)
  return thisMonth < before ? thisMonth : onDay(year, month - 2, day)
}

const validDay = value => Number.isInteger(value) && value >= 1 && value <= 31
const round = amount => Math.round(amount * 100) / 100
const onCard = card => t => !t.transfer && t.card === card.name

// The next payment of a credit card: when it is due, the statement it pays and what is
// left to pay. Null when the card has no due day.
//
// `issued` is false while the statement for that due date hasn't closed yet; the amount
// is then what has been spent so far in the cycle.
export function cardDue (card, transactions, transfers, today) {
  if (!isCreditAccount(card) || !validDay(card.dueDay)) return null
  const dueDate = nextOnDay(today, card.dueDay)
  const closeDate = validDay(card.statementDay) ? previousOnDay(dueDate, card.statementDay) : null
  const issued = !closeDate || closeDate <= today
  const mine = transactions.filter(onCard(card)).filter(t => t.date <= today)
  const tracked = typeof card.balance === 'number'
  const owedNow = tracked ? Math.max(0, accountBalance(card, transactions, transfers, today)) : null

  let amountDue
  if (!closeDate) {
    // Without a statement day, everything owed today is due.
    amountDue = tracked ? owedNow : mine.filter(t => t.date > addDays(today, -30)).reduce((sum, t) => sum - t.amount, 0)
  } else if (!issued) {
    const cycleStart = previousOnDay(closeDate, card.statementDay)
    amountDue = mine.filter(t => t.date > cycleStart).reduce((sum, t) => sum - t.amount, 0)
  } else if (tracked) {
    // What is owed today, minus what was spent after the statement closed.
    const newCharges = mine.filter(t => t.date > closeDate && t.amount < 0).reduce((sum, t) => sum - t.amount, 0)
    amountDue = owedNow - newCharges
  } else {
    // The statement's spending, minus payments made since it closed.
    const cycleStart = previousOnDay(closeDate, card.statementDay)
    const statement = mine.filter(t => t.date > cycleStart && t.date <= closeDate).reduce((sum, t) => sum - t.amount, 0)
    const paid = mine.filter(t => t.date > closeDate && t.amount > 0).reduce((sum, t) => sum + t.amount, 0) +
      transfers.filter(t => t.to === card.name && t.date > closeDate && t.date <= today).reduce((sum, t) => sum + (t.value ?? t.amount), 0)
    amountDue = statement - paid
  }

  amountDue = round(Math.max(0, amountDue))
  return {
    card: card.name,
    dueDate,
    closeDate,
    issued,
    amountDue,
    daysLeft: daysBetween(today, dueDate),
    paid: issued && amountDue === 0
  }
}

// Every credit card with a due day, soonest first.
export const cardDues = (cards, transactions, transfers, today) =>
  cards.map(card => cardDue(card, transactions, transfers, today)).filter(Boolean).sort((a, b) => a.dueDate.localeCompare(b.dueDate))
