import { daysAgo } from './dates.js'
import { byCategoryEntries } from './splits.js'

export const monthKey = (year, month) => {
  const date = new Date(year, month, 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

export const currentMonthKey = () => {
  const now = new Date()
  return monthKey(now.getFullYear(), now.getMonth())
}

export const shiftMonth = (key, delta) => {
  const [year, month] = key.split('-').map(Number)
  return monthKey(year, month - 1 + delta)
}

export const monthLabel = (key, style = 'long') => {
  const [year, month] = key.split('-').map(Number)
  return new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: style })
}

export const inMonth = (transactions, key) =>
  transactions.filter(t => t.date.startsWith(key) && daysAgo(t.date) >= 0)

// With a category, the parts of split transactions count in their own categories.
export const expensesOf = (list, category) =>
  -(category ? byCategoryEntries(list) : list)
    .filter(t => t.amount < 0 && (!category || t.category === category))
    .reduce((total, t) => total + t.amount, 0)

// Every category with spending in the list, split parts included.
export const expenseCategories = list =>
  [...new Set(byCategoryEntries(list).filter(t => t.amount < 0).map(t => t.category))]

export const incomeOf = list =>
  list.filter(t => t.amount > 0).reduce((total, t) => total + t.amount, 0)

export const percentChange = (now, before) => (before ? Math.round(((now - before) / before) * 100) : 0)

// Green when the change is good: more income, or less spending when inverted.
export function deltaPill (change, invert) {
  const good = invert ? change <= 0 : change >= 0
  return {
    text: `${change > 0 ? '+' : change < 0 ? '−' : ''}${Math.abs(change)}%`,
    className: change === 0
      ? 'bg-raised text-muted'
      : good ? 'bg-accent/10 text-accent' : 'bg-danger/10 text-danger'
  }
}
