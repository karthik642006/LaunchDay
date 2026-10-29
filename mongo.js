// MongoDB Atlas connection (official driver). One client is shared by the whole server.
const { MongoClient, ServerApiVersion } = require('mongodb');

const URI = (process.env.MONGODB_URI || '').trim();
const DB_NAME = process.env.MONGODB_DB || 'founder_marketplace';
// LaunchDay's own data lives in a separate database so it never collides with the marketplace data.
const APP_DB_NAME = process.env.LAUNCHDAY_DB || 'launchday';

let client = null;

function getClient() {
  if (!URI) throw new Error('MONGODB_URI is not set (add it to .env).');
  if (!client) {
    client = new MongoClient(URI, {
      serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
      maxPoolSize: 20,
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 10000,
      appName: 'launchday',
    });
  }
  return client;
}

// Runs fn(db). The driver connects lazily and reconnects on its own, but a failed first
// connection leaves the client closed, so drop it and start fresh on the next request.
async function withDb(fn, name = DB_NAME) {
  const c = getClient();
  try {
    return await fn(c.db(name));
  } catch (e) {
    if (e.name === 'MongoServerSelectionError' || e.name === 'MongoTopologyClosedError' || e.code === 18) {
      if (client === c) client = null;
      c.close().catch(() => {});
    }
    throw e;
  }
}

// Connects (or reuses the connection) and returns LaunchDay's database.
async function appDb() {
  return withDb(async (db) => {
    await db.command({ ping: 1 });
    return db;
  }, APP_DB_NAME);
}

async function ping() {
  const started = Date.now();
  await withDb((db) => db.command({ ping: 1 }));
  return Date.now() - started;
}

async function closeMongo() {
  if (client) await client.close();
  client = null;
}

module.exports = { withDb, appDb, ping, closeMongo, isConfigured: () => !!URI, APP_DB_NAME };
