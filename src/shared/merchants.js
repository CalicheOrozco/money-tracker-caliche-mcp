const NOISE = /\b(s\.?\s?a\.?(\s?de\s?c\.?\s?v\.?)?|s\.?\s?de\s?r\.?\s?l\.?|inc|llc|ltd|mx|mex|mexico|com|www|net|pos|compra|pago)\b/g

// Bank statements add branch numbers, references and legal suffixes, so names
// are reduced to the words that identify the business.
export function merchantKey (name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[#*]?\d{2,}/g, ' ')
    .replace(/[^a-z0-9& ]+/g, ' ')
    .replace(NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 3)
    .join(' ')
}

// Punctuation, accents and spacing are ignored when matching, so "wal-mart",
// "Wal Mart" and "WALMART" all compare equal to the pattern "walmart".
const normalize = text => String(text ?? '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9&]+/g, ' ')
  .trim()

const compact = text => text.replace(/ /g, '')

function contains (text, pattern) {
  const p = normalize(pattern)
  if (!p) return false
  return text.includes(p) || compact(text).includes(compact(p))
}

export const titleCase = text => text.replace(/\b\w/g, c => c.toUpperCase())

const haystack = t => normalize(`${t.name} ${t.desc}`)

// The longest matching pattern wins, so "uber eats" beats "uber".
export function patternMatch (merchants, rawText) {
  const text = normalize(rawText)
  let best = null
  let bestLength = 0
  for (const merchant of merchants) {
    for (const pattern of merchant.patterns) {
      const length = compact(normalize(pattern)).length
      if (length > bestLength && contains(text, pattern)) {
        best = merchant
        bestLength = length
      }
    }
  }
  return best
}

export function resolveMerchant (merchants, t) {
  if (t.merchant === 'none') return null
  if (t.merchant) {
    const chosen = merchants.find(m => m._id === t.merchant)
    if (chosen) return chosen
  }
  return patternMatch(merchants, haystack(t))
}

export const matchesPatterns = (patterns, t) => {
  const text = haystack(t)
  return patterns.some(p => contains(text, p))
}
