// Read review comments from an Overleaf project.
//
// Comments are not part of the Git bridge, so they cannot be reached with a
// Git token. They are served by two endpoints of the Overleaf web app — the
// same ones the editor's review panel calls — which require a logged-in
// browser session:
//
//   GET /project/:id/threads  -> { [threadId]: { messages: [...], resolved?, resolved_at?, ... } }
//   GET /project/:id/ranges   -> [ { id: docId, ranges: { comments: [ { id, op: { c, p, t } } ] } } ]
//
// `op.t` is the thread id, `op.c` the highlighted text, `op.p` its character
// offset in the document. The ranges endpoint identifies documents by id, not
// path, so the file is recovered by matching the highlighted text against the
// Git checkout the rest of the server already keeps.
//
// These are internal endpoints of overleaf.com, not a published API, and may
// change without notice.

export const DEFAULT_BASE_URL = 'https://www.overleaf.com';
const SESSION_COOKIE_NAME = 'overleaf_session2';

// Accept either a bare cookie value or a full "name=value" pair.
export function normalizeSessionCookie(raw) {
  const value = String(raw ?? '').trim().replace(/^cookie:\s*/i, '');
  if (!value) return '';
  return value.includes('=') ? value : `${SESSION_COOKIE_NAME}=${value}`;
}

// Strip session cookie values from any string that may reach output.
export function maskSessionCookie(s) {
  return String(s ?? '').replace(/(overleaf_session2?=)[^;\s"']+/g, '$1***');
}

function authorName(message) {
  const u = message.user;
  if (u) {
    if (u.name) return u.name;
    const full = [u.first_name, u.last_name].filter(Boolean).join(' ');
    if (full) return full;
    if (u.email) return u.email;
  }
  return message.user_id ?? 'unknown';
}

function toIso(ts) {
  if (ts == null) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toISOString();
}

function lineOf(content, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

// Find the file a comment belongs to. An exact hit at the recorded offset is
// authoritative; otherwise fall back to a unique occurrence of the text
// (the checkout can lag the live document by a few edits).
export function locateComment(files, op) {
  const text = op?.c ?? '';
  if (!text) return null;
  for (const f of files) {
    if (f.content.substr(op.p, text.length) === text) {
      return { file: f.path, line: lineOf(f.content, op.p), exact: true };
    }
  }
  const hits = [];
  for (const f of files) {
    let idx = f.content.indexOf(text);
    while (idx !== -1 && hits.length < 2) {
      hits.push({ file: f.path, line: lineOf(f.content, idx), exact: false });
      idx = f.content.indexOf(text, idx + 1);
    }
    if (hits.length > 1) break;
  }
  return hits.length === 1 ? hits[0] : null;
}

// Join threads and ranges into a flat, readable list. Pure: no I/O.
//   threads: response of /threads
//   ranges:  response of /ranges
//   files:   [{ path, content }] from the Git checkout
export function buildComments(threads, ranges, files, { includeResolved = false } = {}) {
  const threadMap = threads ?? {};
  const out = [];
  const anchored = new Set();

  for (const doc of ranges ?? []) {
    for (const comment of doc?.ranges?.comments ?? []) {
      const op = comment.op ?? {};
      const threadId = op.t ?? comment.id;
      anchored.add(threadId);
      const thread = threadMap[threadId];
      if (!thread) continue; // range left behind by a deleted thread
      if (thread.resolved && !includeResolved) continue;
      const loc = locateComment(files, op);
      out.push({
        threadId,
        docId: doc.id,
        file: loc?.file ?? null,
        line: loc?.line ?? null,
        locationExact: loc?.exact ?? false,
        offset: op.p ?? null,
        highlightedText: op.c ?? '',
        resolved: Boolean(thread.resolved),
        messages: (thread.messages ?? []).map(m => ({
          author: authorName(m),
          timestamp: toIso(m.timestamp),
          content: m.content ?? '',
        })),
      });
    }
  }

  // Threads whose anchor text was deleted have no range. Report them anyway:
  // the conversation is still there in the review panel.
  for (const [threadId, thread] of Object.entries(threadMap)) {
    if (anchored.has(threadId)) continue;
    if (thread.resolved && !includeResolved) continue;
    out.push({
      threadId,
      docId: null,
      file: null,
      line: null,
      locationExact: false,
      offset: null,
      highlightedText: null,
      resolved: Boolean(thread.resolved),
      messages: (thread.messages ?? []).map(m => ({
        author: authorName(m),
        timestamp: toIso(m.timestamp),
        content: m.content ?? '',
      })),
    });
  }

  out.sort((a, b) => {
    if (a.file !== b.file) return a.file == null ? 1 : b.file == null ? -1 : a.file < b.file ? -1 : 1;
    return (a.offset ?? Infinity) - (b.offset ?? Infinity);
  });
  return out;
}

// GET a JSON endpoint of the Overleaf web app with the session cookie.
// A missing or expired session is answered with a redirect to /login or an
// HTML page rather than a 401, so both are treated as an auth failure.
export async function fetchOverleafJson(baseUrl, urlPath, cookie, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(new URL(urlPath, baseUrl), {
    headers: { Cookie: cookie, Accept: 'application/json' },
    redirect: 'manual',
  });
  const location = res.headers.get('location') ?? '';
  const type = res.headers.get('content-type') ?? '';
  if (
    res.status === 401 ||
    res.status === 403 ||
    (res.status >= 300 && res.status < 400 && /login/.test(location)) ||
    (res.ok && !type.includes('json'))
  ) {
    throw new Error(
      `Overleaf rejected the session cookie for ${urlPath} (HTTP ${res.status}). ` +
        'It has probably expired: copy a fresh overleaf_session2 cookie from a logged-in browser.'
    );
  }
  if (!res.ok) {
    throw new Error(`Overleaf returned HTTP ${res.status} for ${urlPath}`);
  }
  return res.json();
}

export async function fetchComments({ baseUrl = DEFAULT_BASE_URL, projectId, cookie, fetchImpl }) {
  if (!cookie) {
    throw new Error(
      'get_comments needs an Overleaf session cookie: set OVERLEAF_SESSION_COOKIE ' +
        '(or OVERLEAF_SESSION_COOKIE_FILE), or "sessionCookie" for the project in projects.json.'
    );
  }
  const id = encodeURIComponent(projectId);
  const [threads, ranges] = await Promise.all([
    fetchOverleafJson(baseUrl, `/project/${id}/threads`, cookie, fetchImpl),
    fetchOverleafJson(baseUrl, `/project/${id}/ranges`, cookie, fetchImpl),
  ]);
  return { threads, ranges };
}
