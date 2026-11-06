import { byCategoryEntries } from './splits.js'

// Expense categories that often matter for a tax return. Rules change by country, so
// the app only gathers them; it never says what is deductible.
export const TAX_EXPENSES = ['Medical & Healthcare', 'Education & Training', 'Gifts & Donations']

const round = amount => Math.round(amount * 100) / 100
const sumBy = (list, keyOf) => {
  const totals = new Map()
  for (const item of list) {
    const key = keyOf(item)
    totals.set(key, (totals.get(key) || 0) + Math.abs(item.amount))
  }
  return totals
}
const sorted = totals => [...totals].map(([name, amount]) => ({ name, amount: round(amount) })).sort((a, b) => b.amount - a.amount)

// Years that have transactions up to `today` (YYYY-MM-DD), newest first.
export const yearsWithData = (transactions, today) =>
  [...new Set(transactions.filter(t => t.date <= today).map(t => Number(t.date.slice(0, 4))))].sort((a, b) => b - a)

function totals (list) {
  const income = round(list.filter(t => t.amount > 0).reduce((sum, t) => sum + t.amount, 0))
  const expense = round(-list.filter(t => t.amount < 0).reduce((sum, t) => sum + t.amount, 0))
  return { income, expense, net: round(income - expense), rate: income > 0 ? Math.round(((income - expense) / income) * 100) : null }
}

const change = (now, before) => (before > 0 ? Math.round(((now - before) / before) * 100) : null)

// A year of money: totals against the year before, each month, where it went and what
// changed, the largest expenses, tags, and the figures a tax return usually asks for.
export function yearReview (transactions, year, today) {
  const past = transactions.filter(t => t.date <= today)
  const inYear = past.filter(t => t.date.startsWith(`${year}-`))
  const before = past.filter(t => t.date.startsWith(`${year - 1}-`))
  const now = totals(inYear)
  const previous = totals(before)

  const months = Array.from({ length: 12 }, (_, i) => {
    const key = `${year}-${String(i + 1).padStart(2, '0')}`
    return { key, ...totals(inYear.filter(t => t.date.startsWith(key))) }
  })
  const active = months.filter(m => m.income || m.expense)

  const expenses = list => byCategoryEntries(list).filter(t => t.amount < 0)
  const lastYear = sumBy(expenses(before), t => t.category)
  const categories = sorted(sumBy(expenses(inYear), t => t.category)).map(c => ({
    ...c,
    previous: round(lastYear.get(c.name) || 0),
    change: change(c.amount, lastYear.get(c.name) || 0),
    share: now.expense ? Math.round((c.amount / now.expense) * 100) : 0
  }))
  // Categories with spending last year and none this year also count as shrinking.
  const gone = [...lastYear].filter(([name]) => !categories.some(c => c.name === name))
    .map(([name, amount]) => ({ name, amount: 0, previous: round(amount), change: -100, share: 0 }))
  const moves = [...categories, ...gone].map(c => ({ ...c, difference: round(c.amount - c.previous) }))
  const hasLastYear = before.length > 0

  const tags = new Map()
  for (const t of inYear.filter(t => t.amount < 0)) {
    for (const tag of t.tags || []) tags.set(tag, (tags.get(tag) || 0) - t.amount)
  }
  const incomeByCategory = sorted(sumBy(byCategoryEntries(inYear).filter(t => t.amount > 0), t => t.category))
  const expenseTotals = new Map(categories.map(c => [c.name, c.amount]))

  return {
    year,
    partial: today.startsWith(`${year}-`),
    count: inYear.length,
    hasLastYear,
    totals: now,
    previous: previous.income || previous.expense ? previous : null,
    changes: { income: change(now.income, previous.income), expense: change(now.expense, previous.expense) },
    months,
    bestMonth: active.length ? active.reduce((best, m) => (m.net > best.net ? m : best)) : null,
    biggestMonth: active.length ? active.reduce((most, m) => (m.expense > most.expense ? m : most)) : null,
    categories,
    grew: hasLastYear ? moves.filter(c => c.difference > 0).sort((a, b) => b.difference - a.difference).slice(0, 3) : [],
    shrank: hasLastYear ? moves.filter(c => c.difference < 0).sort((a, b) => a.difference - b.difference).slice(0, 3) : [],
    biggest: inYear.filter(t => t.amount < 0).sort((a, b) => a.amount - b.amount).slice(0, 5),
    tags: sorted(tags).slice(0, 8),
    tax: {
      income: incomeByCategory,
      expenses: TAX_EXPENSES.map(name => ({ name, amount: round(expenseTotals.get(name) || 0) })).filter(c => c.amount > 0)
    }
  }
}
