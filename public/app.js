'use strict';

const state = { config: null, me: null, unread: 0 };
const $view = document.getElementById('view');

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, { method = 'GET', body } = {}) {
  const isForm = body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body && !isForm ? { 'Content-Type': 'application/json' } : {},
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

let toastTimer;
function toast(msg, ms = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (el.hidden = true), ms);
  return el;
}

function fmtDay(day) {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}
function shiftDay(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// SQLite timestamps are UTC "YYYY-MM-DD HH:MM:SS".
function ago(ts) {
  const s = (Date.now() - new Date(`${String(ts).replace(' ', 'T')}Z`)) / 1000;
  if (s < 60) return 'just now';
  for (const [unit, sec] of [['y', 31536000], ['mo', 2592000], ['d', 86400], ['h', 3600], ['m', 60]]) {
    if (s >= sec) return `${Math.floor(s / sec)}${unit} ago`;
  }
}
const joined = (ts) => new Date(`${String(ts).replace(' ', 'T')}Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const feature = (name) => state.config?.features?.[name] !== false;
const medal = (rank) => (rank ? `<span class="badge rank-${rank}">#${rank} Product of the Day</span>` : '');

function requireLogin() {
  if (state.me) return true;
  location.hash = `#/login?next=${encodeURIComponent(location.hash)}`;
  return false;
}

// ---------- icons (stroke icons, 24px grid) ----------
const ICONS = {
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  up: '<path d="M12 5 4 17h16z"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20"/>',
  phone: '<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  reply: '<path d="M9 17 4 12l5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  x: '<path d="M4 4l16 16M20 4 4 20"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
};
const icon = (name, size = 18) => `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

// ---------- shared components ----------
const AVATAR_COLORS = ['#ff6154', '#6c5ce7', '#00a884', '#0984e3', '#e17055', '#d63384', '#2d3436', '#f39c12'];
function avatar(u, size = 40) {
  const name = u?.name || u?.username || '?';
  if (u?.avatar) return `<img class="avatar" src="${esc(u.avatar)}" alt="" width="${size}" height="${size}" style="width:${size}px;height:${size}px" loading="lazy">`;
  const hash = [...(u?.username || name)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const initials = name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px;background:${AVATAR_COLORS[hash % AVATAR_COLORS.length]}">${esc(initials)}</span>`;
}

const thumb = (p, size = 64) => p.logo
  ? `<img class="thumb" src="${esc(p.logo)}" alt="" width="${size}" height="${size}" style="width:${size}px;height:${size}px" loading="lazy">`
  : `<span class="thumb" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px;background:${esc(p.color)}">${esc(p.icon)}</span>`;

const topicLinks = (p) => p.topics.map((t) => `<a class="topic-link" href="#/t/${esc(t.slug)}">${esc(t.name)}</a>`).join('<span class="dot">•</span>');

const voteBox = (p) => `
  <button class="vote ${p.voted ? 'on' : ''}" data-vote="${p.id}" aria-pressed="${p.voted}" aria-label="Upvote ${esc(p.name)}">
    ${icon('up', 16)}<b>${p.votes}</b>
  </button>`;

function productRow(p, rank) {
  return `
    <article class="product-row">
      <a class="row-link" href="#/p/${p.id}" aria-label="${esc(p.name)}"></a>
      ${thumb(p, 56)}
      <div class="row-info">
        <div class="row-title">${rank ? `<span class="rank">${rank}.</span> ` : ''}<span class="row-name">${esc(p.name)}</span></div>
        <p class="row-tagline">${esc(p.tagline)}</p>
        <div class="row-meta">
          ${p.topics.length ? `${icon('tag', 14)}${topicLinks(p)}` : ''}
          ${p.badge_rank ? `${p.topics.length ? '<span class="dot">•</span>' : ''}${medal(p.badge_rank)}` : ''}
        </div>
      </div>
      ${p.scheduled || p.launch_date > state.config.today ? `<span class="pill">${icon('calendar', 14)} ${esc(fmtDay(p.launch_date))}</span>` : `
        <div class="row-actions">
          ${feature('comments') ? `<a class="cbox hide-sm" href="#/p/${p.id}" aria-label="${plural(p.comments, 'comment')}">${icon('comment', 16)}<b>${p.comments}</b></a>` : ''}
          ${voteBox(p)}
        </div>`}
    </article>`;
}

const productList = (products, ranked = true, empty = 'Nothing here yet.') =>
  products.length ? `<div class="list">${products.map((p, i) => productRow(p, ranked ? i + 1 : null)).join('')}</div>` : emptyState(empty);

const emptyState = (text, action = '') => `<div class="empty">${icon('rocket', 28)}<p>${text}</p>${action}</div>`;

function followButton(u, small = false) {
  if (state.me?.username === u.username) return '';
  return `<button class="btn ${u.is_following ? 'secondary following' : 'primary'} ${small ? 'sm' : ''}" data-follow-user="${esc(u.username)}" aria-pressed="${!!u.is_following}">
    <span>${u.is_following ? 'Following' : 'Follow'}</span></button>`;
}

function userRow(u) {
  return `
    <div class="user-row">
      <a href="#/u/${esc(u.username)}">${avatar(u, 44)}</a>
      <a class="user-row-info" href="#/u/${esc(u.username)}">
        <b>${esc(u.name)}</b>
        <span class="muted">${u.headline ? esc(u.headline) : `@${esc(u.username)}`}</span>
      </a>
      ${followButton(u, true)}
    </div>`;
}

const sideCard = (title, body, link = '') => `<section class="side-card"><div class="side-head"><h3>${title}</h3>${link}</div>${body}</section>`;

// ---------- header ----------
function renderNav() {
  const me = state.me;
  document.getElementById('nav').innerHTML = me
    ? `
      <a class="icon-btn" href="#/notifications" aria-label="Notifications">${icon('bell', 20)}${state.unread ? `<span class="dot-badge">${state.unread > 9 ? '9+' : state.unread}</span>` : ''}</a>
      <a href="#/submit" class="btn primary sm hide-sm">Submit</a>
      <div class="menu-wrap">
        <button class="avatar-btn" id="menu-btn" aria-haspopup="menu" aria-expanded="false" aria-label="Account menu">${avatar(me, 34)}</button>
        <div class="menu" id="menu" role="menu" hidden>
          <a class="menu-head" href="#/u/${esc(me.username)}" role="menuitem">${avatar(me, 36)}<span><b>${esc(me.name)}</b><span class="muted">@${esc(me.username)}</span></span></a>
          <a href="#/u/${esc(me.username)}" role="menuitem">${icon('user')} Profile</a>
          <a href="#/settings" role="menuitem">${icon('edit')} Edit profile</a>
          <a href="#/submit" role="menuitem">${icon('rocket')} Submit a launch</a>
          <button id="logout" role="menuitem">${icon('logout')} Log out</button>
        </div>
      </div>`
    : `<a href="#/login" class="btn ghost sm">Log in</a><a href="#/register" class="btn primary sm">Sign up</a>`;
  const tabMe = document.getElementById('tab-me');
  tabMe.href = me ? `#/u/${me.username}` : '#/login';
}

function applyTheme() {
  const accent = state.config?.theme?.accent;
  if (accent) document.documentElement.style.setProperty('--accent', accent);
}

async function refreshUnread() {
  if (!state.me) return;
  try {
    const { unread } = await api('/notifications?peek=1');
    if (unread !== state.unread) { state.unread = unread; renderNav(); }
  } catch { /* offline */ }
}

// ---------- views ----------
const views = {
  // Home layout comes from the server (config.home_sections), so it can change daily without an app update.
  async home(params) {
    const today = state.config.today;
    const day = params.get('day') || today;
    const sections = state.config.home_sections || ['today'];
    const [main, who, topics] = await Promise.all([
      Promise.all(sections.map(async (s) => {
        if (s === 'banner' && state.config.banner?.text) {
          const b = state.config.banner;
          return `<a class="banner ${esc(b.style || 'info')}" href="${esc(b.link || '#/')}">${icon('rocket')}<span>${esc(b.text)}</span>${icon('right', 16)}</a>`;
        }
        if (s === 'today') {
          const { products } = await api(`/products?day=${day}`);
          const label = day === today ? 'Top Products Launching Today' : `Top Products on ${fmtDay(day)}`;
          return `
            <section>
              <div class="section-head">
                <h1>${esc(label)}</h1>
                <div class="daynav">
                  <a class="icon-btn bordered" href="#/?day=${shiftDay(day, -1)}" aria-label="Previous day">${icon('left')}</a>
                  ${day < today ? `<a class="icon-btn bordered" href="#/?day=${shiftDay(day, 1)}" aria-label="Next day">${icon('right')}</a>` : ''}
                </div>
              </div>
              ${products.length ? productList(products) : emptyState(
                `No launches ${day === today ? 'yet today' : 'on this day'}.`,
                day === today ? '<a class="btn primary" href="#/submit">Submit your product</a>' : '',
              )}
            </section>`;
        }
        if (s === 'yesterday' && feature('digest') && day === today) {
          const { products, day: d } = await api('/digest');
          if (!products.length) return '';
          return `<section><div class="section-head"><h2>Yesterday's Top Products</h2><a class="see-all" href="#/?day=${d}">See all</a></div>${productList(products)}</section>`;
        }
        return '';
      })),
      api('/users?limit=4').catch(() => ({ users: [] })),
      sections.includes('topics') ? api('/topics') : { topics: [] },
    ]);
    const side = [
      who.users.length ? sideCard('Makers to follow', who.users.map(userRow).join('')) : '',
      topics.topics.length ? sideCard('Trending topics', `<div class="chips">${topics.topics.slice(0, 10).map((t) => `<a class="chip" href="#/t/${esc(t.slug)}">${esc(t.name)}</a>`).join('')}</div>`, '<a class="see-all" href="#/topics">All</a>') : '',
    ].join('');
    return `<div class="layout"><div class="main">${main.join('')}</div><aside class="side">${side}</aside></div>`;
  },

  async product(params, id) {
    const { product: p, comments } = await api(`/products/${id}`);
    document.title = `${p.name} — LaunchDay`;
    const byParent = {};
    for (const c of comments) (byParent[c.parent_id ?? 0] ||= []).push(c);
    const thread = (pid, depth) => (byParent[pid] || []).map((c) => `
      <div class="comment ${depth ? 'nested' : ''}">
        <a href="#/u/${esc(c.username)}">${avatar(c, depth ? 28 : 36)}</a>
        <div class="comment-body">
          <div class="comment-head">
            <a href="#/u/${esc(c.username)}"><b>${esc(c.name)}</b></a>
            ${c.is_maker ? '<span class="tag maker">Maker</span>' : ''}
            ${c.headline ? `<span class="muted ellipsis">${esc(c.headline)}</span>` : ''}
          </div>
          <p>${esc(c.body)}</p>
          <div class="comment-actions">
            <button class="act ${c.voted ? 'on' : ''}" data-comment-vote="${c.id}" aria-pressed="${c.voted}">${icon('up', 14)} <span>Upvote</span> <b>${c.votes || ''}</b></button>
            <button class="act" data-reply="${c.id}" data-reply-name="${esc(c.name)}">${icon('reply', 14)} Reply</button>
            ${state.me?.username === c.username ? `<button class="act" data-delete-comment="${c.id}">${icon('trash', 14)} Delete</button>` : ''}
            <span class="muted">${ago(c.created_at)}</span>
          </div>
          ${thread(c.id, depth + 1)}
        </div>
      </div>`).join('');

    const isMaker = state.me && state.me.username === p.maker_username;
    const links = [
      p.url && `<a class="btn secondary" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${icon('globe')} Visit website</a>`,
      p.play_store_url && `<a class="btn secondary" href="${esc(p.play_store_url)}" target="_blank" rel="noopener noreferrer">${icon('phone')} Google Play</a>`,
      p.app_store_url && `<a class="btn secondary" href="${esc(p.app_store_url)}" target="_blank" rel="noopener noreferrer">${icon('phone')} App Store</a>`,
    ].filter(Boolean).join('');
    const maker = p.maker_username ? { username: p.maker_username, name: p.maker_name, avatar: p.maker_avatar, headline: p.maker_headline } : null;

    return `
      ${p.scheduled ? `<div class="banner warning">${icon('calendar')}<span>Scheduled for ${esc(fmtDay(p.launch_date))}. Only you can see it until then.</span></div>` : ''}
      <div class="layout">
        <article class="main">
          <div class="detail-head">
            ${thumb(p, 80)}
            <div class="detail-title">
              <h1>${esc(p.name)}</h1>
              <p class="detail-tagline">${esc(p.tagline)}</p>
              <div class="row-meta">${topicLinks(p)}${p.badge_rank ? `<span class="dot">•</span>${medal(p.badge_rank)}` : ''}</div>
            </div>
          </div>
          <div class="detail-actions">
            ${links}
            ${p.scheduled ? '' : `<button class="btn upvote-big ${p.voted ? 'on' : ''}" data-vote="${p.id}" aria-pressed="${p.voted}">${icon('up')} <span>${p.voted ? 'Upvoted' : 'Upvote'}</span> <b>${p.votes}</b></button>`}
          </div>
          ${p.screenshots.length ? `<div class="gallery">${p.screenshots.map((s) => `<a href="${esc(s)}" target="_blank"><img src="${esc(s)}" alt="${esc(p.name)} screenshot" loading="lazy"></a>`).join('')}</div>` : ''}
          ${p.description ? `<p class="description">${esc(p.description)}</p>` : ''}
          <div class="detail-tools">
            <button class="btn ghost sm" data-share="${p.id}">${icon('share', 16)} Share</button>
            ${isMaker ? `<button class="btn ghost sm danger" data-delete="${p.id}">${icon('trash', 16)} Delete launch</button>` : ''}
          </div>

          ${feature('comments') ? `
          <section class="discussion">
            <h2>Discussion <span class="count">${comments.length}</span></h2>
            ${state.me ? `
              <form class="comment-form" id="comment-form" data-product="${p.id}">
                ${avatar(state.me, 36)}
                <div class="comment-input">
                  <input type="hidden" name="parent_id">
                  <div class="replying" hidden><span></span><button type="button" class="link" data-cancel-reply>Cancel</button></div>
                  <textarea name="body" rows="2" maxlength="2000" placeholder="What do you think?" required></textarea>
                  <div class="form-foot"><button class="btn primary sm" type="submit">Comment</button></div>
                </div>
              </form>` : `<div class="login-prompt"><a class="btn secondary" href="#/login?next=${encodeURIComponent(`#/p/${p.id}`)}">Log in to join the discussion</a></div>`}
            <div class="comments">${thread(0, 0) || '<p class="muted center">No comments yet. Start the conversation!</p>'}</div>
          </section>` : ''}
        </article>

        <aside class="side">
          ${maker ? sideCard('Maker', `<div class="maker-card">${userRow({ ...maker, is_following: p.maker_is_following })}</div>`) : ''}
          ${sideCard('Launch details', `
            <ul class="facts">
              <li>${icon('calendar', 16)} ${p.scheduled ? 'Launching' : 'Launched'} ${esc(fmtDay(p.launch_date))}</li>
              <li>${icon('up', 16)} ${plural(p.votes, 'upvote')}</li>
              <li>${icon('comment', 16)} ${plural(comments.length, 'comment')}</li>
            </ul>`)}
        </aside>
      </div>`;
  },

  async topics() {
    const { topics } = await api('/topics');
    return `
      <div class="page-head"><h1>Topics</h1><p class="muted">Follow topics to personalise your “For you” feed.</p></div>
      <div class="grid">${topics.map((t) => `
        <div class="topic-card">
          <a class="topic-name" href="#/t/${esc(t.slug)}">${esc(t.name)}</a>
          <p class="muted">${esc(t.description)}</p>
          <div class="topic-foot">
            <span class="muted sm">${plural(t.products, 'product')} · ${plural(t.followers, 'follower')}</span>
            <button class="btn sm ${t.following ? 'secondary following' : 'primary'}" data-follow="${esc(t.slug)}"><span>${t.following ? 'Following' : 'Follow'}</span></button>
          </div>
        </div>`).join('')}</div>`;
  },

  async topic(params, slug) {
    const [{ products }, { topics }] = await Promise.all([api(`/products?topic=${encodeURIComponent(slug)}`), api('/topics')]);
    const t = topics.find((x) => x.slug === slug);
    if (!t) throw Object.assign(new Error('Topic not found.'), { status: 404 });
    return `
      <div class="page-head with-action">
        <div><h1>${esc(t.name)}</h1><p class="muted">${esc(t.description)} · ${plural(t.followers, 'follower')}</p></div>
        <button class="btn ${t.following ? 'secondary following' : 'primary'}" data-follow="${esc(t.slug)}"><span>${t.following ? 'Following' : 'Follow'}</span></button>
      </div>
      ${productList(products)}`;
  },

  async search(params) {
    const q = params.get('q') || '';
    document.getElementById('search-input').value = q;
    if (!q) return `<div class="page-head"><h1>Search</h1></div>${emptyState('Search for products and people.')}`;
    const [{ products }, { users }] = await Promise.all([
      api(`/products?q=${encodeURIComponent(q)}`),
      api(`/users?q=${encodeURIComponent(q)}`),
    ]);
    return `
      <div class="page-head"><h1>Results for “${esc(q)}”</h1></div>
      ${users.length ? `<h2>People</h2><div class="card-list">${users.map(userRow).join('')}</div>` : ''}
      <h2>Products</h2>${productList(products, false, 'No products match your search.')}`;
  },

  async feed() {
    if (!feature('personalized_feed')) return emptyState('The personalized feed is not available right now.');
    if (!state.me) return `<div class="page-head"><h1>For you</h1></div>${emptyState('Log in and follow makers and topics to get a personalised feed.', '<a class="btn primary" href="#/login?next=%23%2Ffeed">Log in</a>')}`;
    const { products } = await api('/products?feed=1');
    return `
      <div class="page-head"><h1>For you</h1><p class="muted">Launches from the last 7 days by makers and topics you follow. <a class="text-link" href="#/topics">Manage topics</a></p></div>
      ${productList(products, true, 'Follow some makers or topics to fill your feed.')}`;
  },

  async notifications() {
    if (!requireLogin()) return '';
    const { notifications } = await api('/notifications');
    state.unread = 0;
    renderNav();
    const text = (n) => ({
      follow: 'started following you',
      upvote: `upvoted <b>${esc(n.product_name)}</b>`,
      comment: `commented on <b>${esc(n.product_name)}</b>`,
      reply: `replied to your comment on <b>${esc(n.product_name)}</b>`,
    }[n.type]);
    const href = (n) => (n.type === 'follow' ? `#/u/${esc(n.username)}` : `#/p/${n.product_id}`);
    return `
      <div class="narrow-page">
        <div class="page-head"><h1>Notifications</h1></div>
        ${notifications.length ? `<div class="card-list">${notifications.map((n) => `
          <a class="notif ${n.unread ? 'unread' : ''}" href="${href(n)}">
            ${avatar(n, 40)}
            <div><p><b>${esc(n.name)}</b> ${text(n)}</p>${n.text ? `<p class="muted quote">“${esc(n.text)}”</p>` : ''}<span class="muted sm">${ago(n.at)}</span></div>
          </a>`).join('')}</div>` : emptyState('No notifications yet. Launch something or join a discussion!')}
      </div>`;
  },

  async submit() {
    if (!feature('submissions')) return emptyState('Submissions are paused right now.');
    if (!requireLogin()) return '';
    const { topics } = await api('/topics');
    return `
      <div class="narrow-page">
        <div class="page-head"><h1>Submit a product</h1><p class="muted">Share your app or website with the community.</p></div>
        <form class="panel form" id="submit-form">
          <h3 class="form-section">Main info</h3>
          <label>Name of the product <input name="name" maxlength="60" required placeholder="Simply the name of the product"></label>
          <label>Tagline <input name="tagline" maxlength="90" required placeholder="Concise and descriptive tagline for the product"></label>
          <label>Description <textarea name="description" rows="4" maxlength="2000" placeholder="What does it do, who is it for, what makes it different?"></textarea></label>

          <h3 class="form-section">Links <span class="muted sm">at least one</span></h3>
          <label>Website <input name="url" type="url" placeholder="https://yourproduct.com"></label>
          <div class="row">
            <label>Google Play <input name="play_store_url" type="url" placeholder="https://play.google.com/store/apps/…"></label>
            <label>App Store <input name="app_store_url" type="url" placeholder="https://apps.apple.com/app/…"></label>
          </div>

          <h3 class="form-section">Media</h3>
          <div class="row">
            <label>Thumbnail <span class="hint">Square PNG, JPG, GIF or WebP, max 5 MB</span>
              <input name="logo" type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-preview="logo-preview">
            </label>
            <label>Gallery <span class="hint">Up to 6 images, max 5 MB each</span>
              <input name="screenshots" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple data-preview="shots-preview">
            </label>
          </div>
          <div class="previews"><div id="logo-preview"></div><div id="shots-preview" class="gallery small"></div></div>

          <h3 class="form-section">Launch</h3>
          <div class="row">
            <label>Brand color <span class="hint">Used when there's no thumbnail</span><input name="color" type="color" value="#ff6154"></label>
            <label>Launch date <input name="launch_date" type="date" min="${state.config.today}" value="${state.config.today}"></label>
          </div>
          <fieldset><legend>Topics <span class="muted sm">up to 3</span></legend>
            <div class="chips">${topics.map((t) => `<label class="chip check"><input type="checkbox" name="topics" value="${esc(t.slug)}"><span>${esc(t.name)}</span></label>`).join('')}</div>
          </fieldset>
          <div class="form-foot"><button class="btn primary lg" type="submit">${icon('rocket')} <span>Launch</span></button></div>
        </form>
      </div>`;
  },

  async user(params, username, tab = '') {
    const [{ user, made, upvoted, scheduled, topics }, people] = await Promise.all([
      api(`/users/${encodeURIComponent(username)}`),
      tab === 'followers' || tab === 'following' ? api(`/users/${encodeURIComponent(username)}/${tab}`) : null,
    ]);
    document.title = `${user.name} (@${user.username}) — LaunchDay`;
    const base = `#/u/${esc(user.username)}`;
    const tabs = [['', 'About'], ['made', `Made <span class="count">${made.length}</span>`], ['upvotes', `Upvotes <span class="count">${user.upvotes}</span>`],
      ['followers', `Followers <span class="count">${user.followers}</span>`], ['following', `Following <span class="count">${user.following}</span>`]];
    let body;
    if (tab === 'made') {
      body = (scheduled.length ? `<h3 class="sub">Scheduled</h3>${productList(scheduled, false)}<h3 class="sub">Launched</h3>` : '')
        + productList(made, false, user.is_me ? 'You haven’t launched anything yet.' : 'No launches yet.');
    } else if (tab === 'upvotes') {
      body = productList(upvoted, false, 'No upvotes yet.');
    } else if (people) {
      body = people.users.length ? `<div class="card-list">${people.users.map(userRow).join('')}</div>`
        : emptyState(tab === 'followers' ? 'No followers yet.' : 'Not following anyone yet.');
    } else {
      body = `
        ${user.bio ? `<div class="about"><h3 class="sub">About</h3><p>${esc(user.bio)}</p></div>` : user.is_me ? `<div class="about muted">Tell people about yourself. <a class="text-link" href="#/settings">Add a bio</a></div>` : ''}
        ${topics.length ? `<h3 class="sub">Interests</h3><div class="chips">${topics.map((t) => `<a class="chip" href="#/t/${esc(t.slug)}">${esc(t.name)}</a>`).join('')}</div>` : ''}
        <h3 class="sub">Launches</h3>${productList(made.slice(0, 3), false, 'No launches yet.')}
        ${made.length > 3 ? `<a class="see-all block" href="${base}/made">See all ${made.length} launches</a>` : ''}`;
    }
    return `
      <div class="profile">
        <div class="profile-head">
          ${avatar(user, 112)}
          <div class="profile-info">
            <h1>${esc(user.name)}</h1>
            ${user.headline ? `<p class="profile-headline">${esc(user.headline)}</p>` : ''}
            <p class="profile-meta">
              <span>@${esc(user.username)}</span>
              ${user.follows_you ? '<span class="tag">Follows you</span>' : ''}
              <span class="dot">•</span><a href="${base}/followers"><b>${user.followers}</b> followers</a>
              <span class="dot">•</span><a href="${base}/following"><b>${user.following}</b> following</a>
            </p>
            <p class="profile-links">
              <span class="muted">${icon('calendar', 14)} Joined ${esc(joined(user.created_at))}</span>
              ${user.website ? `<a href="${esc(user.website)}" target="_blank" rel="noopener noreferrer">${icon('globe', 14)} ${esc(user.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a>` : ''}
              ${user.twitter ? `<a href="https://x.com/${esc(user.twitter)}" target="_blank" rel="noopener noreferrer"><span class="x-logo">𝕏</span> @${esc(user.twitter)}</a>` : ''}
            </p>
          </div>
          <div class="profile-actions">
            ${user.is_me ? `<a class="btn secondary" href="#/settings">${icon('edit', 16)} Edit profile</a>` : followButton(user)}
          </div>
        </div>
        <nav class="tabs" aria-label="Profile sections">
          ${tabs.map(([t, label]) => `<a class="${t === tab ? 'active' : ''}" href="${base}${t ? `/${t}` : ''}">${label}</a>`).join('')}
        </nav>
        <div class="tab-body">${body}</div>
      </div>`;
  },

  async settings() {
    if (!requireLogin()) return '';
    const { user } = await api(`/users/${encodeURIComponent(state.me.username)}`);
    return `
      <div class="narrow-page">
        <div class="page-head"><h1>Edit profile</h1><p class="muted">This is how others see you on LaunchDay.</p></div>
        <form class="panel form" id="profile-form" data-username-check>
          <div class="avatar-edit">
            <div id="avatar-preview">${avatar(user, 80)}</div>
            <div class="avatar-edit-actions">
              <label class="btn secondary sm file-btn">${icon('camera', 16)} Upload new picture
                <input name="avatar" type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden>
              </label>
              ${user.avatar ? '<button type="button" class="btn ghost sm" data-remove-avatar>Remove</button>' : ''}
              <span class="hint">Square image recommended, max 5 MB.</span>
            </div>
            <input type="hidden" name="remove_avatar" value="0">
          </div>
          <div class="row">
            <label>Name <input name="name" maxlength="50" required value="${esc(user.name)}" autocomplete="name"></label>
            <label>Username
              <span class="input-prefix"><span>@</span><input name="username" maxlength="20" required value="${esc(user.username)}" autocapitalize="none" spellcheck="false" autocomplete="username"></span>
            </label>
          </div>
          <div id="username-hint" class="hint" aria-live="polite"></div>
          <label>Headline <input name="headline" maxlength="80" value="${esc(user.headline)}" placeholder="e.g. Founder @ Acme · Indie hacker"></label>
          <label>About <textarea name="bio" rows="4" maxlength="500" placeholder="A few words about you, what you build and what you love.">${esc(user.bio)}</textarea></label>
          <div class="row">
            <label>Website <input name="website" type="url" value="${esc(user.website)}" placeholder="https://yoursite.com"></label>
            <label>X (Twitter) <span class="input-prefix"><span>@</span><input name="twitter" maxlength="15" value="${esc(user.twitter)}" placeholder="handle"></span></label>
          </div>
          <div class="form-foot between">
            <a class="btn ghost" href="#/u/${esc(user.username)}">Cancel</a>
            <button class="btn primary" type="submit">Save changes</button>
          </div>
        </form>
        <div class="panel danger-zone">
          <div><b>Log out</b><p class="muted sm">Sign out of LaunchDay on this device.</p></div>
          <button class="btn secondary sm" id="logout">${icon('logout', 16)} Log out</button>
        </div>
      </div>`;
  },

  login(params) { return authForm('login', params.get('next')); },
  register(params) { return authForm('register', params.get('next')); },
};

function authForm(kind, next) {
  const isLogin = kind === 'login';
  return `
    <div class="auth-wrap">
      <form class="panel form auth" id="auth-form" data-kind="${kind}" data-next="${esc(next || '#/')}" ${isLogin ? '' : 'data-username-check'}>
        <img src="/icon.svg" alt="" width="48" height="48" class="auth-logo">
        <h1>${isLogin ? 'Welcome back' : 'Join LaunchDay'}</h1>
        <p class="muted center">${isLogin ? 'Log in to upvote, comment and follow makers.' : 'Discover the best new products, every day.'}</p>
        ${isLogin ? '' : '<label>Name <input name="name" maxlength="50" autocomplete="name" placeholder="Your full name"></label>'}
        <label>Username
          <span class="input-prefix"><span>@</span><input name="username" required maxlength="${isLogin ? 40 : 20}" autocomplete="username" autocapitalize="none" spellcheck="false"></span>
        </label>
        ${isLogin ? '' : '<div id="username-hint" class="hint" aria-live="polite"></div>'}
        <label>Password <input name="password" type="password" required minlength="${isLogin ? 1 : 8}" autocomplete="${isLogin ? 'current-password' : 'new-password'}" ${isLogin ? '' : 'placeholder="At least 8 characters"'}></label>
        <button class="btn primary lg block" type="submit">${isLogin ? 'Log in' : 'Create account'}</button>
        <p class="muted center sm">${isLogin ? 'New here? <a class="text-link" href="#/register">Create an account</a>' : 'Have an account? <a class="text-link" href="#/login">Log in</a>'}</p>
      </form>
    </div>`;
}

// ---------- router ----------
const routes = [
  [/^\/$/, 'home'], [/^\/p\/(\d+)$/, 'product'], [/^\/topics$/, 'topics'], [/^\/t\/([\w-]+)$/, 'topic'],
  [/^\/search$/, 'search'], [/^\/feed$/, 'feed'], [/^\/submit$/, 'submit'], [/^\/notifications$/, 'notifications'],
  [/^\/u\/(\w+)(?:\/(made|upvotes|followers|following))?$/, 'user'], [/^\/settings$/, 'settings'],
  [/^\/login$/, 'login'], [/^\/register$/, 'register'],
];

async function render() {
  const [path, query = ''] = (location.hash.slice(1) || '/').split('?');
  const params = new URLSearchParams(query);
  document.title = 'LaunchDay — The best new products, every day';
  closeMenu();
  const section = path === '/' ? '/' : `/${path.split('/')[1]}`;
  for (const a of document.querySelectorAll('[data-section]')) a.classList.toggle('active', a.dataset.section === section);
  // The Profile tab is only "you" on your own profile or settings.
  document.getElementById('tab-me').classList.toggle('active', !!state.me && (path === `/u/${state.me.username}` || path.startsWith(`/u/${state.me.username}/`) || path === '/settings'));
  const match = routes.map(([re, name]) => [path.match(re), name]).find(([m]) => m);
  if (!match) { $view.innerHTML = emptyState('Page not found.'); return; }
  const [m, name] = match;
  $view.classList.add('loading');
  try {
    $view.innerHTML = await views[name](params, ...m.slice(1).map((s) => (s === undefined ? undefined : decodeURIComponent(s))));
  } catch (e) {
    $view.innerHTML = emptyState(e.status === 404 ? 'Not found.' : navigator.onLine ? esc(e.message) : 'You are offline — reconnect to load this page.');
  } finally {
    $view.classList.remove('loading');
  }
}

// ---------- interactions ----------
function closeMenu() {
  const menu = document.getElementById('menu');
  if (menu && !menu.hidden) { menu.hidden = true; document.getElementById('menu-btn').setAttribute('aria-expanded', 'false'); }
}

function setFollowState(btn, following) {
  btn.classList.toggle('primary', !following);
  btn.classList.toggle('secondary', following);
  btn.classList.toggle('following', following);
  btn.setAttribute('aria-pressed', following);
  btn.querySelector('span').textContent = following ? 'Following' : 'Follow';
}

document.addEventListener('click', async (e) => {
  const menuBtn = e.target.closest('#menu-btn');
  if (menuBtn) {
    const menu = document.getElementById('menu');
    menu.hidden = !menu.hidden;
    menuBtn.setAttribute('aria-expanded', !menu.hidden);
    return;
  }
  if (!e.target.closest('#menu')) closeMenu();

  const vote = e.target.closest('[data-vote]');
  if (vote) {
    if (!requireLogin()) return;
    try {
      const { voted, votes } = await api(`/products/${vote.dataset.vote}/vote`, { method: 'POST' });
      for (const b of document.querySelectorAll(`[data-vote="${vote.dataset.vote}"]`)) {
        b.classList.toggle('on', voted);
        b.setAttribute('aria-pressed', voted);
        b.querySelector('b').textContent = votes;
        const label = b.querySelector('span');
        if (label) label.textContent = voted ? 'Upvoted' : 'Upvote';
      }
    } catch (err) { toast(err.message); }
    return;
  }
  const cvote = e.target.closest('[data-comment-vote]');
  if (cvote) {
    if (!requireLogin()) return;
    try {
      const { voted, votes } = await api(`/comments/${cvote.dataset.commentVote}/vote`, { method: 'POST' });
      cvote.classList.toggle('on', voted);
      cvote.setAttribute('aria-pressed', voted);
      cvote.querySelector('b').textContent = votes || '';
    } catch (err) { toast(err.message); }
    return;
  }
  const followUser = e.target.closest('[data-follow-user]');
  if (followUser) {
    if (!requireLogin()) return;
    followUser.disabled = true;
    try {
      const { following } = await api(`/users/${followUser.dataset.followUser}/follow`, { method: 'POST' });
      for (const b of document.querySelectorAll(`[data-follow-user="${followUser.dataset.followUser}"]`)) setFollowState(b, following);
      if (location.hash.startsWith(`#/u/${followUser.dataset.followUser}`)) render();
    } catch (err) { toast(err.message); } finally { followUser.disabled = false; }
    return;
  }
  const follow = e.target.closest('[data-follow]');
  if (follow) {
    if (!requireLogin()) return;
    try {
      const { following } = await api(`/topics/${follow.dataset.follow}/follow`, { method: 'POST' });
      setFollowState(follow, following);
      toast(following ? 'Topic followed — it will appear in “For you”.' : 'Unfollowed.');
    } catch (err) { toast(err.message); }
    return;
  }
  const reply = e.target.closest('[data-reply]');
  if (reply) {
    if (!requireLogin()) return;
    const form = document.getElementById('comment-form');
    form.parent_id.value = reply.dataset.reply;
    const note = form.querySelector('.replying');
    note.hidden = false;
    note.querySelector('span').textContent = `Replying to ${reply.dataset.replyName}`;
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    form.body.focus({ preventScroll: true });
    return;
  }
  if (e.target.closest('[data-cancel-reply]')) {
    const form = document.getElementById('comment-form');
    form.parent_id.value = '';
    form.querySelector('.replying').hidden = true;
    return;
  }
  const delComment = e.target.closest('[data-delete-comment]');
  if (delComment) {
    if (!confirm('Delete this comment? Replies to it will be removed too.')) return;
    try {
      await api(`/comments/${delComment.dataset.deleteComment}`, { method: 'DELETE' });
      await render();
    } catch (err) { toast(err.message); }
    return;
  }
  const share = e.target.closest('[data-share]');
  if (share) {
    const url = `${location.origin}/#/p/${share.dataset.share}`;
    if (navigator.share) navigator.share({ url }).catch(() => {});
    else navigator.clipboard.writeText(url).then(() => toast('Link copied!'));
    return;
  }
  const del = e.target.closest('[data-delete]');
  if (del) {
    if (!confirm('Delete this launch permanently? Votes, comments and images will be removed.')) return;
    try {
      await api(`/products/${del.dataset.delete}`, { method: 'DELETE' });
      toast('Launch deleted.');
      location.hash = `#/u/${state.me.username}/made`;
    } catch (err) { toast(err.message); }
    return;
  }
  const pick = e.target.closest('[data-pick]');
  if (pick) {
    const input = pick.closest('form').elements.username;
    input.value = pick.dataset.pick;
    checkUsername(input.form);
    return;
  }
  if (e.target.closest('[data-remove-avatar]')) {
    const form = document.getElementById('profile-form');
    form.remove_avatar.value = '1';
    form.avatar.value = '';
    document.getElementById('avatar-preview').innerHTML = avatar({ ...state.me, avatar: null }, 80);
    e.target.closest('[data-remove-avatar]').remove();
    return;
  }
  if (e.target.closest('#logout')) {
    await api('/auth/logout', { method: 'POST' });
    state.me = null;
    state.unread = 0;
    renderNav();
    location.hash = '#/';
  }
});

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (form.id === 'search-form') {
    e.preventDefault();
    location.hash = `#/search?q=${encodeURIComponent(document.getElementById('search-input').value.trim())}`;
    return;
  }
  if (!['auth-form', 'submit-form', 'comment-form', 'profile-form'].includes(form.id)) return;
  e.preventDefault();
  const btn = form.querySelector('[type=submit]');
  btn.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(form));
    if (form.id === 'auth-form') {
      const { user } = await api(`/auth/${form.dataset.kind}`, { method: 'POST', body: data });
      state.me = user;
      renderNav();
      refreshUnread();
      location.hash = form.dataset.next;
    } else if (form.id === 'profile-form') {
      const fd = new FormData(form);
      if (!form.avatar.files.length) fd.delete('avatar');
      const { user } = await api('/me', { method: 'PUT', body: fd });
      state.me = user;
      renderNav();
      toast('Profile saved.');
      location.hash = `#/u/${user.username}`;
    } else if (form.id === 'submit-form') {
      const fd = new FormData(form);
      if (fd.getAll('topics').length > 3) throw new Error('Pick up to 3 topics.');
      if (![fd.get('url'), fd.get('play_store_url'), fd.get('app_store_url')].some((v) => v.trim())) {
        throw new Error('Add at least one link: website, Google Play or App Store.');
      }
      if (form.screenshots.files.length > 6) throw new Error('You can upload up to 6 screenshots.');
      // Drop empty file inputs so the server only receives real uploads.
      for (const key of ['logo', 'screenshots']) if (!form[key].files.length) fd.delete(key);
      btn.querySelector('span').textContent = 'Uploading…';
      const { id, launch_date } = await api('/products', { method: 'POST', body: fd });
      if (launch_date > state.config.today) { toast(`Scheduled for ${fmtDay(launch_date)} 🎉`, 4000); location.hash = `#/u/${state.me.username}/made`; }
      else location.hash = `#/p/${id}`;
    } else {
      if (!requireLogin()) return;
      await api(`/products/${form.dataset.product}/comments`, { method: 'POST', body: { body: data.body, parent_id: data.parent_id || null } });
      await render();
    }
  } catch (err) {
    if (err.data?.suggestions) showUsernameHint(form, err.data);
    else toast(err.message, 4000);
  } finally {
    btn.disabled = false;
    if (form.id === 'submit-form') btn.querySelector('span').textContent = 'Launch';
  }
});

