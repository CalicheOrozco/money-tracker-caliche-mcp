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

// Manual payments have an exact frequency; detected ones use their average gap.
const PER_MONTH = { weekly: 52 / 12, monthly: 1, yearly: 1 / 12 }

export const monthlyAmount = r =>
  r.manual ? r.avg * (PER_MONTH[r.frequency] ?? 1) : (r.avg * 30) / r.avgGap

const FREQUENCY_DAYS = { weekly: 7, monthly: 30.44, yearly: 365.25 }

// Adds whole periods to an anchor date. Monthly and yearly keep the anchor's day,
// clamped to shorter months, so a charge on the 31st lands on Feb 28.
function addPeriods (anchor, frequency, count) {
  if (frequency === 'weekly') {
    const date = new Date(anchor)
    date.setDate(date.getDate() + 7 * count)
    return date
  }
  const months = frequency === 'yearly' ? 12 * count : count
  const first = new Date(anchor.getFullYear(), anchor.getMonth() + months, 1)
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  return new Date(first.getFullYear(), first.getMonth(), Math.min(anchor.getDate(), lastDay))
}

// Charges from the stored next date onward, skipping past ones, up to `until`
// (and at most `limit` of them).
function occurrences (r, until, limit = Infinity) {
  const today = startOfToday()
  const anchor = parseDay(r.anchor)
  const dates = []
  for (let n = 0; n < 5000 && dates.length < limit; n++) {
    const date = addPeriods(anchor, r.frequency, n)
    if (date > until) break
    if (date >= today) dates.push(date)
  }
  return dates
}

function manualEntry (item, transactions) {
  const pattern = normalize(item.match || item.name)
  const list = pattern
    ? transactions
      .filter(t => t.amount < 0 && daysAgo(t.date) >= 0 && normalize(`${t.name} ${t.desc || ''}`).includes(pattern))
      .sort((a, b) => a.date.localeCompare(b.date))
    : []
  const anchor = item.next
  const [next] = occurrences({ anchor, frequency: item.frequency }, new Date(2200, 0, 1), 1)
  return {
    key: `manual:${item._id}`,
    id: item._id,
    manual: true,
    pattern,
    matchText: item.match || '',
    name: item.name,
    category: item.category || 'Other',
    card: item.card || '',
    list,
    avg: item.amount,
    min: item.amount,
    max: item.amount,
    avgGap: FREQUENCY_DAYS[item.frequency] || FREQUENCY_DAYS.monthly,
    frequency: item.frequency,
    anchor,
    type: item.type,
    last: list[list.length - 1] || null,
    next: next || parseDay(anchor),
    stale: false,
    sure: true,
    cancelled: !item.active,
    inactive: !item.active,
    review: false,
    dismissed: false
  }
}

export const daysUntil = date => Math.round((date - startOfToday()) / DAY)

export function dueDatesInMonth (r, year, month) {
  if (r.manual) {
    return occurrences(r, new Date(year, month + 1, 0)).filter(
      date => date.getFullYear() === year && date.getMonth() === month
    )
  }
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

export function recurringState (transactions, overrides, manual = []) {
  const byKey = Object.fromEntries(overrides.map(o => [o.key, o]))
  const added = manual.map(item => manualEntry(item, transactions))
  // A manually added payment replaces the detected one for the same charge.
  const coveredByManual = r =>
    added.some(m => m.pattern && (r.key.includes(m.pattern) || m.pattern.includes(r.key)))

  const detected = detectRecurring(transactions, -1)
    .filter(r => !coveredByManual(r))
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
  const all = [...detected, ...added]

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
