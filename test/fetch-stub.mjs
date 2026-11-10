// Preloaded into the server (node --import) to fake Overleaf's GET /user/projects.
// STUB_PROJECTS: JSON array to return. STUB_STATUS / STUB_HTML: simulate a logged-out session.
// STUB_SEEN: file path where the received Cookie header is written.
import { writeFileSync } from 'node:fs';

globalThis.fetch = async (_url, opts = {}) => {
  if (process.env.STUB_SEEN) writeFileSync(process.env.STUB_SEEN, opts.headers?.Cookie ?? '');
  if (process.env.STUB_STATUS) {
    return new Response(null, { status: Number(process.env.STUB_STATUS), headers: { location: '/login' } });
  }
  if (process.env.STUB_HTML) {
    return new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  }
  return new Response(JSON.stringify({ projects: JSON.parse(process.env.STUB_PROJECTS) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