// Live username availability (sign-up and edit profile), with suggestions when it's taken.
function showUsernameHint(form, { username, available, suggestions = [] }) {
  const hint = form.querySelector('#username-hint');
  if (!hint) return;
  if (!username && !suggestions.length) { hint.innerHTML = ''; return; }
  const chips = suggestions.map((s) => `<button type="button" class="chip check" data-pick="${esc(s)}">@${esc(s)}</button>`).join('');
  hint.innerHTML = available
    ? `<span class="ok">${icon('check', 14)} @${esc(username)} is available</span>`
    : `<span class="taken">${username ? `@${esc(username)} is taken.` : 'Pick a username.'}</span>${chips ? ` Try: <span class="chips">${chips}</span>` : ''}`;
}

let usernameTimer, usernameSeq = 0;
function checkUsername(form) {
  if (!form?.hasAttribute('data-username-check')) return;
  clearTimeout(usernameTimer);
  const u = form.elements.username.value.trim();
  // Keeping your own current username needs no check.
  if (!u || (form.id === 'profile-form' && u.toLowerCase() === state.me?.username)) { showUsernameHint(form, {}); return; }
  usernameTimer = setTimeout(async () => {
    const seq = ++usernameSeq;
    try {
      const res = await api(`/auth/username?u=${encodeURIComponent(u)}&name=${encodeURIComponent(form.elements.name?.value || '')}`);
      if (seq === usernameSeq) showUsernameHint(form, res);
    } catch { /* offline: the server still checks on submit */ }
  }, 300);
}
document.addEventListener('input', (e) => { if (e.target.name === 'username') checkUsername(e.target.form); });

