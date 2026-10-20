/**
 * WHAT REDDIT IS TALKING ABOUT, fetched by code rather than searched for by an agent.
 *
 * Both daily papers have a Reddit section, and it came back empty on every run: reddit.com
 * answers an unauthenticated JSON request with 403, a mirror rate-limits, and a web search
 * cannot see a thread's score. The agent was right to leave the section empty rather than
 * guess — but a section that is empty every morning is a section that does not exist.
 *
 * Two sources, best first:
 *
 *  1. THE REDDIT API (app-only OAuth). Real scores and comment counts. Needs a free "script"
 *     app: REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in the server's environment.
 *  2. THE TOP-OF-THE-DAY RSS FEED. No credentials, and already ranked by Reddit's own score,
 *     but it carries no numbers — so `score` and `comments` are null, never estimated, and
 *     `rank` is the popularity signal. Unauthenticated RSS allows roughly ONE request before
 *     it answers 429, which is why every subreddit goes into a single `r/a+b+c` request and
 *     results are cached.
 */

export interface RedditThread {
  /** 1 = most popular in the window across every requested subreddit. */
  rank: number;
  subreddit: string;
  title: string;
  /** Null when the source cannot see it (RSS). Never a guess. */
  score: number | null;
  comments: number | null;
  url: string;
  created: string;
  /** The start of the post body or link, so a takeaway can be written without opening it. */
  snippet: string;
}

export interface RedditPulse {
  source: 'reddit-api' | 'reddit-rss';
  window: RedditWindow;
  subreddits: string[];
  fetchedAt: string;
  /** True when Reddit refused (429) and this is the last good answer, up to STALE_MS old. */
  stale?: boolean;
  threads: RedditThread[];
}

export const REDDIT_WINDOWS = ['day', 'week'] as const;
export type RedditWindow = typeof REDDIT_WINDOWS[number];

/** Reddit's own rule for a subreddit name. Anything else never reaches a URL. */
export const SUBREDDIT_NAME = /^[A-Za-z0-9_]{2,21}$/;

const USER_AGENT = 'neoncore-digest/1.0 (daily reading digest)';
const CACHE_MS = 15 * 60_000;
/**
 * A refused request falls back to the last good answer this old. Unauthenticated RSS allows
 * about one request every few minutes, so without this a second run in the same morning —
 * a retry, a re-run, the other paper — loses its Reddit section to a 429.
 */
const STALE_MS = 6 * 60 * 60_000;
const cache = new Map<string, { at: number; pulse: RedditPulse }>();

export class RedditUnavailable extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

type Fetch = typeof fetch;

export async function fetchRedditPulse(
  subreddits: string[],
  window: RedditWindow,
  limit: number,
  opts: { fetchImpl?: Fetch; env?: NodeJS.ProcessEnv; now?: () => number } = {},
): Promise<RedditPulse> {
  const doFetch = opts.fetchImpl ?? fetch;
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const subs = [...new Set(subreddits)];
  if (subs.length === 0 || !subs.every((s) => SUBREDDIT_NAME.test(s))) {
    throw new RedditUnavailable('subreddit names must match [A-Za-z0-9_]{2,21}', 400);
  }
  const n = Math.max(1, Math.min(100, Math.floor(limit) || 25));
  const useApi = !!(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET);
  const key = `${useApi ? 'api' : 'rss'}|${subs.join('+').toLowerCase()}|${window}|${n}`;
  const hit = cache.get(key);
  if (hit && now() - hit.at < CACHE_MS) return hit.pulse;

  let threads: RedditThread[];
  try {
    threads = useApi
      ? await viaApi(doFetch, env, subs, window, n)
      : await viaRss(doFetch, subs, window, n);
  } catch (err) {
    if (hit && now() - hit.at < STALE_MS) return { ...hit.pulse, stale: true };
    throw err;
  }
  const pulse: RedditPulse = {
    source: useApi ? 'reddit-api' : 'reddit-rss',
    window, subreddits: subs, fetchedAt: new Date(now()).toISOString(), threads,
  };
  cache.set(key, { at: now(), pulse });
  return pulse;
}

/** Test seam: a cached answer must not leak between cases. */
export function clearRedditCache(): void { cache.clear(); }

async function viaApi(doFetch: Fetch, env: NodeJS.ProcessEnv, subs: string[], window: RedditWindow, n: number) {
  const basic = Buffer.from(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`).toString('base64');
  const tokRes = await doFetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!tokRes.ok) throw new RedditUnavailable(`reddit token request answered ${tokRes.status} — check REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET`, 502);
  const token = ((await tokRes.json()) as { access_token?: string }).access_token;
  if (!token) throw new RedditUnavailable('reddit token response had no access_token', 502);

  const res = await doFetch(`https://oauth.reddit.com/r/${subs.join('+')}/top?t=${window}&limit=${n}&raw_json=1`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT },
  });
  if (!res.ok) throw new RedditUnavailable(`reddit API answered ${res.status}`, 502);
  const body = (await res.json()) as { data?: { children?: { data: Record<string, unknown> }[] } };
  return (body.data?.children ?? []).map((c, i): RedditThread => {
    const d = c.data;
    return {
      rank: i + 1,
      subreddit: `r/${String(d.subreddit ?? '')}`,
      title: String(d.title ?? ''),
      score: Number.isFinite(d.score) ? Number(d.score) : null,
      comments: Number.isFinite(d.num_comments) ? Number(d.num_comments) : null,
      url: `https://www.reddit.com${String(d.permalink ?? '')}`,
      created: new Date(Number(d.created_utc ?? 0) * 1000).toISOString(),
      snippet: clip(String(d.selftext || d.url || '')),
    };
  });
}

async function viaRss(doFetch: Fetch, subs: string[], window: RedditWindow, n: number) {
  const res = await doFetch(`https://www.reddit.com/r/${subs.join('+')}/top/.rss?t=${window}&limit=${n}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36' },
  });
  if (res.status === 429) {
    throw new RedditUnavailable('reddit rate-limited the RSS feed (429). Try again in a few minutes, or set REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET for the API', 503);
  }
  if (!res.ok) throw new RedditUnavailable(`reddit RSS answered ${res.status}`, 502);
  return parseRedditRss(await res.text()).slice(0, n);
}

/** Exported for tests. Reddit's Atom feed, entries in the order Reddit ranked them. */
export function parseRedditRss(xml: string): RedditThread[] {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  return entries.map((e, i) => {
    const pick = (re: RegExp) => decode(e.match(re)?.[1] ?? '');
    const sub = pick(/<category[^>]*\bterm="([^"]*)"/);
    return {
      rank: i + 1,
      subreddit: sub ? `r/${sub}` : '',
      title: pick(/<title>([\s\S]*?)<\/title>/),
      score: null,
      comments: null,
      url: pick(/<link[^>]*\bhref="([^"]*)"/),
      created: pick(/<published>([\s\S]*?)<\/published>/),
      snippet: clip(decode(pick(/<content[^>]*>([\s\S]*?)<\/content>/)).replace(/<[^>]+>/g, ' ')),
    };
  }).filter((t) => t.title && t.url);
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, ' ')
    .replace(/\[link\]|\[comments\]|submitted by\s+\/u\/\S+(\s+to\s+r\/\S+)?/g, '')
    .replace(/^\s*to\s+r\/\S+\s*$/, '').trim();
  return t.length > 280 ? `${t.slice(0, 279)}…` : t;
}
