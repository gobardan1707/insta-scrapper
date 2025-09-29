// server.js
const express = require('express');
const { addExtra } = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const puppeteer = require('puppeteer-core');

const browserExtra = addExtra(puppeteer);
browserExtra.use(StealthPlugin());

const BRAVE_PATH = process.env.BRAVE_PATH || 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const PORT = process.env.PORT || 3000;
const DEFAULT_SAMPLE_SIZE = 5;  // changed default to 5

const app = express();
app.use(express.json());

const sleep = ms => new Promise(r => setTimeout(r, ms));
function safeParseJSON(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

function normalizeUserFromGraphql(data) {
  function findUser(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.graphql && obj.graphql.user) return obj.graphql.user;
    if (obj.data && obj.data.user) return obj.data.user;
    if (obj.entry_data && Array.isArray(obj.entry_data.ProfilePage) &&
        obj.entry_data.ProfilePage[0]?.graphql?.user) {
      return obj.entry_data.ProfilePage[0].graphql.user;
    }
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === 'object') {
        if (v.edge_followed_by || v.edge_owner_to_timeline_media || v.username) {
          return v;
        }
      }
    }
    return null;
  }

  const user = findUser(data) || findUser(data.data) || findUser(data.data?.user);
  if (!user) return null;

  const fullname = user.full_name || user.name || null;
  const username = user.username || user.user?.username || null;
  const profile_pic = user.profile_pic_url || user.profile_pic_url_hd || user.profile_picture || null;

  const followers = (user.edge_followed_by && user.edge_followed_by.count)
                    || user.followed_by_count || user.followers || null;
  const following = (user.edge_follow && user.edge_follow.count)
                    || user.follows_count || user.following || null;
  const posts_count = (user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.count)
                      || user.media_count || user.posts_count || null;

  const edges = (user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.edges)
                || user.media || user.recent_media || null;
  const posts = Array.isArray(edges) ? edges.map(e => {
    const node = e.node || e;
    const likes = (node.edge_liked_by && node.edge_liked_by.count)
                  || (node.edge_media_preview_like && node.edge_media_preview_like.count)
                  || node.like_count || null;
    const comments = (node.edge_media_to_comment && node.edge_media_to_comment.count)
                     || node.comment_count || null;
    return {
      id: node.id || node.shortcode || null,
      shortcode: node.shortcode || null,
      likes,
      comments,
      timestamp: node.taken_at_timestamp || node.taken_at || null
    };
  }) : [];

  return { fullname, username, profile_pic, followers, following, posts_count, posts };
}

function computeAnalytics(posts, followers = 0, sampleSize = DEFAULT_SAMPLE_SIZE) {
  const slice = posts.filter(p => p != null).slice(0, sampleSize);
  const likes = slice.map(p => Number(p.likes || 0));
  const comments = slice.map(p => Number(p.comments || 0));
  const mean = arr => arr.length ? Math.round(arr.reduce((a,b) => a + b, 0) / arr.length) : 0;
  const avgLikes = mean(likes);
  const avgComments = mean(comments);
  const engagementRate = (followers && followers > 0)
    ? Number(((avgLikes + avgComments) / followers * 100).toFixed(2))
    : null;
  return { sample_size: slice.length, avg_likes: avgLikes, avg_comments: avgComments, engagement_rate_pct: engagementRate };
}

