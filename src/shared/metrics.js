import { PALETTE, RANGES } from './constants.js'
import { daysAgo, parseDay } from './dates.js'

const sum = list => list.reduce((total, t) => total + t.amount, 0)

// Future-dated transactions stay out of every figure until their day arrives.
export function computeMetrics (transactions, range) {
  const days = RANGES[range]
  const past = transactions.filter(t => daysAgo(t.date) >= 0)
  const inRange = past.filter(t => daysAgo(t.date) < days)

  const income = sum(inRange.filter(t => t.amount > 0))
  const expense = -sum(inRange.filter(t => t.amount < 0))

  const byAge = new Map()
  let oldest = 1
  for (const t of past) {
    const age = daysAgo(t.date)
    byAge.set(age, (byAge.get(age) || 0) + t.amount)
    oldest = Math.max(oldest, age)
  }

  const points = Math.max(2, Math.min(days, oldest + 1))
  let running = sum(past.filter(t => daysAgo(t.date) >= points))
  const series = []
  for (let age = points - 1; age >= 0; age--) {
    running += byAge.get(age) || 0
    const date = new Date()
    date.setDate(date.getDate() - age)
    series.push({ date, value: running })
  }

  const totals = {}
  for (const t of inRange) {
    if (t.amount < 0) totals[t.category] = (totals[t.category] || 0) - t.amount
  }
  const categories = Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .map(([name, amount], i) => ({
      name,
      amount,
      color: PALETTE[Math.min(i, PALETTE.length - 1)]
    }))

  return {
    inRange,
    income,
    expense,
    net: income - expense,
    balance: sum(past),
    series,
    categories
  }
}

export function sparkPaths (series) {
  const values = series.map(p => p.value)
  const min = Math.min(...values)
  const span = Math.max(...values) - min || 1
  const line =
    'M' +
    series
      .map((p, i) => {
        const x = (i / (series.length - 1)) * 600
        const y = 12 + (1 - (p.value - min) / span) * 126
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' L')
  return { line, area: `${line} L600,150 L0,150 Z` }
}

export function monthlyCashflow (transactions, count = 6) {
  const now = new Date()
  const months = []
  for (let i = count - 1; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const inMonth = transactions.filter(t => {
      const day = parseDay(t.date)
      return (
        day.getFullYear() === start.getFullYear() &&
        day.getMonth() === start.getMonth() &&
        daysAgo(t.date) >= 0
      )
    })
    months.push({
      label: start.toLocaleDateString('en-US', { month: 'short' }),
      income: sum(inMonth.filter(t => t.amount > 0)),
      expense: -sum(inMonth.filter(t => t.amount < 0))
    })
  }
  return months
}

export function currentMonth (transactions) {
  const now = new Date()
  const list = transactions.filter(t => {
    const day = parseDay(t.date)
    return (
      day.getFullYear() === now.getFullYear() &&
      day.getMonth() === now.getMonth() &&
      daysAgo(t.date) >= 0
    )
  })
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  return {
    income: sum(list.filter(t => t.amount > 0)),
    expense: -sum(list.filter(t => t.amount < 0)),
    name: now.toLocaleDateString('en-US', { month: 'long' }),
    resets: next.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
}
