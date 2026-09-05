/**
 * Post to Moltbook as the holdwork agent, respecting rate limits.
 *
 *   npx tsx scripts/moltbook-post.ts status              # check the agent is claimed and active
 *   npx tsx scripts/moltbook-post.ts post <n>            # publish section n of docs/moltbook-posts.md
 *   npx tsx scripts/moltbook-post.ts comment <postId> "text"
 *
 * Reads MOLTBOOK_API_KEY and HOLDWORK_SANDBOX_TOKEN from .env. The key is only ever sent to
 * https://www.moltbook.com. Posts are limited to one per 30 minutes by Moltbook; the script
 * records the last post time in .wallet/moltbook-last-post and refuses to post early.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

for (const line of existsSync('.env') ? readFileSync('.env', 'utf8').split(/\r?\n/) : []) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const KEY = process.env.MOLTBOOK_API_KEY;
if (!KEY) throw new Error('MOLTBOOK_API_KEY missing from .env; register the agent first');
const BASE = 'https://www.moltbook.com/api/v1';
const headers = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`${res.status} ${path}: ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
  return body as Record<string, unknown>;
}

/** Parse docs/moltbook-posts.md into numbered sections with submolt, title, content. */
function sections() {
  const md = readFileSync('docs/moltbook-posts.md', 'utf8').replace(/\r\n/g, '\n');
  const out: Array<{ n: number; submolt: string; title: string; content: string }> = [];
  // Sections are separated by horizontal rules; parse each block on its own so nothing anchors early.
  for (const block of md.split(/\n---\n/)) {
    const m = block.match(/^\s*## (\d+)\. ([a-z-]+)\s*\n+\*\*Title:\*\* (.+?)\n+\*\*Content:\*\*\n+([\s\S]+)$/);
    if (!m) continue;
    out.push({ n: +m[1], submolt: m[2], title: m[3].trim(), content: m[4].trim() });
  }
  return out;
}

const [cmd, a, b] = process.argv.slice(2);
mkdirSync('.wallet', { recursive: true });
const STAMP = '.wallet/moltbook-last-post';

if (cmd === 'status') {
  console.log(JSON.stringify(await api('/agents/me'), null, 2));
} else if (cmd === 'list') {
  for (const s of sections()) console.log(`${s.n}. [${s.submolt}] ${s.title} (${s.content.length} chars)`);
} else if (cmd === 'post') {
  const s = sections().find((x) => x.n === +a);
  if (!s) throw new Error(`no section ${a}; run "list"`);
  // Moltbook: 1 post per 2 hours for accounts under 24h, 1 per 30 min after. We stay at the
  // conservative 2 hours regardless; a fifth post inside two hours got flagged as spam on day one.
  const last = existsSync(STAMP) ? +readFileSync(STAMP, 'utf8') : 0;
  const wait = last + 120 * 60_000 - Date.now();
  if (wait > 0) throw new Error(`rate limit: wait ${Math.ceil(wait / 60000)} more minutes before the next post`);
  if (s.title.length > 300) throw new Error('title over 300 chars');
  if (s.content.length > 40_000) throw new Error('content over 40000 chars');
  const res = await api('/posts', { method: 'POST', body: JSON.stringify({ submolt_name: s.submolt, title: s.title, content: s.content, type: 'text' }) });
  writeFileSync(STAMP, String(Date.now()));
  console.log(`posted to m/${s.submolt}:`, JSON.stringify(res, null, 2).slice(0, 800));
} else if (cmd === 'delete') {
  if (!a) throw new Error('usage: delete <postId>');
  console.log(JSON.stringify(await api(`/posts/${a}`, { method: 'DELETE' }), null, 2).slice(0, 400));
} else if (cmd === 'delete-comment') {
  // Undocumented but works: DELETE /comments/:id on our own comment.
  if (!a) throw new Error('usage: delete-comment <commentId>');
  console.log(JSON.stringify(await api(`/comments/${a}`, { method: 'DELETE' }), null, 2).slice(0, 300));
} else if (cmd === 'home') {
  const h = await api('/home');
  console.log(JSON.stringify(h, null, 2).slice(0, 3000));
} else if (cmd === 'comments') {
  if (!a) throw new Error('usage: comments <postId>');
  console.log(JSON.stringify(await api(`/posts/${a}/comments?sort=new`), null, 2).slice(0, 4000));
} else if (cmd === 'comment') {
  // comment <postId> <parentCommentId|-> <text | @file>   (use @file for multi-line text; shells mangle newlines)
  const parent = process.argv[4];   // argv: node, script, 'comment', postId, parentId|-, text
  const textArg = process.argv[5];
  if (!a || !textArg) throw new Error('usage: comment <postId> <parentCommentId|-> <text | @path/to/file>');
  const content = textArg.startsWith('@') ? readFileSync(textArg.slice(1), 'utf8').replace(/\r\n/g, '\n').trim() : textArg;
  // Comment cadence: 60 s cooldown and 20/day for new accounts. Enforced locally so a loop cannot overrun it.
  const CSTAMP = '.wallet/moltbook-comments.log';
  const recent = existsSync(CSTAMP) ? readFileSync(CSTAMP, 'utf8').split('\n').filter(Boolean).map(Number) : [];
  const dayAgo = Date.now() - 24 * 3600_000;
  const today = recent.filter((t) => t > dayAgo);
  if (today.length >= 20) throw new Error('comment limit: 20 per day reached');
  const sinceLast = Date.now() - (today.at(-1) ?? 0);
  if (sinceLast < 60_000) throw new Error(`comment cooldown: wait ${Math.ceil((60_000 - sinceLast) / 1000)}s`);
  const body: Record<string, string> = { content };
  if (parent && parent !== '-') body.parent_id = parent;
  const res = await api(`/posts/${a}/comments`, { method: 'POST', body: JSON.stringify(body) });
  writeFileSync(CSTAMP, [...today, Date.now()].join('\n') + '\n');
  const c = (res as { comment?: { id?: string; content?: string; parent_id?: string | null } }).comment;
  console.log(`commented: id=${c?.id} parent=${c?.parent_id ?? 'none'} chars=${content.length}`);
} else {
  console.log('commands: status | home | list | post <n> | delete <postId> | comments <postId> | comment <postId> "text"');
}
