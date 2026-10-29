const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const multer = require('multer');
const { ObjectId, GridFSBucket } = require('mongodb');
const { hashPassword, verifyPassword, newToken } = require('./auth');
const { seed } = require('./seed');
const mongo = require('./mongo');
const pkg = require('./package.json');

const PORT = Number(process.env.PORT || 3000);
const TIMEZONE = process.env.APP_TIMEZONE || 'UTC';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const PUBLIC_DIR = path.join(__dirname, 'public');

// All app data (users, launches, votes, comments, follows, images) lives in MongoDB Atlas.
let db = null;
let uploads = null; // GridFS bucket holding logos, screenshots and avatars
const C = (name) => db.collection(name);

// ---------- dates ----------
function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date());
}
function shiftDay(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
// Timestamps are stored as UTC "YYYY-MM-DD HH:MM:SS" strings, which sort correctly and the app parses.
const nowTs = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

// ---------- version: changes whenever any file in public/ changes ----------
// Installed apps compare this with the version they loaded and refresh themselves.
let versionCache = { at: 0, value: '' };
function appVersion() {
  if (Date.now() - versionCache.at < 5000) return versionCache.value;
  const h = crypto.createHash('sha256').update(pkg.version);
  for (const f of fs.readdirSync(PUBLIC_DIR).sort()) {
    const p = path.join(PUBLIC_DIR, f);
    if (fs.statSync(p).isFile()) h.update(f).update(fs.readFileSync(p));
  }
  versionCache = { at: Date.now(), value: `${pkg.version}-${h.digest('hex').slice(0, 10)}` };
  return versionCache.value;
}

// ---------- ids ----------
// Launches, users and comments keep short numeric ids (they appear in links like #/p/12).
async function nextId(name) {
  const doc = await C('counters').findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return doc.seq;
}
const isDuplicate = (e) => e?.code === 11000;

// ---------- config (cached briefly: it's read on most requests) ----------
let configCache = { at: 0, value: {} };
async function getConfig() {
  if (Date.now() - configCache.at < 5000) return configCache.value;
  const cfg = {};
  for (const row of await C('app_config').find().toArray()) cfg[row._id] = row.value;
  configCache = { at: Date.now(), value: cfg };
  return cfg;
}
const feature = async (name) => (await getConfig()).features?.[name] !== false;

let topicCache = { at: 0, value: [] };
async function allTopics() {
  if (Date.now() - topicCache.at < 60000) return topicCache.value;
  topicCache = { at: Date.now(), value: await C('topics').find().sort({ name: 1 }).toArray() };
  return topicCache.value;
}

// ---------- daily job: award Top 3 badges once a day is over ----------
async function awardBadges() {
  const done = new Set((await C('badges').aggregate([{ $group: { _id: '$day' } }]).toArray()).map((d) => d._id));
  const days = (await C('products').aggregate([{ $match: { launch_date: { $lt: today() } } }, { $group: { _id: '$launch_date' } }]).toArray())
    .map((d) => d._id).filter((d) => !done.has(d));
  for (const day of days) {
    const top = await C('products').find({ launch_date: day }).sort({ votes_count: -1, _id: 1 }).limit(3).project({ _id: 1 }).toArray();
    if (!top.length) continue;
    await C('badges').insertMany(top.map((p, i) => ({ product_id: p._id, day, rank: i + 1 })), { ordered: false }).catch((e) => {
      if (!isDuplicate(e) && e.name !== 'MongoBulkWriteError') throw e;
    });
  }
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

const fileUrl = (f) => (f ? `/uploads/${f}` : null);

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Async route handlers: errors go to the error handler instead of crashing the server.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please log in first.' }));
const requireAdmin = (req, res, next) =>
  ADMIN_TOKEN && req.get('x-admin-token') === ADMIN_TOKEN ? next() : res.status(403).json({ error: 'Admin token required.' });

async function startSession(res, userId) {
  const token = newToken();
  await C('sessions').insertOne({ _id: token, user_id: userId, created_at: nowTs() });
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 90 });
}

// ---------- products ----------
// votes_count and comments_count are kept on each product so lists can be sorted in the database.
async function shapeProducts(rows, viewerId) {
  if (!rows.length) return [];
  const ids = rows.map((p) => p._id);
  const makerIds = [...new Set(rows.map((p) => p.maker_id).filter((x) => x != null))];
  const [mine, badges, makers, topics] = await Promise.all([
    viewerId ? C('votes').find({ user_id: viewerId, product_id: { $in: ids } }).project({ product_id: 1 }).toArray() : [],
    C('badges').find({ product_id: { $in: ids } }).toArray(),
    makerIds.length ? C('users').find({ _id: { $in: makerIds } }).project({ username: 1, name: 1, avatar: 1, headline: 1 }).toArray() : [],
    allTopics(),
  ]);
  const voted = new Set(mine.map((v) => v.product_id));
  const rank = new Map(badges.map((b) => [b.product_id, b.rank]));
  const makerById = new Map(makers.map((u) => [u._id, u]));
  const topicBySlug = new Map(topics.map((t) => [t.slug, t.name]));
  return rows.map((p) => {
    const m = makerById.get(p.maker_id);
    return {
      id: p._id, name: p.name, tagline: p.tagline, description: p.description || '', url: p.url || '',
      play_store_url: p.play_store_url || '', app_store_url: p.app_store_url || '', logo: fileUrl(p.logo),
      icon: p.icon, color: p.color, launch_date: p.launch_date,
      maker_username: m?.username ?? null, maker_name: m?.name ?? null, maker_avatar: fileUrl(m?.avatar), maker_headline: m?.headline ?? null,
      votes: p.votes_count || 0, comments: p.comments_count || 0, voted: voted.has(p._id),
      topics: (p.topics || []).filter((s) => topicBySlug.has(s)).map((slug) => ({ slug, name: topicBySlug.get(slug) })),
      badge_rank: rank.get(p._id) ?? null,
    };
  });
}