async function scrapeProfile(username, sampleSize = DEFAULT_SAMPLE_SIZE, options = {}) {
  console.log(`[scrape] start username=${username} sample=${sampleSize}`);

  const browser = await browserExtra.launch({
    headless: options.headless ?? 'new',
    executablePath: options.executablePath || BRAVE_PATH,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    defaultViewport: { width: 1200, height: 800 }
  });

  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.setUserAgent(options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

  const capturedJsons = [];
  page.on('response', async resp => {
    const url = resp.url();
    if (url.includes('/api/v1/users/web_profile_info') || url.includes('/api/graphql/') || url.includes('/graphql/')) {
      let text = null;
      try {
        text = await resp.text();
      } catch (e) {
        console.warn('[resp.text fail]', url, e.message);
      }
      let json = null;
      if (text && text.trim().startsWith('{')) {
        json = safeParseJSON(text);
      }
      if (!json) {
        try {
          json = await resp.json();
        } catch (e2) {
          console.warn('[resp.json fail]', url, e2.message);
        }
      }
      if (json) {
        console.log('[resp-captured] url=', url, ' keys=', Object.keys(json).slice(0,5));
        capturedJsons.push({ url, json });
      }
    }
  });

  const profileUrl = `https://www.instagram.com/${encodeURIComponent(username)}/`;
  console.log('[scrape] goto', profileUrl);
  await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 60000 });

  try {
    await page.waitForResponse(r => {
      const u = r.url();
      return u.includes('/api/v1/users/web_profile_info') || u.includes('/api/graphql/') || u.includes('/graphql/');
    }, { timeout: 6000 });
    console.log('[scrape] saw metadata response');
  } catch (e) {
    console.log('[scrape] metadata response timeout');
  }
  await sleep(800);

  try {
    const webInfo = await page.evaluate(async uname => {
      try {
        const resp = await fetch(`https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(uname)}`, {
          headers: { 'x-ig-app-id': '1217981644879628', accept: '*/*' },
          credentials: 'include'
        });
        const txt = await resp.text();
        console.log('[fallback fetch] status', resp.status, 'snippet', txt.slice(0,100));
        try {
          return JSON.parse(txt);
        } catch (e) {
          return { _text: txt.slice(0,500) };
        }
      } catch (err) {
        return { _err: err.message };
      }
    }, username);
    if (webInfo && webInfo.data) {
      console.log('[fallback] keys', Object.keys(webInfo).slice(0,5));
      capturedJsons.push({ url: 'web_profile_info_fallback', json: webInfo });
    }
  } catch (e) {
    console.warn('[fallback] fetch error', e.message);
  }

  try {
    const embedded = await page.evaluate(() => {
      const scripts = Array.from(document.scripts || []);
      for (const s of scripts) {
        const txt = (s.textContent || '').trim();
        if (txt.includes('edge_owner_to_timeline_media') || txt.includes('graphql')) {
          const f = txt.indexOf('{'), l = txt.lastIndexOf('}');
          if (f >= 0 && l > f) {
            const cand = txt.slice(f, l + 1);
            try { return JSON.parse(cand); } catch (_) {}
          }
        }
      }
      return null;
    });
    if (embedded) {
      console.log('[embedded] inline JSON found');
      capturedJsons.push({ url: 'embedded_script', json: embedded });
    }
  } catch (e) {
    console.warn('[embedded eval]', e.message);
  }

  let normalized = null;
  for (const c of capturedJsons) {
    const maybe = normalizeUserFromGraphql(c.json);
    if (maybe) {
      console.log('[norm] from', c.url, {
        username: maybe.username,
        followers: maybe.followers,
        following: maybe.following
      });
      if (maybe.followers != null && maybe.following != null) {
        normalized = maybe;
        normalized._source = c.url;
        break;
      }
      if (!normalized) {
        normalized = maybe;
        normalized._source = c.url;
      }
    }
  }

  if (!normalized) {
    await browser.close();
    throw new Error('Normalized profile not found');
  }

  const postDetails = [];
  for (const post of normalized.posts.slice(0, sampleSize)) {
    const sc = post.shortcode || post.id;
    if (!sc) continue;
    try {
      const url = `https://www.instagram.com/p/${sc}/`;
      console.log('[post navigate]', url);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

      const detail = await page.evaluate(() => {
        const result = { thumbnail: null, caption: null };
        const ogImg = document.querySelector('meta[property="og:image"]');
        if (ogImg && ogImg.content) {
          result.thumbnail = ogImg.content;
        }

        try {
          const scripts = Array.from(document.scripts);
          for (const s of scripts) {
            const txt = s.textContent || '';
            if (txt.includes('edge_media_to_caption') || txt.includes('shortcode_media')) {
              const f = txt.indexOf('{'), l = txt.lastIndexOf('}');
              if (f >= 0 && l > f) {
                const obj = JSON.parse(txt.slice(f, l + 1));
                let media = obj;
                if (media.entry_data?.PostPage) {
                  media = media.entry_data.PostPage[0].graphql.shortcode_media;
                } else if (media.graphql?.shortcode_media) {
                  media = media.graphql.shortcode_media;
                }
                if (media.edge_media_to_caption?.edges?.length > 0) {
                  result.caption = media.edge_media_to_caption.edges[0].node.text;
                }
                if (media.display_url) {
                  result.thumbnail = media.display_url;
                }
                break;
              }
            }
          }
        } catch (e) {
          console.warn('script parse error', e.message);
        }

        if (result.caption == null) {
          const ogTitle = document.querySelector('meta[property="og:title"]');
          if (ogTitle && ogTitle.content) {
            let c = ogTitle.content;
            const parts = c.split(' on Instagram: ');
            if (parts.length > 1) {
              c = parts[1];
            }
            c = c.replace(/^"|"$/g, '');
            result.caption = c;
          }
        }

        if (result.caption == null) {
          const capDiv = document.querySelector('div.C4VMK > span');
          if (capDiv) {
            result.caption = capDiv.innerText;
          }
        }

        return result;
      });

      console.log('[post-detail]', sc, detail);
      postDetails.push({ shortcode: sc, ...detail });
    } catch (e) {
      console.warn('[post error]', sc, e.message);
    }
  }

  await browser.close();

  const merged = normalized.posts.slice(0, sampleSize).map(r => {
    const sc = r.shortcode || r.id;
    const det = postDetails.find(d => d.shortcode === sc);
    return {
      id: sc,
      caption: det?.caption || null,
      thumbnail: det?.thumbnail || null,
      likes: r.likes,
      comments: r.comments
    };
  });

  const analytics = computeAnalytics(normalized.posts, normalized.followers, sampleSize);

  return {
    name: normalized.fullname,
    username: normalized.username,
    profile_picture: normalized.profile_pic,
    followers: normalized.followers,
    following: normalized.following,
    posts_count: normalized.posts_count,
    analytics,
    recent_posts: merged,
    _meta: { source: normalized._source, scraped_at: new Date().toISOString() }
  };
}

app.get('/api/profile/:username', async (req, res) => {
  const username = req.params.username;
  let sample = Number(req.query.posts) || DEFAULT_SAMPLE_SIZE;
  if (sample < 1) sample = DEFAULT_SAMPLE_SIZE;
  console.log(`[api] profile request for ${username} sample=${sample}`);
  if (!username) {
    return res.status(400).json({ error: 'username required' });
  }
  try {
    const result = await scrapeProfile(username, sample);
    return res.json(result);
  } catch (err) {
    console.error('[server error]', err.stack || err);
    return res.status(500).json({ error: err.message || 'unknown' });
  }
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT} — Brave path: ${BRAVE_PATH}`);  
});