// Show chosen images before uploading.
document.addEventListener('change', (e) => {
  const input = e.target;
  if (input.name === 'avatar' && input.files[0]) {
    input.form.remove_avatar.value = '0';
    document.getElementById('avatar-preview').innerHTML = `<img class="avatar" src="${URL.createObjectURL(input.files[0])}" alt="" style="width:80px;height:80px">`;
    return;
  }
  if (!input.dataset?.preview) return;
  const box = document.getElementById(input.dataset.preview);
  box.replaceChildren(...[...input.files].map((f) => {
    const img = new Image();
    img.src = URL.createObjectURL(f);
    img.alt = f.name;
    if (input.name === 'logo') img.className = 'thumb preview';
    return img;
  }));
});

// ---------- silent self-update ----------
// Every deploy changes the server version. Installed apps check on open, when brought back
// to the foreground, and every 10 minutes, then reload themselves into the new version.
function isBusy() {
  const el = document.activeElement;
  return el && ['INPUT', 'TEXTAREA'].includes(el.tagName) && el.value;
}

async function checkForUpdate() {
  try {
    const res = await fetch('/api/version', { cache: 'no-store' });
    const { version } = await res.json();
    if (!version || version === window.APP_VERSION) return;
    navigator.serviceWorker?.getRegistration().then((r) => r?.update());
    let tried = null;
    try { tried = sessionStorage.getItem('reloaded-for'); sessionStorage.setItem('reloaded-for', version); } catch {}
    if (isBusy() || tried === version) {
      // Already reloaded once for this version (or the user is typing): let them choose when.
      const el = toast('A new version is ready — tap to update.', 0);
      el.onclick = () => location.reload();
    } else {
      location.reload();
    }
  } catch { /* offline: try again later */ }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  checkForUpdate();
  refreshUnread();
});
setInterval(checkForUpdate, 10 * 60 * 1000);
setInterval(refreshUnread, 2 * 60 * 1000);

// ---------- boot ----------
(async function boot() {
  try {
    [state.config, { user: state.me }] = await Promise.all([api('/config'), api('/me')]);
  } catch {
    state.config = { today: new Date().toISOString().slice(0, 10), features: {}, home_sections: ['today'] };
  }
  applyTheme();
  renderNav();
  refreshUnread();
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  await render();
  checkForUpdate();
})();