async function listProducts(req, filter, limit = 50) {
  const rows = await C('products')
    .find({ ...filter, launch_date: { ...(filter.launch_date || {}), $lte: today() } })
    .sort({ votes_count: -1, _id: -1 }).limit(Number(limit)).toArray();
  return shapeProducts(rows, req.user?.id);
}

// ---------- uploads (stored in GridFS) ----------
// Images are identified by their bytes, not the name or type the browser claims. SVG is not
// accepted because it can carry scripts.
const IMAGE_SIGNATURES = [
  ['png', (b) => b.length > 8 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG'],
  ['jpg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['gif', (b) => b.toString('ascii', 0, 4) === 'GIF8'],
  ['webp', (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'],
];
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const imageExt = (buf) => IMAGE_SIGNATURES.find(([, ok]) => ok(buf))?.[0];

function saveImage(buffer, ext) {
  const file = `${crypto.randomUUID()}.${ext}`;
  return new Promise((resolve, reject) => {
    uploads.openUploadStream(file, { metadata: { contentType: IMAGE_TYPES[ext] } })
      .on('error', reject).on('finish', () => resolve(file)).end(buffer);
  });
}

async function removeUploads(files) {
  for (const f of files.filter(Boolean)) {
    for (const doc of await uploads.find({ filename: path.basename(f) }).toArray()) await uploads.delete(doc._id).catch(() => {});
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 7, fields: 30 },
}).fields([{ name: 'logo', maxCount: 1 }, { name: 'screenshots', maxCount: 6 }]);

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 20 },
}).single('avatar');

function handleUpload(req, res, next) {
  (req.path.startsWith('/me') ? avatarUpload : upload)(req, res, (err) => {
    if (!err) return next();
    const message = {
      LIMIT_FILE_SIZE: 'Each image must be 5 MB or smaller.',
      LIMIT_UNEXPECTED_FILE: req.path.startsWith('/me') ? 'Upload one profile picture.' : 'You can upload 1 logo and up to 6 screenshots.',
    }[err.code];
    res.status(400).json({ error: message || err.message });
  });
}

