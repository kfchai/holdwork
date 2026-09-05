/**
 * Moltbook watcher: one digest of everything that needs a human-quality response.
 *
 *   npx tsx scripts/moltbook-watch.ts            # print digest, update seen-state
 *   npx tsx scripts/moltbook-watch.ts --dry      # print digest, do not update state
 *
 * Collects:
 *   1. New comments on our posts (full text, threaded) since the last run.
 *   2. Replies to our comments elsewhere.
 *   3. New posts matching our topics, created since the last run, that we have not commented on,
 *      with the top comments so a reply can engage what was actually said.
 * State in .wallet/moltbook-seen.json. The key only ever goes to moltbook.com.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

for (const line of existsSync('.env') ? readFileSync('.env', 'utf8').split(/\r?\n/) : []) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const KEY = process.env.MOLTBOOK_API_KEY;
if (!KEY) throw new Error('MOLTBOOK_API_KEY missing');
const BASE = 'https://www.moltbook.com/api/v1';
const ME = 'holdwork';
const DRY = process.argv.includes('--dry');
const STATE = '.wallet/moltbook-seen.json';

const QUERIES = [
  'escrow', 'agent payments', 'x402', 'spend policy', 'agent commerce', 'verify agent output',
  'paid for bad output', 'agent marketplace trust', 'dispute resolution agents', 'seller reputation agents',
];
const RELEVANT = /escrow|payment|x402|spend|budget|commerce|marketplace|dispute|verif|reputation|settle|invoice|refund|trust|deliver/i;

interface State { lastRun: number; seenComments: string[]; seenPosts: string[]; commentedPosts: string[]; myPosts: string[] }
const state: State = existsSync(STATE)
  ? { myPosts: [], ...JSON.parse(readFileSync(STATE, 'utf8')) }
  : { lastRun: Date.now() - 24 * 3600_000, seenComments: [], seenPosts: [], commentedPosts: [], myPosts: [] };
// WATCH_SINCE_HOURS=72 widens the lookback for a run (testing, or after a gap).
if (process.env.WATCH_SINCE_HOURS) state.lastRun = Date.now() - Number(process.env.WATCH_SINCE_HOURS) * 3600_000;
const seenC = new Set(state.seenComments), seenP = new Set(state.seenPosts), mine = new Set(state.commentedPosts);
const myPostIds = new Set(state.myPosts);
// Our own posts: whatever the poster logged, plus anything the home feed reports activity on.
if (existsSync('.moltbook-post-all.log')) {
  const log = readFileSync('.moltbook-post-all.log', 'utf8');
  for (const m of log.matchAll(/posted to m\/[a-z-]+: \{\s*"success": true,[\s\S]*?"id": "([a-f0-9-]{36})"/g)) myPostIds.add(m[1]);
}

async function api(path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<Record<string, unknown>>;
}
type Comment = { id: string; content: string; parent_id?: string | null; created_at: string; author: { name: string; karma: number }; replies?: Comment[] };
type Post = { id: string; title: string; content?: string; created_at: string; score?: number; comment_count?: number; submolt_name?: string; submolt?: { name: string }; author?: { name: string } };
const flat = (cs: Comment[]): Comment[] => cs.flatMap((c) => [c, ...flat(c.replies ?? [])]);
const clip = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

const out: string[] = [];
const now = new Date().toISOString();
out.push(`# Moltbook digest ${now}  (since ${new Date(state.lastRun).toISOString()})`);

// 1. Our posts and new comments on them.
const meRes = await api(`/agents/me`).catch(() => null);
const home = await api('/home');
const acct = (home.your_account as { karma: number; unread_notification_count: number }) ?? { karma: 0, unread_notification_count: 0 };
out.push(`karma ${acct.karma} | unread ${acct.unread_notification_count}${meRes ? '' : ' | (agents/me unavailable)'}`);

for (const a of (home.activity_on_your_posts as Array<{ post_id: string }> | undefined) ?? []) myPostIds.add(a.post_id);
const newOnMine: string[] = [];
for (const pid of myPostIds) {
  const post = ((await api(`/posts/${pid}`).catch(() => null)) as { post?: Post } | null)?.post;
  if (!post) continue;
  const cs = flat((((await api(`/posts/${pid}/comments?sort=new&limit=50`).catch(() => ({ comments: [] }))).comments as Comment[]) ?? []));
  for (const c of cs) {
    if (c.author.name === ME || seenC.has(c.id)) continue;
    newOnMine.push(`- on "${clip(post.title, 60)}" (post ${pid})\n  ${c.author.name} (karma ${c.author.karma}) comment ${c.id}${c.parent_id ? ` reply-to ${c.parent_id}` : ''}:\n  ${clip(c.content, 900)}`);
    if (!DRY) seenC.add(c.id);
  }
}
out.push(`\n## New comments on our posts (${newOnMine.length})`);
out.push(newOnMine.length ? newOnMine.join('\n') : '(none)');

// 2. Replies to our comments on other posts.
const repliesToUs: string[] = [];
for (const pid of mine) {
  const cs = flat(((await api(`/posts/${pid}/comments?sort=new&limit=100`).catch(() => ({ comments: [] }))).comments as Comment[]) ?? []);
  const ours = new Set(cs.filter((c) => c.author.name === ME).map((c) => c.id));
  for (const c of cs) {
    if (c.author.name === ME || seenC.has(c.id) || !c.parent_id || !ours.has(c.parent_id)) continue;
    repliesToUs.push(`- post ${pid}, ${c.author.name} (karma ${c.author.karma}) comment ${c.id} replying to ours:\n  ${clip(c.content, 900)}`);
    if (!DRY) seenC.add(c.id);
  }
}
out.push(`\n## Replies to our comments elsewhere (${repliesToUs.length})`);
out.push(repliesToUs.length ? repliesToUs.join('\n') : '(none)');

// 3. New relevant posts: recent posts in the submolts we care about, plus keyword search.
const SUBMOLTS = ['agentfinance', 'agentcommerce', 'agents', 'infrastructure', 'builds', 'tooling'];
const found = new Map<string, Post>();
for (const sm of SUBMOLTS) {
  const r = (await api(`/submolts/${sm}/feed?sort=new&limit=25`).catch(() => ({}))) as Record<string, unknown>;
  for (const p of ((r.posts as Post[] | undefined) ?? [])) {
    if (!p?.id || !p.title || seenP.has(p.id) || mine.has(p.id) || p.author?.name === ME || myPostIds.has(p.id)) continue;
    const created = p.created_at ? Date.parse(p.created_at) : NaN;
    if (!Number.isNaN(created) && created < state.lastRun - 6 * 3600_000) continue;
    if (!RELEVANT.test(`${p.title} ${p.content ?? ''}`)) continue;
    found.set(p.id, { ...p, submolt: p.submolt ?? { name: sm } });
  }
}
for (const q of QUERIES) {
  const r = (await api(`/search?q=${encodeURIComponent(q)}&limit=10`).catch(() => ({}))) as Record<string, unknown>;
  type Hit = Post & { type?: string; upvotes?: number; downvotes?: number; post_id?: string };
  const arr = ((r.results ?? r.posts ?? r.data) as Hit[] | undefined) ?? [];
  for (const hit of arr) {
    // A comment hit points at its post; a post hit is the post. Highlight markers are stripped.
    const pid = hit.type === 'comment' ? hit.post_id : hit.id;
    if (!pid) continue;
    const p: Post = {
      id: pid, title: hit.type === 'comment' ? (hit as { post?: Post }).post?.title ?? '(comment hit)' : hit.title,
      content: (hit.content ?? '').replace(/⟦\/?HL⟧/g, ''), created_at: hit.created_at,
      score: (hit.upvotes ?? 0) - (hit.downvotes ?? 0), submolt: hit.submolt, author: hit.author,
    };
    if (!p.id || !p.title) continue;
    // Search results do not always carry created_at. When they do, skip anything older than the
    // last run (with overlap); when they do not, let seenPosts dedupe across runs instead.
    const created = p.created_at ? Date.parse(p.created_at) : NaN;
    if (!Number.isNaN(created) && created < state.lastRun - 6 * 3600_000) continue;
    if (seenP.has(p.id) || mine.has(p.id) || p.author?.name === ME) continue;
    if (!RELEVANT.test(`${p.title} ${p.content ?? ''}`)) continue;
    found.set(p.id, p);
  }
}
const candidates: string[] = [];
for (const p of [...found.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 8)) {
  const cs = (((await api(`/posts/${p.id}/comments?sort=best&limit=4`).catch(() => ({ comments: [] }))).comments as Comment[]) ?? []);
  candidates.push(
    `- [${p.submolt_name ?? p.submolt?.name ?? '?'}] "${p.title}" by ${p.author?.name ?? '?'} | score ${p.score ?? 0} | ${p.comment_count ?? cs.length} comments | ${p.created_at?.slice(0, 16)} | post ${p.id}\n  ${clip(p.content ?? '', 700)}` +
      cs.map((c) => `\n    > ${c.author.name}: ${clip(c.content, 220)}`).join(''),
  );
  if (!DRY) seenP.add(p.id);
}
out.push(`\n## New relevant threads (${candidates.length})`);
out.push(candidates.length ? candidates.join('\n') : '(none)');

if (!DRY) {
  writeFileSync(STATE, JSON.stringify({ lastRun: Date.now(), seenComments: [...seenC].slice(-2000), seenPosts: [...seenP].slice(-2000), commentedPosts: [...mine], myPosts: [...myPostIds] }, null, 2));
}
console.log(out.join('\n'));
