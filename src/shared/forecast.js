import { addDays, cardDues, daysBetween } from './cardCycle.js'
import { toISODate } from './dates.js'
import { accountBalance, isCreditAccount } from './transfers.js'

// Money you can spend now: what is in debit and cash accounts with a tracked balance.
// Savings and investments are set aside, and credit cards are paid through their due dates.
const isSpendable = card => card.type === 'debit' || card.type === 'cash'
const round = amount => Math.round(amount * 100) / 100

// How much is free to spend until the next pay, after the bills and card payments due
// before it, and the lowest point the spendable money reaches in the next `days`.
//
// `recurring` is recurringState's result and `today` a YYYY-MM-DD day.
export function safeToSpend ({ cards, transactions, transfers, recurring, today, days = 30 }) {
  const accounts = cards
    .filter(card => isSpendable(card) && typeof card.balance === 'number')
    .map(card => ({ name: card.name, balance: round(accountBalance(card, transactions, transfers, today)) }))
  if (!accounts.length) return { ready: false }

  const end = addDays(today, days)
  const creditCards = new Set(cards.filter(isCreditAccount).map(card => card.name))
  const storage = new Set(cards.filter(card => card.type === 'savings' || card.type === 'investment').map(card => card.name))
  const within = day => day >= today && day <= end

  // Charges on a credit card are paid with the card, so only its payment counts here.
  const bills = recurring.upcoming
    .map(r => ({ kind: 'bill', name: r.name, date: toISODate(r.next), amount: -round(r.avg) }))
    .filter((bill, i) => within(bill.date) && !creditCards.has(recurring.upcoming[i].card))
  const pays = recurring.upcomingIncome
    .map(r => ({ kind: 'income', name: r.name, date: toISODate(r.next), amount: round(r.avg) }))
    .filter((pay, i) => within(pay.date) && !creditCards.has(recurring.upcomingIncome[i].card) && !storage.has(recurring.upcomingIncome[i].card))
  const cardPayments = cardDues(cards, transactions, transfers, today)
    .filter(due => due.issued && due.amountDue > 0 && within(due.dueDate))
    .map(due => ({ kind: 'card', name: due.card, date: due.dueDate, amount: -due.amountDue }))

  const cash = round(accounts.reduce((sum, a) => sum + a.balance, 0))
  const payday = pays[0] || null
  // Without an expected pay, the period runs to the end of the month.
  const [year, month] = today.split('-').map(Number)
  const monthEnd = toISODate(new Date(year, month, 0))
  const until = payday ? payday.date : monthEnd
  const before = [...bills, ...cardPayments].filter(item => (payday ? item.date < until : item.date <= until)).sort((a, b) => a.date.localeCompare(b.date))
  const safe = round(cash + before.reduce((sum, item) => sum + item.amount, 0))
  const daysLeft = Math.max(1, daysBetween(today, until) + (payday ? 0 : 1))

  // Day by day, deposits first on a shared day, as banks usually post them overnight.
  const events = [...pays, ...bills, ...cardPayments].sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount)
  let running = cash
  let lowest = { date: today, balance: cash }
  let firstNegative = null
  for (const event of events) {
    running = round(running + event.amount)
    if (running < lowest.balance) lowest = { date: event.date, balance: running }
    if (running < 0 && !firstNegative) firstNegative = { date: event.date, balance: running, after: event.name }
  }

  return {
    ready: true,
    cash,
    accounts,
    payday,
    until,
    daysLeft,
    upcoming: before,
    safe,
    perDay: round(Math.max(0, safe) / daysLeft),
    lowest,
    firstNegative,
    events
  }
}