function cleanLink(value, label, requiredHost) {
  const s = String(value || '').trim();
  if (!s) return '';
  let host;
  try { host = new URL(s).hostname; } catch { host = null; }
  if (!host || !/^https?:\/\//i.test(s) || s.length > 500) throw new Error(`${label} must be a valid http(s) link.`);
  if (requiredHost && host !== requiredHost) throw new Error(`${label} must be a link on ${requiredHost}.`);
  return s;
}

async function insertProduct(body, makerId, minDay, files = {}) {
  const name = String(body.name || '').trim();
  const tagline = String(body.tagline || '').trim();
  if (!name || name.length > 60) throw new Error('Name is required (max 60 characters).');
  if (!tagline || tagline.length > 90) throw new Error('Tagline is required (max 90 characters).');
  const website = cleanLink(body.url, 'Website');
  const playStore = cleanLink(body.play_store_url, 'Google Play link', 'play.google.com');
  const appStore = cleanLink(body.app_store_url, 'App Store link', 'apps.apple.com');
  if (!website && !playStore && !appStore) throw new Error('Add at least one link: website, Google Play or App Store.');
  const launchDate = isDay(body.launch_date) ? body.launch_date : today();
  if (minDay && launchDate < minDay) throw new Error('Launch date cannot be in the past.');

  const logo = files.logo?.[0];
  const shots = files.screenshots || [];
  for (const f of [logo, ...shots].filter(Boolean)) {
    f.ext = imageExt(f.buffer);
    if (!f.ext) throw new Error(`"${f.originalname}" is not a PNG, JPG, GIF or WebP image.`);
  }

  const topicSlugs = new Set((await allTopics()).map((t) => t.slug));
  const written = [];
  try {
    const logoFile = logo ? await saveImage(logo.buffer, logo.ext) : null;
    if (logoFile) written.push(logoFile);
    const media = [];
    for (const f of shots) { const file = await saveImage(f.buffer, f.ext); written.push(file); media.push(file); }
    const id = await nextId('products');
    await C('products').insertOne({
      _id: id, name, tagline, description: String(body.description || '').slice(0, 2000),
      url: website, play_store_url: playStore, app_store_url: appStore, logo: logoFile, media,
      icon: String(body.icon || name[0].toUpperCase()).slice(0, 4), color: /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : '#ff6154',
      maker_id: makerId, launch_date: launchDate, created_at: nowTs(),
      topics: [...new Set([].concat(body.topics || []).map(String))].filter((s) => topicSlugs.has(s)).slice(0, 3),
      votes_count: 0, comments_count: 0,
    });
    return { id, launch_date: launchDate };
  } catch (e) {
    await removeUploads(written);
    throw e;
  }
}

// ---------- API ----------
const api = express.Router();
api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
// Until the database is reachable, answer clearly instead of failing every request.
api.use((req, res, next) => (db ? next() : res.status(503).json({ error: 'LaunchDay is starting up — the database is not reachable yet. Try again shortly.' })));

api.use(wrap(async (req, res, next) => {
  const token = parseCookies(req).sid;
  req.user = null;
  if (token) {
    const s = await C('sessions').findOne({ _id: token });
    const u = s && await C('users').findOne({ _id: s.user_id }, { projection: { username: 1, name: 1, headline: 1, avatar: 1 } });
    if (u) req.user = { id: u._id, username: u.username, name: u.name, headline: u.headline || '', avatar: fileUrl(u.avatar) };
  }
  next();
}));

api.get('/version', wrap(async (req, res) => {
  const cfg = await getConfig();
  res.json({ version: appVersion(), min_supported_version: cfg.min_supported_version || '0.0.0' });
}));

api.get('/config', wrap(async (req, res) => res.json({ ...(await getConfig()), version: appVersion(), today: today(), timezone: TIMEZONE })));

api.get('/me', (req, res) => res.json({ user: req.user }));

// Usernames appear in profile URLs, so whatever is typed is quietly turned into a URL-safe
// handle ("John Doe" -> "johndoe") instead of being rejected. Only uniqueness is enforced.
const toHandle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
const handleTaken = async (h) => !!(await C('users').findOne({ username: h }, { projection: { _id: 1 } }));

async function suggestHandles(...seeds) {
  const bases = [...new Set(seeds.map(toHandle).filter(Boolean))];
  if (!bases.length) bases.push('maker');
  const rand = (n) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');
  const fit = (base, suffix) => base.slice(0, 20 - suffix.length) + suffix;
  const candidates = [];
  for (let i = 0; i < 15; i++) {
    const base = bases[i % bases.length];
    candidates.push([fit(base, rand(2)), fit(base, `_${rand(3)}`), fit(`the${base}`, ''), fit(base, '_hq'), fit(base, rand(4))][i % 5]);
  }
  const taken = new Set((await C('users').find({ username: { $in: candidates } }).project({ username: 1 }).toArray()).map((u) => u.username));
  return [...new Set(candidates.filter((c) => !taken.has(c)))].slice(0, 3);
}

api.get('/auth/username', wrap(async (req, res) => {
  const username = toHandle(req.query.u);
  const available = !!username && !(await handleTaken(username));
  res.json({ username, available, suggestions: available ? [] : await suggestHandles(username, req.query.name) });
}));

api.post('/auth/register', wrap(async (req, res) => {
  const username = toHandle(req.body.username);
  const name = (String(req.body.name || '').trim() || username).slice(0, 50);
  const password = String(req.body.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!username || await handleTaken(username)) {
    return res.status(409).json({
      error: username ? `@${username} is already taken — pick one of the suggestions.` : 'Pick a username.',
      suggestions: await suggestHandles(username, name),
    });
  }
  const { hash, salt } = hashPassword(password);
  const id = await nextId('users');
  try {
    await C('users').insertOne({ _id: id, username, name, headline: '', bio: '', website: '', twitter: '', avatar: null, password_hash: hash, salt, created_at: nowTs() });
  } catch (e) {
    if (isDuplicate(e)) return res.status(409).json({ error: `@${username} was just taken — pick one of the suggestions.`, suggestions: await suggestHandles(username, name) });
    throw e;
  }
  await startSession(res, id);
  res.status(201).json({ user: { id, username, name, headline: '', avatar: null } });
}));

api.post('/auth/login', wrap(async (req, res) => {
  const user = await C('users').findOne({ username: toHandle(req.body.username) });
  if (!user || !verifyPassword(String(req.body.password || ''), user.salt, user.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  await startSession(res, user._id);
  res.json({ user: { id: user._id, username: user.username, name: user.name, headline: user.headline || '', avatar: fileUrl(user.avatar) } });
}));

api.post('/auth/logout', wrap(async (req, res) => {
  const token = parseCookies(req).sid;
  if (token) await C('sessions').deleteOne({ _id: token });
  res.clearCookie('sid');
  res.json({ ok: true });
}));

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

api.get('/products', wrap(async (req, res) => {
  const { day, topic, q, feed } = req.query;
  if (q) {
    const re = { $regex: escapeRegex(String(q).slice(0, 100)), $options: 'i' };
    return res.json({ products: await listProducts(req, { $or: [{ name: re }, { tagline: re }, { description: re }] }) });
  }
  if (topic) return res.json({ products: await listProducts(req, { topics: String(topic) }) });
  if (feed) {
    if (!req.user) return res.status(401).json({ error: 'Please log in first.' });
    // Last 7 days from followed topics and followed makers.
    const [topics, makers] = await Promise.all([
      C('topic_follows').find({ user_id: req.user.id }).toArray(),
      C('user_follows').find({ follower_id: req.user.id }).toArray(),
    ]);
    return res.json({ products: await listProducts(req, {
      launch_date: { $gte: shiftDay(today(), -7) },
      $or: [{ topics: { $in: topics.map((t) => t.topic) } }, { maker_id: { $in: makers.map((f) => f.followee_id) } }],
    }) });
  }
  const d = isDay(day) ? day : today();
  res.json({ day: d, products: await listProducts(req, { launch_date: { $eq: d } }) });
}));

// Daily digest: the Top 5 of a finished day (yesterday by default).
api.get('/digest', wrap(async (req, res) => {
  if (!(await feature('digest'))) return res.status(404).json({ error: 'Digest is disabled.' });
  const d = isDay(req.query.day) ? req.query.day : shiftDay(today(), -1);
  res.json({ day: d, products: await listProducts(req, { launch_date: { $eq: d } }, 5) });
}));

api.get('/products/:id', wrap(async (req, res) => {
  const me = req.user?.id ?? -1;
  // Scheduled launches stay hidden until their day, except from their maker.
  const row = await C('products').findOne({ _id: Number(req.params.id), $or: [{ launch_date: { $lte: today() } }, { maker_id: me }] });
  if (!row) return res.status(404).json({ error: 'Product not found.' });
  const [[product], comments] = await Promise.all([shapeProducts([row], req.user?.id), C('comments').find({ product_id: row._id }).sort({ _id: 1 }).toArray()]);
  const cids = comments.map((c) => c._id);
  const [authors, counts, mine, makerFollowed] = await Promise.all([
    C('users').find({ _id: { $in: [...new Set(comments.map((c) => c.user_id))] } }).project({ username: 1, name: 1, headline: 1, avatar: 1 }).toArray(),
    C('comment_votes').aggregate([{ $match: { comment_id: { $in: cids } } }, { $group: { _id: '$comment_id', n: { $sum: 1 } } }]).toArray(),
    req.user ? C('comment_votes').find({ user_id: me, comment_id: { $in: cids } }).toArray() : [],
    req.user && row.maker_id != null ? C('user_follows').findOne({ follower_id: me, followee_id: row.maker_id }) : null,
  ]);
  const byId = new Map(authors.map((u) => [u._id, u]));
  const votes = new Map(counts.map((c) => [c._id, c.n]));
  const votedSet = new Set(mine.map((v) => v.comment_id));
  res.json({
    product: { ...product, screenshots: (row.media || []).map(fileUrl), scheduled: row.launch_date > today(), maker_is_following: !!makerFollowed },
    comments: comments.filter((c) => byId.has(c.user_id)).map((c) => {
      const u = byId.get(c.user_id);
      return {
        id: c._id, parent_id: c.parent_id ?? null, body: c.body, created_at: c.created_at, username: u.username, name: u.name,
        headline: u.headline || '', avatar: fileUrl(u.avatar), votes: votes.get(c._id) || 0, voted: votedSet.has(c._id),
        is_maker: c.user_id === row.maker_id,
      };
    }),
  });
}));

api.post('/products', requireUser, wrap(async (req, res, next) => {
  if (!(await feature('submissions'))) return res.status(403).json({ error: 'Submissions are paused.' });
  next();
}), handleUpload, wrap(async (req, res) => {
  try {
    res.status(201).json(await insertProduct(req.body, req.user.id, today(), req.files));
  } catch (e) {
    if (e.name?.startsWith('Mongo')) throw e;
    res.status(400).json({ error: e.message });
  }
}));

async function deleteComments(ids) {
  if (!ids.length) return;
  await Promise.all([C('comments').deleteMany({ _id: { $in: ids } }), C('comment_votes').deleteMany({ comment_id: { $in: ids } })]);
}

api.delete('/products/:id', requireUser, wrap(async (req, res) => {
  const p = await C('products').findOne({ _id: Number(req.params.id) });
  if (!p) return res.status(404).json({ error: 'Product not found.' });
  if (p.maker_id !== req.user.id) return res.status(403).json({ error: 'Only the maker can delete this launch.' });
  const comments = await C('comments').find({ product_id: p._id }).project({ _id: 1 }).toArray();
  await Promise.all([
    C('products').deleteOne({ _id: p._id }),
    C('votes').deleteMany({ product_id: p._id }),
    C('badges').deleteMany({ product_id: p._id }),
    deleteComments(comments.map((c) => c._id)),
  ]);
  await removeUploads([p.logo, ...(p.media || [])]);
  res.json({ ok: true });
}));

api.post('/products/:id/vote', requireUser, wrap(async (req, res) => {
  const pid = Number(req.params.id);
  if (!(await C('products').findOne({ _id: pid, launch_date: { $lte: today() } }, { projection: { _id: 1 } }))) return res.status(404).json({ error: 'Product not found.' });
  const del = await C('votes').deleteOne({ user_id: req.user.id, product_id: pid });
  let voted = false;
  if (!del.deletedCount) {
    try {
      await C('votes').insertOne({ user_id: req.user.id, product_id: pid, created_at: nowTs() });
      voted = true;
    } catch (e) { if (!isDuplicate(e)) throw e; }
  }
  // Recount rather than $inc so a double tap can never drift the total.
  const votes = await C('votes').countDocuments({ product_id: pid });
  await C('products').updateOne({ _id: pid }, { $set: { votes_count: votes } });
  res.json({ voted, votes });
}));

api.post('/products/:id/comments', requireUser, wrap(async (req, res) => {
  if (!(await feature('comments'))) return res.status(403).json({ error: 'Comments are disabled.' });
  const pid = Number(req.params.id);
  const body = String(req.body.body || '').trim();
  if (!body || body.length > 2000) return res.status(400).json({ error: 'Comment must be 1–2000 characters.' });
  if (!(await C('products').findOne({ _id: pid }, { projection: { _id: 1 } }))) return res.status(404).json({ error: 'Product not found.' });
  const parent = req.body.parent_id ? await C('comments').findOne({ _id: Number(req.body.parent_id), product_id: pid }) : null;
  const id = await nextId('comments');
  await C('comments').insertOne({ _id: id, product_id: pid, user_id: req.user.id, parent_id: parent?._id ?? null, body, created_at: nowTs() });
  await C('products').updateOne({ _id: pid }, { $inc: { comments_count: 1 } });
  res.status(201).json({ id });
}));

api.post('/comments/:id/vote', requireUser, wrap(async (req, res) => {
  const cid = Number(req.params.id);
  if (!(await C('comments').findOne({ _id: cid }, { projection: { _id: 1 } }))) return res.status(404).json({ error: 'Comment not found.' });
  const del = await C('comment_votes').deleteOne({ user_id: req.user.id, comment_id: cid });
  if (!del.deletedCount) {
    await C('comment_votes').insertOne({ user_id: req.user.id, comment_id: cid, created_at: nowTs() }).catch((e) => { if (!isDuplicate(e)) throw e; });
  }
  res.json({ voted: !del.deletedCount, votes: await C('comment_votes').countDocuments({ comment_id: cid }) });
}));

api.delete('/comments/:id', requireUser, wrap(async (req, res) => {
  const c = await C('comments').findOne({ _id: Number(req.params.id), user_id: req.user.id });
  if (!c) return res.status(404).json({ error: 'Comment not found.' });
  // Replies go with the comment.
  const ids = [c._id];
  for (let frontier = [c._id]; frontier.length;) {
    frontier = (await C('comments').find({ parent_id: { $in: frontier } }).project({ _id: 1 }).toArray()).map((r) => r._id);
    ids.push(...frontier);
  }
  await deleteComments(ids);
  await C('products').updateOne({ _id: c.product_id }, { $inc: { comments_count: -ids.length } });
  res.json({ ok: true });
}));

api.get('/topics', wrap(async (req, res) => {
  const [topics, products, followers, mine] = await Promise.all([
    allTopics(),
    C('products').aggregate([{ $match: { launch_date: { $lte: today() } } }, { $unwind: '$topics' }, { $group: { _id: '$topics', n: { $sum: 1 } } }]).toArray(),
    C('topic_follows').aggregate([{ $group: { _id: '$topic', n: { $sum: 1 } } }]).toArray(),
    req.user ? C('topic_follows').find({ user_id: req.user.id }).toArray() : [],
  ]);
  const pc = new Map(products.map((r) => [r._id, r.n]));
  const fc = new Map(followers.map((r) => [r._id, r.n]));
  const following = new Set(mine.map((f) => f.topic));
  res.json({ topics: topics.map((t) => ({ slug: t.slug, name: t.name, description: t.description, products: pc.get(t.slug) || 0, followers: fc.get(t.slug) || 0, following: following.has(t.slug) })) });
}));

api.post('/topics/:slug/follow', requireUser, wrap(async (req, res) => {
  const topic = (await allTopics()).find((t) => t.slug === req.params.slug);
  if (!topic) return res.status(404).json({ error: 'Topic not found.' });
  const del = await C('topic_follows').deleteOne({ user_id: req.user.id, topic: topic.slug });
  if (!del.deletedCount) await C('topic_follows').insertOne({ user_id: req.user.id, topic: topic.slug }).catch((e) => { if (!isDuplicate(e)) throw e; });
  res.json({ following: !del.deletedCount });
}));

// ---------- people: profiles, following, profile editing, notifications ----------
// Compact user cards, as used in follower lists, suggestions and search.
async function userCards(req, users) {
  if (!users.length) return [];
  const ids = users.map((u) => u._id);
  const [counts, mine] = await Promise.all([
    C('user_follows').aggregate([{ $match: { followee_id: { $in: ids } } }, { $group: { _id: '$followee_id', n: { $sum: 1 } } }]).toArray(),
    req.user ? C('user_follows').find({ follower_id: req.user.id, followee_id: { $in: ids } }).toArray() : [],
  ]);
  const fc = new Map(counts.map((c) => [c._id, c.n]));
  const following = new Set(mine.map((f) => f.followee_id));
  return users.map((u) => ({
    username: u.username, name: u.name, headline: u.headline || '', avatar: fileUrl(u.avatar),
    followers: fc.get(u._id) || 0, is_following: following.has(u._id),
  }));
}
const CARD_FIELDS = { username: 1, name: 1, headline: 1, avatar: 1 };

api.get('/users', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q) {
    const re = { $regex: escapeRegex(q), $options: 'i' };
    const cards = await userCards(req, await C('users').find({ $or: [{ username: re }, { name: re }, { headline: re }] }).project(CARD_FIELDS).limit(50).toArray());
    return res.json({ users: cards.sort((a, b) => b.followers - a.followers).slice(0, 20) });
  }
  // "Who to follow": active makers the viewer doesn't follow yet.
  const me = req.user?.id ?? -1;
  const followed = req.user ? (await C('user_follows').find({ follower_id: me }).toArray()).map((f) => f.followee_id) : [];
  const candidates = await C('users').find({ _id: { $nin: [me, ...followed] } }).project(CARD_FIELDS).sort({ _id: -1 }).limit(200).toArray();
  const made = new Map((await C('products').aggregate([
    { $match: { maker_id: { $in: candidates.map((u) => u._id) } } }, { $group: { _id: '$maker_id', n: { $sum: 1 } } },
  ]).toArray()).map((r) => [r._id, r.n]));
  const cards = await userCards(req, candidates);
  const score = (c, i) => (made.get(candidates[i]._id) || 0) * 5 + c.followers;
  const ranked = cards.map((c, i) => [c, score(c, i), i]).sort((a, b) => b[1] - a[1] || a[2] - b[2]).map(([c]) => c);
  res.json({ users: ranked.slice(0, Math.min(Number(req.query.limit) || 5, 20)) });
}));

