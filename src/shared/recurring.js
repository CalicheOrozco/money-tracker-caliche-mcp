import { BILL_CATS, SUB_CATS } from './constants.js'
import { daysAgo, parseDay, startOfToday } from './dates.js'

const DAY = 86400000
const normalize = name => String(name).toLowerCase().replace(/[^a-z0-9]/g, '')

// A charge counts as recurring when the same name shows up at least three times,
// roughly once a month, for a similar amount.
export function detectRecurring (transactions, sign) {
  const groups = {}
  for (const t of transactions) {
    const key = normalize(t.name)
    const matchesSign = sign < 0 ? t.amount < 0 : t.amount > 0
    if (key && matchesSign && daysAgo(t.date) >= 0) (groups[key] ||= []).push(t)
  }

  const found = []
  for (const [key, group] of Object.entries(groups)) {
    if (group.length < 3) continue

    const list = [...group].sort((a, b) => a.date.localeCompare(b.date))
    const gaps = list.slice(1).map((t, i) => (parseDay(t.date) - parseDay(list[i].date)) / DAY)
    if (gaps.filter(gap => gap < 18 || gap > 45).length > 1) continue

    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length
    if (avgGap < 22 || avgGap > 40) continue

    const amounts = list.map(t => Math.abs(t.amount))
    const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length
    const variation = Math.sqrt(amounts.reduce((a, x) => a + (x - avg) ** 2, 0) / amounts.length) / avg
    if (variation > 0.5) continue

    const last = list[list.length - 1]
    const category = last.category
    const type = BILL_CATS.includes(category)
      ? 'bill'
      : SUB_CATS.includes(category) || variation < 0.02 ? 'sub' : 'bill'
    const next = parseDay(last.date)
    next.setDate(next.getDate() + Math.round(avgGap))

    found.push({
      key,
      name: last.name,
      category,
      card: last.card,
      list,
      avg,
      min: Math.min(...amounts),
      max: Math.max(...amounts),
      avgGap,
      type,
      last,
      next,
      stale: daysAgo(last.date) > avgGap * 1.5 + 5,
      sure: variation < 0.05 || BILL_CATS.includes(category)
    })
  }
  return found
}

export const monthlyAmount = r => (r.avg * 30) / r.avgGap

export const daysUntil = date => Math.round((date - startOfToday()) / DAY)

export function dueDatesInMonth (r, year, month) {
  const today = startOfToday()
  const dates = []
  let date = parseDay(r.last.date)
  for (let i = 0; i < 36; i++) {
    date = new Date(date)
    date.setDate(date.getDate() + Math.round(r.avgGap))
    if (date.getFullYear() > year || (date.getFullYear() === year && date.getMonth() > month)) break
    if (date >= today && date.getFullYear() === year && date.getMonth() === month) dates.push(date)
  }
  return dates
}

export function recurringState (transactions, overrides) {
  const byKey = Object.fromEntries(overrides.map(o => [o.key, o]))

  const all = detectRecurring(transactions, -1)
    .map(r => {
      const override = byKey[r.key] || {}
      const cancelled = override.status === 'cancelled'
      return {
        ...r,
        type: override.type || r.type,
        cancelled,
        inactive: cancelled || r.stale,
        review: !r.sure && !override.status,
        dismissed: override.status === 'dismissed'
      }
    })
    .filter(r => !r.dismissed)

  const active = all.filter(r => !r.inactive && !r.review)
  const upcoming = active
    .filter(r => {
      const days = daysUntil(r.next)
      return days >= 0 && days <= 30
    })
    .sort((a, b) => a.next - b.next)

  return {
    all,
    active,
    lists: {
      subs: active.filter(r => r.type === 'sub'),
      bills: active.filter(r => r.type === 'bill'),
      inactive: all.filter(r => r.inactive)
    },
    review: all.filter(r => r.review && !r.inactive),
    upcoming,
    income: detectRecurring(transactions, 1)
      .filter(r => !r.stale)
      .reduce((total, r) => total + monthlyAmount(r), 0)
  }
}
