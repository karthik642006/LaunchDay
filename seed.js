// Creates the starter topics and default app config on first run. No demo users or products.
const TOPICS = [
  ['ai', 'Artificial Intelligence', 'Tools powered by machine learning and LLMs'],
  ['productivity', 'Productivity', 'Get more done with less effort'],
  ['developer-tools', 'Developer Tools', 'Build, ship and debug faster'],
  ['design', 'Design Tools', 'Create beautiful things'],
  ['marketing', 'Marketing', 'Grow your audience'],
  ['fintech', 'Fintech', 'Money, payments and finance'],
  ['health', 'Health & Fitness', 'Feel better every day'],
  ['education', 'Education', 'Learn something new'],
  ['games', 'Games', 'Play something new'],
  ['social', 'Social', 'Connect with people'],
  ['ecommerce', 'E-Commerce', 'Sell and shop online'],
  ['utilities', 'Utilities', 'Handy everyday tools'],
];

const DEFAULT_CONFIG = {
  // Home screen layout, in order. Reorder, add or remove sections without shipping a new app.
  home_sections: ['banner', 'today', 'yesterday', 'topics'],
  banner: { text: 'Built something? Launch your app or website today and get discovered.', link: '#/submit', style: 'info' },
  features: { comments: true, digest: true, personalized_feed: true, submissions: true },
  theme: { accent: '#ff6154' },
  min_supported_version: '1.0.0',
};

// Indexes double as constraints: unique usernames, one vote per user per product, etc.
async function ensureIndexes(db) {
  const idx = (name, specs) => db.collection(name).createIndexes(specs);
  await Promise.all([
    idx('users', [{ key: { username: 1 }, unique: true }]),
    idx('sessions', [{ key: { user_id: 1 } }]),
    idx('topics', [{ key: { slug: 1 }, unique: true }]),
    idx('products', [{ key: { launch_date: 1, votes_count: -1 } }, { key: { maker_id: 1 } }, { key: { topics: 1 } }]),
    idx('votes', [{ key: { user_id: 1, product_id: 1 }, unique: true }, { key: { product_id: 1 } }]),
    idx('comments', [{ key: { product_id: 1 } }, { key: { user_id: 1 } }, { key: { parent_id: 1 } }]),
    idx('comment_votes', [{ key: { user_id: 1, comment_id: 1 }, unique: true }, { key: { comment_id: 1 } }]),
    idx('topic_follows', [{ key: { user_id: 1, topic: 1 }, unique: true }, { key: { topic: 1 } }]),
    idx('user_follows', [{ key: { follower_id: 1, followee_id: 1 }, unique: true }, { key: { followee_id: 1 } }]),
    idx('badges', [{ key: { day: 1, rank: 1 }, unique: true }, { key: { product_id: 1 } }]),
  ]);
}

async function seed(db) {
  await ensureIndexes(db);
  await db.collection('topics').bulkWrite(TOPICS.map(([slug, name, description]) => ({
    updateOne: { filter: { slug }, update: { $setOnInsert: { slug, name, description } }, upsert: true },
  })));
  await db.collection('app_config').bulkWrite(Object.entries(DEFAULT_CONFIG).map(([key, value]) => ({
    updateOne: { filter: { _id: key }, update: { $setOnInsert: { value } }, upsert: true },
  })));
}

module.exports = { seed, TOPICS, DEFAULT_CONFIG };
