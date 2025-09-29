// server.js
// Node.js + Express + Brave + Puppeteer-extra + stealth
// Run: NODE_DEBUG=1 node server.js
// Windows Brave path default included (update if needed)

const express = require('express');
const { addExtra } = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const puppeteer = require('puppeteer-core'); // so we can pass Brave executable
const URL = require('url').URL;

const browserExtra = addExtra(puppeteer);
browserExtra.use(StealthPlugin());

/** CONFIG — adjust as needed **/
const BRAVE_PATH = process.env.BRAVE_PATH || 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const PORT = process.env.PORT || 3000;
const DEFAULT_SAMPLE_SIZE = 12; // number of posts to sample

const app = express();
app.use(express.json());

/* -------------------------
   Utility helpers
   ------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeParseJSON(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

/* Normalize possible shapes returned by GraphQL / web_profile_info / inline JSON */
function normalizeUserFromGraphql(data) {
  function findUser(obj) {
    if (!obj || typeof obj !== 'object') return null;
    // common shapes
    if (obj.graphql && obj.graphql.user) return obj.graphql.user;
    if (obj.data && obj.data.user) return obj.data.user;
    if (obj.entry_data && Array.isArray(obj.entry_data.ProfilePage) && obj.entry_data.ProfilePage[0]?.graphql?.user) {
      return obj.entry_data.ProfilePage[0].graphql.user;
    }
    // shallow scan
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === 'object') {
        if (v.edge_followed_by || v.edge_owner_to_timeline_media || v.username) return v;
      }
    }
    return null;
  }

  const user = findUser(data) || findUser(data.data) || findUser(data.data?.user);
  if (!user) return null;

  const fullname = user.full_name || user.name || null;
  const username = user.username || user.user?.username || null;
  const profile_pic = user.profile_pic_url || user.profile_pic_url_hd || user.profile_picture || null;

  const followers = (user.edge_followed_by && user.edge_followed_by.count) || user.followed_by_count || user.followers || null;
  const following = (user.edge_follow && user.edge_follow.count) || user.follows_count || user.following || null;
  const posts_count = (user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.count) || user.media_count || user.posts_count || null;

  const edges = (user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.edges) || user.media || user.recent_media || null;
  const posts = Array.isArray(edges) ? edges.map(e => {
    const node = e.node || e;
    const likes = (node.edge_liked_by && node.edge_liked_by.count) || (node.edge_media_preview_like && node.edge_media_preview_like.count) || node.like_count || null;
    const comments = (node.edge_media_to_comment && node.edge_media_to_comment.count) || node.comment_count || null;
    return { id: node.id || node.shortcode || null, likes, comments, timestamp: node.taken_at_timestamp || node.taken_at || null };
  }) : [];

  return { fullname, username, profile_pic, followers, following, posts_count, posts };
}

function computeAnalytics(posts, followers = 0, sampleSize = DEFAULT_SAMPLE_SIZE) {
  const slice = posts.filter(p => p != null).slice(0, sampleSize);
  const likes = slice.map(p => Number(p.likes || 0));
  const comments = slice.map(p => Number(p.comments || 0));
  const mean = arr => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length) : 0;
  const avgLikes = mean(likes);
  const avgComments = mean(comments);
  const engagementRate = (followers && followers > 0) ? Number(((avgLikes + avgComments) / followers * 100).toFixed(2)) : null;
  return { sample_size: slice.length, avg_likes: avgLikes, avg_comments: avgComments, engagement_rate_pct: engagementRate };
}

/* -------------------------
   Core scraper
   ------------------------- */
