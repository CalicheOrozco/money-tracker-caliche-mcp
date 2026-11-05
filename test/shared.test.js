import assert from 'node:assert/strict'
import { test } from 'node:test'
import { monthlyAmount, recurringState } from '../src/shared/recurring.js'
import { transferSuggestions } from '../src/shared/transfers.js'
import { CATEGORY_ICON, EXPENSE, INCOME } from '../src/shared/constants.js'

// The copies from the app must load on their own here and give the same answers.
test('shared helpers load and agree with the app', () => {
  const next = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const r = recurringState([], [], [{ _id: 'a'.repeat(24), name: 'Gym', amount: 60, type: 'sub', frequency: 'biweekly', next, active: true }]).all[0]
  assert.equal(monthlyAmount(r), 130)
  assert.deepEqual(transferSuggestions([], [], []), [])
  for (const [name] of [...INCOME, ...EXPENSE]) assert.ok(CATEGORY_ICON[name], name)
})
