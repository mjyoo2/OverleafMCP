// Drives the MCP server over stdio JSON-RPC with throwaway configs.
// Offline-safe except where noted: unreachable IDs fail at git.overleaf.com either way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'overleaf-mcp-server.js');
const UNREACHABLE = '000000000000000000000000';

function fixture(extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'olmcp-test-'));
  const file = path.join(dir, 'projects.json');
  const config = {
    projects: { paper: { name: 'Paper', projectId: 'aaaaaaaaaaaaaaaaaaaaaaaa', gitToken: 'olp_fake' } },
    ...extra,
  };
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  return { dir, file };
}

// Spawn the server, run initialize + one tools/call, return { result, stderr }.
function callTool(env, name, args = {}, nodeArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, SERVER], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timeout; stderr: ${stderr}`)); }, 60000);
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve({ result: msg.result, stderr });
        }
      }
    });
    child.on('exit', (code) => {
      if (code) { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr}`)); }
    });
    const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/call', params: { name, arguments: args } });
  });
}

const text = (r) => r.content.map((c) => c.text).join('');

test('unreachable project ID errors and leaves projects.json untouched', async () => {
  const { file } = fixture();
  const before = readFileSync(file);
  const { result } = await callTool({ OVERLEAF_PROJECTS_CONFIG: file }, 'list_files', { projectName: UNREACHABLE });
  assert.equal(result.isError, true);
  assert.match(text(result), new RegExp(`Overleaf project "${UNREACHABLE}" is not reachable with the configured git token`));
  assert.doesNotMatch(text(result), /olp_fake/);
  assert.deepEqual(readFileSync(file), before);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('a name that is not a project ID is still "not found"', async () => {
  const { file } = fixture();
  const { result } = await callTool({ OVERLEAF_PROJECTS_CONFIG: file }, 'list_files', { projectName: 'paper2' });
  assert.equal(result.isError, true);
  assert.match(text(result), /Project "paper2" not found in configuration/);
});

test('env-var mode never writes a config file', async () => {
  const { dir } = fixture();
  const xdg = path.join(dir, 'xdg');
  const { result } = await callTool(
    { OVERLEAF_PROJECT_ID: 'aaaaaaaaaaaaaaaaaaaaaaaa', OVERLEAF_GIT_TOKEN: 'olp_fake', XDG_CONFIG_HOME: xdg },
    'list_files',
    { projectName: UNREACHABLE }
  );
  assert.match(text(result), /is not reachable/);
  assert.equal(existsSync(path.join(xdg, 'overleaf-mcp', 'projects.json')), false);
});

test('list_projects lists configured keys', async () => {
  const { file } = fixture();
  const { result } = await callTool({ OVERLEAF_PROJECTS_CONFIG: file }, 'list_projects');
  assert.deepEqual(JSON.parse(text(result)).map((p) => p.id), ['paper']);
});

test('list_overleaf_projects without a cookie explains how to add one', async () => {
  const { file } = fixture();
  const { result } = await callTool({ OVERLEAF_PROJECTS_CONFIG: file }, 'list_overleaf_projects');
  assert.equal(result.isError, true);
  assert.match(text(result), /No Overleaf session cookie configured.*OVERLEAF_SESSION_COOKIE/s);
});

test('an invalid cookie reports expiry and never echoes the cookie', { skip: process.env.OFFLINE === '1' }, async () => {
  const secret = 'bogus-secret-xyz';
  const { file } = fixture({ sessionCookie: `overleaf_session2=${secret}` });
  const { result, stderr } = await callTool({ OVERLEAF_PROJECTS_CONFIG: file }, 'list_overleaf_projects', { sync: true });
  assert.equal(result.isError, true);
  assert.match(text(result), /Overleaf session cookie expired — copy a fresh overleaf_session2 from your browser/);
  assert.doesNotMatch(text(result) + stderr, new RegExp(secret));
});

test('sync adds only missing projects, renames ID placeholders, keeps file mode 600', async () => {
  const placeholder = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const { file } = fixture({ sessionCookie: 'stub' });
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  cfg.projects.paper.name = 'My own name';
  cfg.projects[placeholder] = { name: placeholder, projectId: placeholder, gitToken: 'olp_fake' };
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  const remote = [
    { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Remote name', accessLevel: 'owner' },
    { _id: placeholder, name: 'Real B', accessLevel: 'readAndWrite' },
    { _id: 'cccccccccccccccccccccccc', name: 'New C', accessLevel: 'owner' },
  ];
  const stub = path.join(path.dirname(SERVER), 'test', 'fetch-stub.mjs');
  const { result } = await callTool(
    { OVERLEAF_PROJECTS_CONFIG: file, STUB_PROJECTS: JSON.stringify(remote) },
    'list_overleaf_projects', { sync: true }, ['--import', stub]
  );
  assert.equal(result.isError, undefined, text(result));
  const out = JSON.parse(text(result));
  assert.deepEqual([out.added, out.renamed], [1, 1]);
  assert.deepEqual(out.projects.map((p) => p.configuredAs), ['paper', placeholder, 'cccccccccccccccccccccccc']);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.projects.paper.name, 'My own name');
  assert.equal(saved.projects[placeholder].name, 'Real B');
  assert.deepEqual(saved.projects.cccccccccccccccccccccccc, { name: 'New C', projectId: 'cccccccccccccccccccccccc', gitToken: 'olp_fake' });
  assert.equal(saved.sessionCookie, 'stub');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
