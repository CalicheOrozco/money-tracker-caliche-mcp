// A split transaction is one row in lists and balances, but each part counts in its
// own category for totals, budgets and reports.
export const MAX_SPLITS = 10

export const isSplit = t => Array.isArray(t.splits) && t.splits.length >= 2

const cents = amount => Math.round(Math.abs(amount) * 100)

// Each part as its own entry with the parent's sign and details. `parent` points back
// to the whole transaction, which is what opens for editing.
export function splitParts (t) {
  if (!isSplit(t)) return [t]
  const sign = t.amount < 0 ? -1 : 1
  return t.splits.map((part, index) => ({
    ...t,
    amount: sign * part.amount,
    category: part.category,
    part: index,
    parent: t
  }))
}

// Every transaction with splits replaced by its parts.
export const byCategoryEntries = list => list.flatMap(splitParts)

// Whether a transaction counts in a category, as a whole or through one of its parts.
export const inCategory = (t, category) =>
  t.category === category || (isSplit(t) && t.splits.some(part => part.category === category))

// What a list should show as the category of a split transaction.
export const categoryLabel = t => (isSplit(t) ? `Split · ${[...new Set(t.splits.map(s => s.category))].join(', ')}` : t.category)

// The problem with a set of parts for a total, or null when they are valid.
export function splitProblem (splits, total) {
  if (!Array.isArray(splits)) return 'The split is not valid.'
  if (splits.length === 0) return null
  if (splits.length < 2) return 'A split needs at least two parts.'
  if (splits.length > MAX_SPLITS) return `A split can have up to ${MAX_SPLITS} parts.`
  for (const part of splits) {
    if (!part || typeof part.category !== 'string' || !part.category.trim() || part.category.length > 60) {
      return 'Every part of the split needs a category.'
    }
    const whole = typeof part.amount === 'number' && Math.abs(part.amount * 100 - Math.round(part.amount * 100)) < 1e-6
    if (!whole || !Number.isFinite(part.amount) || part.amount <= 0 || part.amount > 1e12) {
      return 'Every part of the split needs an amount greater than 0.'
    }
  }
  const sum = splits.reduce((total, part) => total + cents(part.amount), 0)
  if (sum !== cents(total)) return 'The parts of the split must add up to the total.'
  return null
}
