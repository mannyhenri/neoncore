/**
 * THE REDDIT SECTION WAS EMPTY EVERY MORNING.
 *
 * Reported as: "we need to find a way to get the latest popular news from reddit, there is
 * such a big community there." Both papers asked an agent to search Reddit for scores; reddit.com
 * answers a scripted JSON request with 403, so AI NOISE was empty on Sep 22, 24 and 26 and FILM
 * NOISE was empty on its first run. The fetch is now code (lib/reddit-pulse.ts):
 *
 *  - with credentials: the Reddit API, real scores;
 *  - without: ONE combined top-of-the-window RSS request (a second request is answered 429),
 *    ranked by Reddit, score and comments null — never estimated.
 *
 * And the film paper stopped dropping the week's best news for being more than 48 hours old.
 */
import './helpers/isolated-db.ts';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import {
  clearRedditCache, fetchRedditPulse, parseRedditRss, RedditUnavailable,
} from '../src/lib/reddit-pulse.ts';
import { renderDigestHtml, type DigestData } from '../src/lib/digest-template.ts';

beforeEach(() => clearRedditCache());

const RSS = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><author><name>/u/a</name></author><category term="aivideo" label="r/aivideo"/>
<content type="html">&lt;div&gt;Made with &lt;b&gt;Kling 3.0&lt;/b&gt; &amp;amp; Veo&lt;/div&gt; submitted by /u/a [link] [comments]</content>
<id>t3_1</id><link href="https://www.reddit.com/r/aivideo/comments/1/skinwalker/"/><published>2026-09-25T17:35:00+00:00</published>
<title>Skinwalker &amp; the &quot;Attack&quot;</title></entry>
<entry><category term="runwayml" label="r/runwayml"/><content type="html">Aleph in Resolve?</content>
<link href="https://www.reddit.com/r/runwayml/comments/2/aleph/"/><published>2026-09-26T06:16:00+00:00</published>
<title>Runway Aleph inside DaVinci Resolve is wild</title></entry>
</feed>`;

function fakeFetch(responses: Array<{ status: number; body: string }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected fetch ${url}`);
    return new Response(r.body, { status: r.status });
  }) as typeof fetch;
  return { impl, calls };
}

// ── The fetch ──────────────────────────────────────────────────────────────────────────

test('RSS is parsed in Reddit\'s order, entities decoded, numbers left null', () => {
  const t = parseRedditRss(RSS);
  assert.equal(t.length, 2);
  assert.deepEqual(t.map((x) => [x.rank, x.subreddit]), [[1, 'r/aivideo'], [2, 'r/runwayml']]);
  assert.equal(t[0].title, 'Skinwalker & the "Attack"');
  assert.equal(t[0].url, 'https://www.reddit.com/r/aivideo/comments/1/skinwalker/');
  assert.equal(t[0].snippet, 'Made with Kling 3.0 & Veo');
  assert.equal(t[0].score, null);
  assert.equal(t[0].comments, null);
});

test('without credentials: every subreddit goes in ONE request, because a second one is refused', async () => {
  const { impl, calls } = fakeFetch([{ status: 200, body: RSS }]);
  const p = await fetchRedditPulse(['aivideo', 'runwayml', 'VEO3'], 'day', 40, { fetchImpl: impl, env: {} });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/www\.reddit\.com\/r\/aivideo\+runwayml\+VEO3\/top\/\.rss\?t=day&limit=40$/);
  assert.equal(p.source, 'reddit-rss');
  assert.equal(p.threads.length, 2);

  // And a repeat inside the cache window does not spend the one request again.
  await fetchRedditPulse(['aivideo', 'runwayml', 'VEO3'], 'day', 40, { fetchImpl: impl, env: {} });
  assert.equal(calls.length, 1, 'a retry re-hit Reddit and would be rate-limited');
});

test('a 429 falls back to the last good answer, marked stale — and only while it is recent', async () => {
  let clock = Date.parse('2026-09-26T10:00:00Z');
  const now = () => clock;
  const { impl } = fakeFetch([{ status: 200, body: RSS }, { status: 429, body: '' }, { status: 429, body: '' }]);
  const opts = { fetchImpl: impl, env: {}, now };
  await fetchRedditPulse(['aivideo'], 'day', 10, opts);

  clock += 60 * 60_000; // an hour later: past the cache, inside the stale window
  const stale = await fetchRedditPulse(['aivideo'], 'day', 10, opts);
  assert.equal(stale.stale, true);
  assert.equal(stale.threads.length, 2);

  clock += 7 * 60 * 60_000; // too old to pass off as today's Reddit
  await assert.rejects(fetchRedditPulse(['aivideo'], 'day', 10, opts), RedditUnavailable);
});

test('a 429 is reported as unavailable, not as an empty day', async () => {
  const { impl } = fakeFetch([{ status: 429, body: '' }]);
  await assert.rejects(
    fetchRedditPulse(['aivideo'], 'day', 10, { fetchImpl: impl, env: {} }),
    (e: unknown) => e instanceof RedditUnavailable && e.status === 503 && /429/.test(e.message),
  );
});