api.get('/users/:username', wrap(async (req, res) => {
  const user = await C('users').findOne({ username: req.params.username });
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const me = req.user?.id ?? -1;
  const isMe = me === user._id;
  const [followers, following, upvotes, comments, isFollowing, followsYou, topicFollows, made, scheduledRows, votes] = await Promise.all([
    C('user_follows').countDocuments({ followee_id: user._id }),
    C('user_follows').countDocuments({ follower_id: user._id }),
    C('votes').countDocuments({ user_id: user._id }),
    C('comments').countDocuments({ user_id: user._id }),
    req.user ? C('user_follows').findOne({ follower_id: me, followee_id: user._id }) : null,
    req.user ? C('user_follows').findOne({ follower_id: user._id, followee_id: me }) : null,
    C('topic_follows').find({ user_id: user._id }).toArray(),
    listProducts(req, { maker_id: user._id }),
    isMe ? C('products').find({ maker_id: user._id, launch_date: { $gt: today() } }).sort({ launch_date: 1 }).toArray() : [],
    C('votes').find({ user_id: user._id }).sort({ created_at: -1 }).limit(20).toArray(),
  ]);
  const followedSlugs = new Set(topicFollows.map((f) => f.topic));
  res.json({
    user: {
      username: user.username, name: user.name, headline: user.headline || '', bio: user.bio || '', website: user.website || '',
      twitter: user.twitter || '', avatar: fileUrl(user.avatar), created_at: user.created_at,
      followers, following, upvotes, comments, is_following: !!isFollowing, follows_you: !!followsYou, is_me: isMe,
    },
    topics: (await allTopics()).filter((t) => followedSlugs.has(t.slug)).map((t) => ({ slug: t.slug, name: t.name })),
    made,
    scheduled: await shapeProducts(scheduledRows, req.user?.id),
    upvoted: await listProducts(req, { _id: { $in: votes.map((v) => v.product_id) } }, 20),
  });
}));

