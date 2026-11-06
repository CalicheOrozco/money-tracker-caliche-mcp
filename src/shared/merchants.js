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

// Patterns are normalized once per merchant list, and each text is matched once,
// because this runs for every transaction on screen.
const prepared = new WeakMap()

function prepare (merchants) {
  let entry = prepared.get(merchants)
  if (!entry) {
    const patterns = merchants.flatMap((merchant, order) => merchant.patterns.map(pattern => {
      const plain = normalize(pattern)
      return { merchant, pattern, plain, tight: compact(plain), order }
    })).filter(p => p.plain)
    entry = { patterns, results: new Map() }
    prepared.set(merchants, entry)
  }
  return entry
}

// Every merchant whose patterns appear in the text, best first: a merchant set to always
// win, then the most specific (longest) pattern, then the merchant added first.
export function matchAll (merchants, rawText) {
  const text = normalize(rawText)
  const { patterns, results } = prepare(merchants)
  if (results.has(text)) return results.get(text)
  const tightText = compact(text)
  const best = new Map()
  for (const p of patterns) {
    if (!(text.includes(p.plain) || tightText.includes(p.tight))) continue
    const current = best.get(p.merchant)
    if (!current || p.tight.length > current.tight.length) best.set(p.merchant, p)
  }
  const hits = [...best.values()]
    .sort((a, b) => (b.merchant.pinned ? 1 : 0) - (a.merchant.pinned ? 1 : 0) || b.tight.length - a.tight.length || a.order - b.order)
    .map(p => ({ merchant: p.merchant, pattern: p.pattern }))
  if (results.size > 5000) results.clear()
  results.set(text, hits)
  return hits
}

export const patternMatch = (merchants, rawText) => matchAll(merchants, rawText)[0]?.merchant || null

export function resolveMerchant (merchants, t) {
  if (t.merchant === 'none') return null
  if (t.merchant) {
    const chosen = merchants.find(m => m._id === t.merchant)
    if (chosen) return chosen
  }
  return patternMatch(merchants, haystack(t))
}

// The merchant of a transaction and how it was decided: chosen by hand, or the
// pattern that matched.
export function merchantMatch (merchants, t) {
  if (t.merchant === 'none') return null
  if (t.merchant) {
    const chosen = merchants.find(m => m._id === t.merchant)
    if (chosen) return { merchant: chosen, pattern: '', manual: true }
  }
  return matchAll(merchants, haystack(t))[0] || null
}

// A short pattern from a statement name: its first words, at least four letters long.
export function suggestPattern (key) {
  const words = String(key).split(' ').filter(Boolean)
  const out = []
  for (const word of words) {
    out.push(word)
    if (out.join(' ').length >= 4) break
  }
  return out.join(' ') || key
}

export const matchesPatterns = (patterns, t) => {
  const text = haystack(t)
  return patterns.some(p => contains(text, p))
}
