import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildComments,
  locateComment,
  normalizeSessionCookie,
  maskSessionCookie,
  fetchOverleafJson,
  fetchComments,
} from '../overleaf-comments.js';

const mainTex = [
  '\\section{Intro}',
  'An address not so derived is not enumerated by the tally.',
  'The salt is random rather than merely non-empty.',
].join('\n');
const files = [
  { path: 'main.tex', content: mainTex },
  { path: 'refs.bib', content: '@misc{x, title={The salt is random}}' },
];

const threads = {
  t1: {
    messages: [
      { id: 'm1', content: 'Where is the check happening?', timestamp: 1758661140000, user_id: 'u1', user: { first_name: 'Ada', last_name: 'L', email: 'a@x' } },
      { id: 'm2', content: 'Lines 2-4.', timestamp: '2026-09-24T10:00:00.000Z', user_id: 'u2' },
    ],
  },
  t2: {
    messages: [{ id: 'm3', content: 'Who picks the salt?', timestamp: 1758661200000, user_id: 'u1', user: { name: 'Ada L' } }],
    resolved: true,
    resolved_at: '2026-09-25T00:00:00.000Z',
  },
  t3: { messages: [{ id: 'm4', content: 'Orphaned thread', timestamp: 0, user_id: 'u3' }] },
};

const offsetOf = s => mainTex.indexOf(s);
const ranges = [
  {
    id: 'doc1',
    ranges: {
      comments: [
        { id: 't1', op: { c: 'not enumerated by', p: offsetOf('not enumerated by'), t: 't1' } },
        { id: 't2', op: { c: 'The salt is random', p: offsetOf('The salt is random'), t: 't2' } },
        { id: 'gone', op: { c: 'Intro', p: offsetOf('Intro'), t: 'deleted-thread' } },
      ],
    },
  },
];

test('joins threads to their anchors with file and line', () => {
  const out = buildComments(threads, ranges, files);
  const t1 = out.find(c => c.threadId === 't1');
  assert.equal(t1.file, 'main.tex');
  assert.equal(t1.line, 2);
  assert.equal(t1.locationExact, true);
  assert.equal(t1.highlightedText, 'not enumerated by');
  assert.deepEqual(
    t1.messages.map(m => [m.author, m.content]),
    [['Ada L', 'Where is the check happening?'], ['u2', 'Lines 2-4.']]
  );
  assert.equal(t1.messages[0].timestamp, new Date(1758661140000).toISOString());
});

test('excludes resolved threads unless asked', () => {
  assert.equal(buildComments(threads, ranges, files).some(c => c.threadId === 't2'), false);
  const t2 = buildComments(threads, ranges, files, { includeResolved: true }).find(c => c.threadId === 't2');
  assert.equal(t2.resolved, true);
  assert.equal(t2.messages[0].author, 'Ada L');
  assert.equal(t2.file, 'main.tex'); // exact offset wins over the .bib occurrence
});

test('reports threads whose anchor was deleted, and skips ranges without a thread', () => {
  const out = buildComments(threads, ranges, files);
  const orphan = out.find(c => c.threadId === 't3');
  assert.equal(orphan.file, null);
  assert.equal(orphan.highlightedText, null);
  assert.equal(out.some(c => c.threadId === 'deleted-thread'), false);
  assert.equal(out[out.length - 1].threadId, 't3'); // unlocated threads sort last
});

test('falls back to a unique text match when the offset is stale', () => {
  const loc = locateComment(files, { c: 'not enumerated by', p: 0 });
  assert.deepEqual(loc, { file: 'main.tex', line: 2, exact: false });
  assert.equal(locateComment(files, { c: 'The salt is random', p: 0 }), null); // ambiguous
  assert.equal(locateComment(files, { c: 'absent', p: 0 }), null);
});

test('normalizes and masks the session cookie', () => {
  assert.equal(normalizeSessionCookie(' abc '), 'overleaf_session2=abc');
  assert.equal(normalizeSessionCookie('Cookie: overleaf_session2=abc'), 'overleaf_session2=abc');
  assert.equal(normalizeSessionCookie(''), '');
  assert.equal(maskSessionCookie('bad overleaf_session2=s%3Asecret; x'), 'bad overleaf_session2=***; x');
});

function fakeFetch(handler) {
  return async (url, init) => {
    const r = handler(String(url), init);
    return {
      status: r.status ?? 200,
      ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
      headers: new Map(Object.entries(r.headers ?? { 'content-type': 'application/json' })),
      json: async () => r.body,
    };
  };
}

test('fetches both endpoints with the cookie', async () => {
  const seen = [];
  const fetchImpl = fakeFetch((url, init) => {
    seen.push([url, init.headers.Cookie, init.redirect]);
    return { body: url.endsWith('/threads') ? threads : ranges };
  });
  const r = await fetchComments({ baseUrl: 'https://ol.test', projectId: 'p1', cookie: 'overleaf_session2=v', fetchImpl });
  assert.deepEqual(r.threads, threads);
  assert.deepEqual(r.ranges, ranges);
  assert.deepEqual(seen.map(s => s[0]).sort(), ['https://ol.test/project/p1/ranges', 'https://ol.test/project/p1/threads']);
  assert.ok(seen.every(s => s[1] === 'overleaf_session2=v' && s[2] === 'manual'));
});

test('treats a login redirect or an HTML page as an expired session', async () => {
  const redirect = fakeFetch(() => ({ status: 302, headers: { location: '/login?redir=x' } }));
  await assert.rejects(fetchOverleafJson('https://ol.test', '/project/p/threads', 'c', redirect), /session cookie/);
  const html = fakeFetch(() => ({ status: 200, headers: { 'content-type': 'text/html' } }));
  await assert.rejects(fetchOverleafJson('https://ol.test', '/project/p/threads', 'c', html), /session cookie/);
  await assert.rejects(fetchComments({ projectId: 'p', cookie: '' }), /needs an Overleaf session cookie/);
});
