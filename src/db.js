import { MongoClient } from 'mongodb'
import { config } from './config.js'

let ready = null

// Serverless instances are reused, so the connection and indexes are set up once.
async function connect () {
  const client = await new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 5000 }).connect()
  const db = client.db(config.mongoDb)
  const collections = {
    clients: db.collection('oauth_clients'),
    codes: db.collection('oauth_codes'),
    tokens: db.collection('oauth_tokens')
  }
  await Promise.all([
    collections.clients.createIndex({ client_id: 1 }, { unique: true }),
    collections.codes.createIndex({ hash: 1 }, { unique: true }),
    collections.codes.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    collections.tokens.createIndex({ hash: 1 }, { unique: true }),
    collections.tokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
  ])
  return collections
}

export function collections () {
  if (!ready) {
    ready = connect().catch(error => {
      ready = null
      throw error
    })
  }
  return ready
}