api.post('/users/:username/follow', requireUser, wrap(async (req, res) => {
  const target = await C('users').findOne({ username: req.params.username }, { projection: { _id: 1 } });
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target._id === req.user.id) return res.status(400).json({ error: "You can't follow yourself." });
  const del = await C('user_follows').deleteOne({ follower_id: req.user.id, followee_id: target._id });
  if (!del.deletedCount) {
    await C('user_follows').insertOne({ follower_id: req.user.id, followee_id: target._id, created_at: nowTs() }).catch((e) => { if (!isDuplicate(e)) throw e; });
  }
  res.json({ following: !del.deletedCount, followers: await C('user_follows').countDocuments({ followee_id: target._id }) });
}));

for (const [route, col, other] of [['followers', 'followee_id', 'follower_id'], ['following', 'follower_id', 'followee_id']]) {
  api.get(`/users/:username/${route}`, wrap(async (req, res) => {
    const user = await C('users').findOne({ username: req.params.username }, { projection: { username: 1, name: 1 } });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const links = await C('user_follows').find({ [col]: user._id }).sort({ created_at: -1 }).limit(500).toArray();
    const ids = links.map((f) => f[other]);
    const byId = new Map((await C('users').find({ _id: { $in: ids } }).project(CARD_FIELDS).toArray()).map((u) => [u._id, u]));
    res.json({ user: { username: user.username, name: user.name }, users: await userCards(req, ids.map((id) => byId.get(id)).filter(Boolean)) });
  }));
}

