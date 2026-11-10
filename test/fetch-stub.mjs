// Preloaded into the server (node --import) to fake Overleaf's GET /user/projects.
globalThis.fetch = async () =>
  new Response(JSON.stringify({ projects: JSON.parse(process.env.STUB_PROJECTS) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
