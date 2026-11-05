import { collections } from './db.js'

// Counters live in the database because each serverless instance has its own memory.
export async function hit (key, max, windowMs) {
  const { rateLimits } = await collections()
  const now = new Date()
  const current = await rateLimits.findOneAndUpdate(
    { key, expiresAt: { $gt: now } },
    { $inc: { count: 1 } },
    { returnDocument: 'after' }
  )
  if (current) return current.count > max
  await rateLimits.updateOne(
    { key },
    { $set: { count: 1, expiresAt: new Date(now.getTime() + windowMs) } },
    { upsert: true }
  ).catch(() => {})
  return false
}

export async function isBlocked (key, max) {
  const { rateLimits } = await collections()
  const current = await rateLimits.findOne({ key, expiresAt: { $gt: new Date() } })
  return (current?.count || 0) >= max
}

export function limit (name, max, windowMs) {
  return async (req, res, next) => {
    try {
      if (await hit(`${name}:${req.ip}`, max, windowMs)) {
        return res.status(429).json({ error: 'too_many_requests', error_description: 'Too many requests. Try again later.' })
      }
      next()
    } catch (error) {
      next(error)
    }
  }
}
