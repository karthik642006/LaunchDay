// One-time copy of the old SQLite data (launchday.db + uploads/) into MongoDB Atlas.
// Usage: node --env-file=.env migrate-sqlite.js        (refuses if Atlas already has users)
//        node --env-file=.env migrate-sqlite.js --force (replaces LaunchDay's data in Atlas)
// The SQLite file and uploads folder are left untouched as a backup.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { GridFSBucket } = require('mongodb');
const mongo = require('./mongo');
const { seed } = require('./seed');

const SQLITE = process.env.DB_PATH || path.join(__dirname, 'launchday.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const COLLECTIONS = ['users', 'sessions', 'products', 'votes', 'comments', 'comment_votes', 'topic_follows', 'user_follows', 'badges', 'counters', 'uploads.files', 'uploads.chunks'];
const TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

async function main() {
  if (!fs.existsSync(SQLITE)) throw new Error(`No SQLite database at ${SQLITE}.`);
  const lite = new DatabaseSync(SQLITE, { readOnly: true });
  const all = (sql) => { try { return lite.prepare(sql).all(); } catch { return []; } }; // older files may lack newer tables
  const db = await mongo.appDb();

  if (await db.collection('users').estimatedDocumentCount()) {
    if (!process.argv.includes('--force')) throw new Error(`Atlas database "${mongo.APP_DB_NAME}" already has users. Re-run with --force to replace them.`);
    for (const c of COLLECTIONS) await db.collection(c).drop().catch(() => {});
  }
  await seed(db);

  const users = all('SELECT * FROM users');
  const products = all('SELECT * FROM products');
  const media = all('SELECT * FROM product_media ORDER BY position');
  const productTopics = all('SELECT pt.product_id, t.slug FROM product_topics pt JOIN topics t ON t.id = pt.topic_id');
  const votes = all('SELECT * FROM votes');
  const comments = all('SELECT * FROM comments');
  const topicSlug = new Map(all('SELECT id, slug FROM topics').map((t) => [t.id, t.slug]));

  const ins = (name, docs) => (docs.length ? db.collection(name).insertMany(docs, { ordered: false }) : null);
  await ins('users', users.map((u) => ({
    _id: u.id, username: u.username, name: u.name, headline: u.headline || '', bio: u.bio || '', website: u.website || '',
    twitter: u.twitter || '', avatar: u.avatar || null, password_hash: u.password_hash, salt: u.salt,
    created_at: u.created_at, notifications_seen_at: u.notifications_seen_at || null,
  })));
  await ins('sessions', all('SELECT * FROM sessions').map((s) => ({ _id: s.token, user_id: s.user_id, created_at: s.created_at })));
  await ins('products', products.map((p) => ({
    _id: p.id, name: p.name, tagline: p.tagline, description: p.description || '', url: p.url || '',
    play_store_url: p.play_store_url || '', app_store_url: p.app_store_url || '', logo: p.logo || null,
    media: media.filter((m) => m.product_id === p.id).map((m) => m.file),
    icon: p.icon, color: p.color, maker_id: p.maker_id, launch_date: p.launch_date, created_at: p.created_at,
    topics: productTopics.filter((t) => t.product_id === p.id).map((t) => t.slug),
    votes_count: votes.filter((v) => v.product_id === p.id).length,
    comments_count: comments.filter((c) => c.product_id === p.id).length,
  })));
  await ins('votes', votes.map((v) => ({ user_id: v.user_id, product_id: v.product_id, created_at: v.created_at })));
  await ins('comments', comments.map((c) => ({ _id: c.id, product_id: c.product_id, user_id: c.user_id, parent_id: c.parent_id ?? null, body: c.body, created_at: c.created_at })));
  await ins('comment_votes', all('SELECT * FROM comment_votes').map((v) => ({ user_id: v.user_id, comment_id: v.comment_id, created_at: v.created_at })));
  await ins('topic_follows', all('SELECT * FROM follows').filter((f) => topicSlug.has(f.topic_id)).map((f) => ({ user_id: f.user_id, topic: topicSlug.get(f.topic_id) })));
  await ins('user_follows', all('SELECT * FROM user_follows').map((f) => ({ follower_id: f.follower_id, followee_id: f.followee_id, created_at: f.created_at })));
  await ins('badges', all('SELECT * FROM badges').map((b) => ({ product_id: b.product_id, day: b.day, rank: b.rank })));

  // New records continue numbering after the copied ones.
  const maxId = (rows) => rows.reduce((m, r) => Math.max(m, r.id), 0);
  for (const [name, rows] of [['users', users], ['products', products], ['comments', comments]]) {
    await db.collection('counters').updateOne({ _id: name }, { $max: { seq: maxId(rows) } }, { upsert: true });
  }

  // Images referenced by users and products move into GridFS under the same file names.
  const bucket = new GridFSBucket(db, { bucketName: 'uploads' });
  const files = [...new Set([...users.map((u) => u.avatar), ...products.map((p) => p.logo), ...media.map((m) => m.file)].filter(Boolean))];
  let copied = 0;
  for (const file of files) {
    const src = path.join(UPLOAD_DIR, path.basename(file));
    if (!fs.existsSync(src)) { console.warn(`  missing image ${file} — skipped`); continue; }
    await new Promise((resolve, reject) => {
      fs.createReadStream(src).pipe(bucket.openUploadStream(file, { metadata: { contentType: TYPES[file.split('.').pop()] } }))
        .on('error', reject).on('finish', resolve);
    });
    copied++;
  }

  console.log(`Copied to Atlas database "${mongo.APP_DB_NAME}": ${users.length} users, ${products.length} launches, ${votes.length} votes, ${comments.length} comments, ${copied} images.`);
}

main()
  .catch((e) => { console.error('Migration failed:', e.message); process.exitCode = 1; })
  .finally(() => mongo.closeMongo());