const cleanTwitter = (s) => String(s || '').trim().replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//i, '').replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 15);

api.put('/me', requireUser, handleUpload, wrap(async (req, res) => {
  const b = req.body;
  const current = await C('users').findOne({ _id: req.user.id });
  let website;
  try {
    website = cleanLink(b.website, 'Website');
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const name = String(b.name ?? current.name).trim().slice(0, 50);
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const username = b.username === undefined ? current.username : toHandle(b.username);
  if (username !== current.username && (!username || await handleTaken(username))) {
    return res.status(409).json({ error: username ? `@${username} is already taken.` : 'Pick a username.', suggestions: await suggestHandles(username, name) });
  }
  let avatarFile = current.avatar || null;
  if (req.file) {
    const ext = imageExt(req.file.buffer);
    if (!ext) return res.status(400).json({ error: 'Profile picture must be a PNG, JPG, GIF or WebP image.' });
    avatarFile = await saveImage(req.file.buffer, ext);
  } else if (b.remove_avatar === '1') {
    avatarFile = null;
  }
  try {
    await C('users').updateOne({ _id: req.user.id }, { $set: {
      name, username, headline: String(b.headline ?? current.headline ?? '').trim().slice(0, 80),
      bio: String(b.bio ?? current.bio ?? '').trim().slice(0, 500), website, twitter: cleanTwitter(b.twitter ?? current.twitter), avatar: avatarFile,
    } });
  } catch (e) {
    if (req.file) await removeUploads([avatarFile]);
    if (isDuplicate(e)) return res.status(409).json({ error: `@${username} was just taken.`, suggestions: await suggestHandles(username, name) });
    throw e;
  }
  if (avatarFile !== current.avatar) await removeUploads([current.avatar]);
  const saved = await C('users').findOne({ _id: req.user.id }, { projection: { username: 1, name: 1, headline: 1, avatar: 1 } });
  res.json({ user: { id: saved._id, username: saved.username, name: saved.name, headline: saved.headline || '', avatar: fileUrl(saved.avatar) } });
}));

// Notifications are derived from activity on the viewer's launches, comments and profile.
api.get('/notifications', requireUser, wrap(async (req, res) => {
  const me = req.user.id;
  const [myProducts, myComments, user] = await Promise.all([
    C('products').find({ maker_id: me }).project({ name: 1 }).toArray(),
    C('comments').find({ user_id: me }).project({ _id: 1 }).toArray(),
    C('users').findOne({ _id: me }, { projection: { notifications_seen_at: 1 } }),
  ]);
  const productName = new Map(myProducts.map((p) => [p._id, p.name]));
  const pids = myProducts.map((p) => p._id);
  const myCommentIds = myComments.map((c) => c._id);
  const [follows, votes, onMine, replies] = await Promise.all([
    C('user_follows').find({ followee_id: me }).sort({ created_at: -1 }).limit(60).toArray(),
    C('votes').find({ product_id: { $in: pids }, user_id: { $ne: me } }).sort({ created_at: -1 }).limit(60).toArray(),
    C('comments').find({ product_id: { $in: pids }, user_id: { $ne: me } }).sort({ _id: -1 }).limit(60).toArray(),
    C('comments').find({ parent_id: { $in: myCommentIds }, user_id: { $ne: me } }).sort({ _id: -1 }).limit(60).toArray(),
  ]);
  const replyIds = new Set(replies.map((c) => c._id));
  const replyProducts = await C('products').find({ _id: { $in: [...new Set(replies.map((c) => c.product_id))] } }).project({ name: 1 }).toArray();
  for (const p of replyProducts) productName.set(p._id, p.name);
  const items = [
    ...follows.map((f) => ({ type: 'follow', at: f.created_at, user_id: f.follower_id, product_id: null, text: null })),
    ...votes.map((v) => ({ type: 'upvote', at: v.created_at, user_id: v.user_id, product_id: v.product_id, text: null })),
    // A reply to you on your own launch shows once, as a reply.
    ...onMine.filter((c) => !replyIds.has(c._id)).map((c) => ({ type: 'comment', at: c.created_at, user_id: c.user_id, product_id: c.product_id, text: c.body.slice(0, 140) })),
    ...replies.map((c) => ({ type: 'reply', at: c.created_at, user_id: c.user_id, product_id: c.product_id, text: c.body.slice(0, 140) })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 60);
  const people = new Map((await C('users').find({ _id: { $in: [...new Set(items.map((n) => n.user_id))] } }).project(CARD_FIELDS).toArray()).map((u) => [u._id, u]));
  const seen = user?.notifications_seen_at || '';
  const notifications = items.filter((n) => people.has(n.user_id)).map(({ user_id, ...n }) => {
    const u = people.get(user_id);
    return { ...n, username: u.username, name: u.name, avatar: fileUrl(u.avatar), product_name: n.product_id ? productName.get(n.product_id) ?? null : null, unread: n.at > seen };
  });
  if (req.query.peek !== '1') await C('users').updateOne({ _id: me }, { $set: { notifications_seen_at: nowTs() } });
  res.json({ notifications, unread: notifications.filter((n) => n.unread).length });
}));

// ---------- admin: daily operations without shipping an app update ----------
// Change any config key (banner, home_sections, features, theme, min_supported_version).
api.put('/admin/config/:key', requireAdmin, wrap(async (req, res) => {
  if (!('value' in req.body)) return res.status(400).json({ error: 'Body must be {"value": ...}.' });
  await C('app_config').updateOne({ _id: req.params.key }, { $set: { value: req.body.value } }, { upsert: true });
  configCache.at = 0;
  res.json({ ok: true, config: await getConfig() });
}));

// Schedule launches for any day (they appear automatically when that day starts).
api.post('/admin/products', requireAdmin, wrap(async (req, res) => {
  try {
    res.status(201).json(await insertProduct(req.body, null, null));
  } catch (e) {
    if (e.name?.startsWith('Mongo')) throw e;
    res.status(400).json({ error: e.message });
  }
}));

// ---------- MongoDB Atlas (founder_marketplace) ----------
const mongoApi = express.Router();
mongoApi.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Simple per-IP limit: 120 requests a minute.
const hits = new Map();
setInterval(() => hits.clear(), 60 * 1000).unref();
mongoApi.use((req, res, next) => {
  const n = (hits.get(req.ip) || 0) + 1;
  hits.set(req.ip, n);
  if (n > 120) return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  next();
});

mongoApi.get('/health', async (req, res) => {
  if (!mongo.isConfigured()) return res.status(503).json({ status: 'error', db: 'not_configured' });
  try {
    res.json({ status: 'ok', db: 'up', latencyMs: await mongo.ping() });
  } catch (e) {
    console.error('MongoDB health check failed:', e.message);
    res.status(503).json({ status: 'error', db: 'down' });
  }
});

// Public startup listings. Only these fields ever leave the server.
const STARTUP_FIELDS = {
  name: 1, tagline: 1, description: 1, category: 1, stage: 1, logo: 1, website: 1, location: 1, createdAt: 1,
};
const HIDDEN_STATUSES = ['draft', 'hidden', 'removed', 'banned', 'deleted'];
// Query values must be plain short strings; arrays/objects (e.g. ?category[$ne]=x) are rejected.
const queryString = (v, max) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);

mongoApi.get('/startups', async (req, res) => {
  for (const [k, v] of Object.entries(req.query)) {
    if (typeof v !== 'string') return res.status(400).json({ error: `Invalid "${k}" parameter.` });
  }
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 50);
  const filter = { status: { $nin: HIDDEN_STATUSES } };
  const category = queryString(req.query.category, 50);
  const stage = queryString(req.query.stage, 50);
  const q = queryString(req.query.q, 60);
  if (category) filter.category = category;
  if (stage) filter.stage = stage;
  if (q) filter.name = { $regex: escapeRegex(q), $options: 'i' };
  if (req.query.cursor) {
    if (!/^[0-9a-f]{24}$/i.test(req.query.cursor)) return res.status(400).json({ error: 'Invalid cursor.' });
    filter._id = { $lt: ObjectId.createFromHexString(req.query.cursor) };
  }
  try {
    const docs = await mongo.withDb((mdb) => mdb.collection('startups')
      .find(filter, { projection: STARTUP_FIELDS }).sort({ _id: -1 }).limit(limit + 1).toArray());
    const more = docs.length > limit;
    const startups = docs.slice(0, limit).map(({ _id, ...rest }) => ({ id: _id.toHexString(), ...rest }));
    res.json({ startups, nextCursor: more ? startups.at(-1).id : null });
  } catch (e) {
    console.error('GET /api/startups failed:', e.message);
    res.status(503).json({ error: 'Listings are unavailable right now.' });
  }
});