async function scrapeProfile(username, sampleSize = DEFAULT_SAMPLE_SIZE, options = {}) {
  console.log(`[scrape] start for username=${username} sample=${sampleSize}`);

  const executablePath = options.executablePath || BRAVE_PATH;
  const launchOptions = {
    headless: options.headless ?? 'new', // change to false for visual debug
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ],
    defaultViewport: { width: 1200, height: 800 }
  };

  console.log('[scrape] launching browser', { executablePath: executablePath, headless: launchOptions.headless });
  const browser = await browserExtra.launch(launchOptions);
  const page = await browser.newPage();

  // headers / user agent
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.setUserAgent(options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36');

  // capture candidate JSONs
  const capturedJsons = [];
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      // debug log - limited to avoid noise
      if (process.env.NODE_DEBUG) console.log('[response] url=', url);

      if (url.includes('/api/v1/users/web_profile_info') || url.includes('/api/graphql/') || url.includes('/graphql/')) {
        try {
          const ct = (resp.headers && resp.headers()['content-type']) || resp.headers()['content-type'] || '';
          const text = await resp.text();
          // prefer JSON parse
          let json = null;
          if (text && text.trim().startsWith('{')) {
            json = safeParseJSON(text);
          }
          if (!json) {
            // try .json() if available (some puppeteer versions work better)
            try { json = await resp.json(); } catch(e) { /* ignore */ }
          }
          if (json) {
            console.log('[response][captured-json] url=', url, ' keys=', Object.keys(json).slice(0,6));
            capturedJsons.push({ url, json });
          } else {
            console.log('[response] non-json or empty from', url, 'content-len=', text?.length);
          }
        } catch (e) {
          if (process.env.NODE_DEBUG) console.warn('[response] error reading resp', e && e.message);
        }
      }
    } catch (e) {
      if (process.env.NODE_DEBUG) console.warn('[response] outer handler error', e && e.message);
    }
  });

  const profileUrl = `https://www.instagram.com/${encodeURIComponent(username)}/`;
  console.log('[scrape] goto', profileUrl);
  await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 60000 });

  // Wait specifically for either web_profile_info or a graphql call (max 6s)
  try {
    console.log('[scrape] waiting for a profile-related response (graphql / web_profile_info)...');
    await page.waitForResponse(resp => {
      const u = resp.url();
      return u.includes('/api/v1/users/web_profile_info') || u.includes('/api/graphql/') || u.includes('/graphql/');
    }, { timeout: 6000 });
    console.log('[scrape] observed at least one targeted response');
  } catch (e) {
    console.log('[scrape] no targeted response within timeout; proceeding to fallback fetchs');
  }

  // small delay to allow additional responses to come in
  await sleep(800);

  // Fallback: attempt an in-page fetch to the web_profile_info endpoint (often contains followers/following)
  try {
    console.log('[scrape] attempting in-page web_profile_info fetch as fallback');
    const webInfo = await page.evaluate(async (uname) => {
      try {
        const resp = await fetch(`https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(uname)}`, {
          headers: {
            'x-ig-app-id': '1217981644879628',
            'accept': '*/*'
          },
          credentials: 'include'
        });
        const t = await resp.text();
        console.log('[scrape][fallback] fetch status', resp.status, t);
        try { return JSON.parse(t); } catch(e) { return { _text: t.slice(0,1000) }; }
      } catch (err) {
        return { _err: String(err && err.message) };
      }
    }, username);

    if (webInfo && webInfo.data) {
      console.log('[scrape][fallback] web_profile_info returned keys:', Object.keys(webInfo).slice(0,6));
      capturedJsons.push({ url: 'web_profile_info_fallback', json: webInfo });
    } else {
      console.log('[scrape][fallback] web_profile_info returned non-data:', Object.keys(webInfo).slice(0,6));
    }
  } catch (e) {
    console.warn('[scrape][fallback] fetch failed', e && e.message);
  }

  // Also attempt to read inline scripts (embedded JSON) as a last fallback
  try {
    const embedded = await page.evaluate(() => {
      try {
        const scripts = Array.from(document.scripts || []);
        for (const s of scripts) {
          const txt = (s.textContent || '').trim();
          if (!txt || txt.length < 200) continue;
          if (txt.includes('edge_owner_to_timeline_media') || txt.includes('ProfilePage') || txt.includes('graphql')) {
            const first = txt.indexOf('{');
            const last = txt.lastIndexOf('}');
            if (first >= 0 && last > first) {
              const candidate = txt.slice(first, last + 1);
              try { return JSON.parse(candidate); } catch (e) {}
            }
          }
        }
        return null;
      } catch (e) { return null; }
    });

    if (embedded) {
      console.log('[scrape][embedded] found embedded JSON candidate');
      capturedJsons.push({ url: 'embedded_script', json: embedded });
    } else {
      console.log('[scrape][embedded] no embedded JSON found');
    }
  } catch (e) {
    console.warn('[scrape][embedded] eval failed', e && e.message);
  }

  // close the browser now that we've collected responses
  await browser.close();
  console.log('[scrape] browser closed; total captured payloads =', capturedJsons.length);

  // Prioritize candidate that includes followers/following
  let normalized = null;
  for (const c of capturedJsons) {
    if (!c.json) continue;
    const maybe = normalizeUserFromGraphql(c.json);
    if (maybe) {
      console.log('[scrape][normalize] candidate from', c.url, '=>', {
        username: maybe.username, followers: maybe.followers, following: maybe.following, posts_count: maybe.posts_count
      });
      // prefer one with both followers and following
      if (maybe.followers != null && maybe.following != null) {
        normalized = maybe;
        normalized._source = c.url;
        break;
      }
      // otherwise tentatively keep first partial result
      if (!normalized) {
        normalized = maybe;
        normalized._source = c.url;
      }
    }
  }

  if (!normalized) {
    throw new Error('Unable to locate profile JSON (no candidate had user info). Try headful debugging (headless=false) or increase timeouts.');
  }

  // compute analytics from posts
  const analytics = computeAnalytics(normalized.posts || [], normalized.followers || 0, sampleSize);
  console.log('[scrape][result] normalized', {
    username: normalized.username,
    followers: normalized.followers,
    following: normalized.following,
    posts_count: normalized.posts_count,
    sample_posts: (normalized.posts || []).slice(0,3)
  });

  return {
    name: normalized.fullname,
    username: normalized.username,
    profile_picture: normalized.profile_pic,
    followers: normalized.followers,
    following: normalized.following,
    posts_count: normalized.posts_count,
    analytics,
    _meta: { source: normalized._source, scraped_at: new Date().toISOString() }
  };
}

/* -------------------------
   Express API
   ------------------------- */
app.get('/api/profile/:username', async (req, res) => {
  const username = req.params.username;
  const sample = Number(req.query.posts) || DEFAULT_SAMPLE_SIZE;
  if (!username) return res.status(400).json({ error: 'username required' });

  try {
    const data = await scrapeProfile(username, sample);
    return res.json(data);
  } catch (err) {
    console.error('[server] scrape error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

app.listen(PORT, () => {
  console.log(`[server] listening http://localhost:${PORT} — BRAVE_PATH=${BRAVE_PATH}`);
});
