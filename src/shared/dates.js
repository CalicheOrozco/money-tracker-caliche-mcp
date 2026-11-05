const DAY = 86400000

export function toISODate (date) {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function parseDay (value) {
  const [year, month, day] = String(value).split('-').map(Number)
  return new Date(year, (month || 1) - 1, day || 1)
}

export function startOfToday () {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

export function daysAgo (value) {
  return Math.round((startOfToday() - parseDay(value)) / DAY)
}

export function dayLabel (value) {
  const age = daysAgo(value)
  if (age === 0) return 'Today'
  if (age === 1) return 'Yesterday'

  const date = parseDay(value)
  const options = { weekday: 'short', month: 'short', day: 'numeric' }
  if (date.getFullYear() !== new Date().getFullYear()) options.year = 'numeric'
  return date.toLocaleDateString('en-US', options)
}

export function relativeTime (value) {
  const days = Math.floor((Date.now() - new Date(value)) / DAY)
  if (days < 1) return 'today'
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`
  const years = Math.floor(months / 12)
  return `${years} year${years === 1 ? '' : 's'} ago`
}