app.use('/api', mongoApi);
app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use('/api', (err, req, res, next) => {
  console.error(`${req.method} ${req.originalUrl} failed:`, err.message);
  res.status(503).json({ error: 'Something went wrong talking to the database. Please try again.' });
});

// ---------- web app ----------
// HTML and the service worker carry the current version and are never cached by the browser,
// so a deploy reaches every installed app on its next open.
function sendWithVersion(file, type) {
  return (req, res) => {
    const body = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8').replaceAll('__APP_VERSION__', appVersion());
    res.set({ 'Content-Type': type, 'Cache-Control': 'no-cache' }).send(body);
  };
}
// Uploaded images get random, never-reused names, so they can be cached forever.
app.get('/uploads/:file', wrap(async (req, res) => {
  const file = path.basename(req.params.file);
  const ext = file.split('.').pop();
  if (!uploads || !IMAGE_TYPES[ext]) return res.status(404).end();
  const [doc] = await uploads.find({ filename: file }).limit(1).toArray();
  if (!doc) return res.status(404).end();
  res.set({ 'Content-Type': IMAGE_TYPES[ext], 'Content-Length': doc.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=31536000, immutable' });
  uploads.openDownloadStream(doc._id).on('error', () => res.destroy()).pipe(res);
}));
app.get('/sw.js', sendWithVersion('sw.js', 'text/javascript; charset=utf-8'));
app.get(['/', '/index.html'], sendWithVersion('index.html', 'text/html; charset=utf-8'));
app.use(express.static(PUBLIC_DIR, { index: false, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

// ---------- start ----------
// The web server starts right away; the API waits for Atlas and keeps retrying until it connects.
async function connect() {
  try {
    const appDb = await mongo.appDb();
    await seed(appDb);
    uploads = new GridFSBucket(appDb, { bucketName: 'uploads' });
    db = appDb;
    console.log(`Connected to MongoDB Atlas (database "${mongo.APP_DB_NAME}").`);
    await awardBadges();
    setInterval(() => awardBadges().catch((e) => console.error('Badge job failed:', e.message)), 60 * 1000).unref();
  } catch (e) {
    console.error(`Can't reach MongoDB yet (${e.message.split('\n')[0]}). Retrying in 10s…`);
    setTimeout(connect, 10000);
  }
}

app.listen(PORT, () => {
  console.log(`LaunchDay running at http://localhost:${PORT}  (version ${appVersion()}, timezone ${TIMEZONE})`);
  if (!ADMIN_TOKEN) console.log('Admin API disabled: set ADMIN_TOKEN to enable /api/admin/*');
  if (!mongo.isConfigured()) console.log('MONGODB_URI is not set: add your Atlas connection string to .env — LaunchDay stores all its data there.');
  else connect();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => mongo.closeMongo().finally(() => process.exit(0)));
}