test('with credentials: the Reddit API, and its real scores', async () => {
  const listing = { data: { children: [
    { data: { subreddit: 'aivideo', title: 'Seedance 2.5 test', score: 4210, num_comments: 388, permalink: '/r/aivideo/comments/9/x/', created_utc: 1790000000, selftext: 'notes' } },
  ] } };
  const { impl, calls } = fakeFetch([
    { status: 200, body: JSON.stringify({ access_token: 'tok' }) },
    { status: 200, body: JSON.stringify(listing) },
  ]);
  const p = await fetchRedditPulse(['aivideo', 'KlingAI_Videos'], 'day', 25,
    { fetchImpl: impl, env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec' } });
  assert.equal(calls[0].url, 'https://www.reddit.com/api/v1/access_token');
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, `Basic ${Buffer.from('id:sec').toString('base64')}`);
  assert.match(calls[1].url, /^https:\/\/oauth\.reddit\.com\/r\/aivideo\+KlingAI_Videos\/top\?t=day&limit=25/);
  assert.equal(p.source, 'reddit-api');
  assert.deepEqual(
    [p.threads[0].score, p.threads[0].comments, p.threads[0].url],
    [4210, 388, 'https://www.reddit.com/r/aivideo/comments/9/x/'],
  );
});

test('a subreddit name that is not one never reaches a URL', async () => {
  const { impl, calls } = fakeFetch([]);
  await assert.rejects(fetchRedditPulse(['aivideo/../../x'], 'day', 5, { fetchImpl: impl, env: {} }), RedditUnavailable);
  assert.equal(calls.length, 0);
});

// ── The paper ──────────────────────────────────────────────────────────────────────────

function day(noise: DigestData['aiNoise']): DigestData {
  return { edition: 'film', date: '2026-09-26', throughLine: 't', itemCount: 0,
    actOnIt: [], worthKnowing: [], background: [], dropped: [], aiNoise: noise };
}

test('with no scores the paper prints Reddit\'s rank, in rank order — never "0 points"', () => {
  const html = renderDigestHtml(day([
    { rank: 7, subreddit: 'r/runwayml', title: 'Second', score: null, comments: null, url: 'https://reddit.com/b', takeaway: '' },
    { rank: 2, subreddit: 'r/aivideo', title: 'First', score: null, comments: null, url: 'https://reddit.com/a', takeaway: '' },
  ]));
  assert.ok(!/\b0 points/.test(html), 'an unknown score was printed as zero');
  assert.ok(html.includes("#2 on Reddit's top list") && html.includes("#7 on Reddit's top list"));
  assert.ok(html.indexOf('First') < html.indexOf('Second'), 'rank 2 must come before rank 7');
});

test('with scores the paper still ranks by score and prints the numbers', () => {
  const html = renderDigestHtml(day([
    { subreddit: 'r/a', title: 'Low', score: 10, comments: 1, url: 'https://reddit.com/l', takeaway: '' },
    { subreddit: 'r/b', title: 'High', score: 900, comments: 50, url: 'https://reddit.com/h', takeaway: '' },
  ]));
  assert.ok(html.indexOf('High') < html.indexOf('Low'));
  assert.ok(html.includes('900 points · 50 comments'));
});

// ── The prompts ────────────────────────────────────────────────────────────────────────

function prompts(name: string): string {
  const tpl = db.prepare('SELECT id FROM workflows WHERE template_id IS NULL AND name = ?').get(name) as { id: string };
  return (db.prepare('SELECT executor_config FROM workflow_steps WHERE workflow_id = ?').all(tpl.id) as { executor_config: string }[])
    .map((r) => String(JSON.parse(r.executor_config).prompt ?? '')).join('\n');
}

test('both papers fetch Reddit from the endpoint instead of searching for it', () => {
  for (const name of ['Daily AI Research Digest', 'Daily AI Filmmaking Digest']) {
    const text = prompts(name);
    assert.match(text, /\/api\/digest\/reddit\?subs=[A-Za-z0-9_,]+&t=day/, `${name} does not call the Reddit endpoint`);
    assert.ok(!/(?<!Web)Search Reddit for/.test(text), `${name} still tells the agent to search Reddit`);
    assert.match(text, /null stays null|keep them null/, `${name} does not forbid estimating a missing score`);
  }
});

test('the film paper covers since the last edition, and age alone never drops an unreported item', () => {
  const text = prompts('Daily AI Filmmaking Digest');
  assert.ok(!/LAST 24-48 HOURS/.test(text), 'the film scan is still pinned to 48 hours');
  assert.match(text, /ALWAYS THE LAST 7 DAYS/);
  // The window must not shrink to "since the last edition": an item that fell between two
  // editions (Runway in Resolve, dropped twice for its date) would never run at all.
  assert.ok(!/window starts at the MOST RECENT date/i.test(text), 'the window still shrinks to the last edition');
  assert.match(text, /came out between two editions/);
  assert.match(text, /film-index\.md/);
  assert.match(text, /NEVER left out for its age/);
  assert.match(text, /"has not happened yet" are NOT drop reasons/);
  assert.match(text, /youtube\.com\/feeds\/videos\.xml/, 'Theoretically Media videos need a readable source');
});

test('a link post\'s snippet is empty, not Reddit\'s "submitted by … to r/x" boilerplate', () => {
  const xml = `<feed><entry><category term="aivideo"/><content type="html">&lt;a href="x"&gt;[link]&lt;/a&gt; submitted by /u/someone to r/aivideo [comments]</content>
<link href="https://www.reddit.com/r/aivideo/comments/3/x/"/><published>2026-09-26T00:00:00+00:00</published><title>Clip</title></entry></feed>`;
  assert.equal(parseRedditRss(xml)[0].snippet, '');
});
