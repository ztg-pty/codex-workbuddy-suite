import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { inflateRawSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let implementation = {};
try { implementation = await import('../src/mcp.mjs'); } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}
const handler = (options) => {
  assert.equal(typeof implementation.createMcpHandler, 'function', 'MCP handler must be implemented');
  return implementation.createMcpHandler(options);
};
const rpc = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
async function connection(t, url = 'http://127.0.0.1:32456') {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'workbuddy-mcp-test-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await writeFile(path.join(stateDir, 'connection.json'), JSON.stringify({ url, key: 'local-test-service-key' }));
  return stateDir;
}
const decoded = (result) => JSON.parse(result.result.content[0].text);

test('MCP initialize advertises only tool capability and ping succeeds', async () => {
  const call = handler({ mode: 'connect' });
  const initialized = await call(rpc('initialize', { protocolVersion: '2025-06-18' }));
  assert.equal(initialized.jsonrpc, '2.0');
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  assert.deepEqual(initialized.result.capabilities, { tools: { listChanged: false } });
  assert.deepEqual((await call(rpc('ping'))).result, {});
  assert.equal(await call({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('connect and checkin modes expose separate workflows', async () => {
  const connect = (await handler({ mode: 'connect' })(rpc('tools/list'))).result.tools;
  const checkin = (await handler({ mode: 'checkin' })(rpc('tools/list'))).result.tools;
  assert.deepEqual(connect.map((tool) => tool.name), ['workbuddy_status', 'workbuddy_accounts', 'workbuddy_models']);
  assert.deepEqual(checkin.map((tool) => tool.name), ['workbuddy_checkin_status', 'workbuddy_checkin']);
  assert.equal(connect.every((tool) => tool.annotations.readOnlyHint), true);
  assert.equal(checkin[1].annotations.readOnlyHint, false);
});

test('model lookup uses authenticated loopback GET and preserves official model names', async (t) => {
  const stateDir = await connection(t);
  const requests = [];
  const call = handler({ mode: 'connect', stateDir, fetchImpl: async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ models: [{ id: 'workbuddy-intl/claude-opus-4-1', officialName: 'Claude Opus 4.1' }] }));
  } });
  const result = await call(rpc('tools/call', { name: 'workbuddy_models', arguments: { region: 'intl' } }));
  assert.equal(requests[0].url, 'http://127.0.0.1:32456/models?region=intl');
  assert.equal(requests[0].init.method, 'GET');
  assert.equal(requests[0].init.headers['x-workbuddy-key'], 'local-test-service-key');
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(decoded(result).models[0].officialName, 'Claude Opus 4.1');
});

test('CN checkin status is read-only and checkin executes one POST', async (t) => {
  const stateDir = await connection(t);
  const requests = [];
  const call = handler({ mode: 'checkin', stateDir, fetchImpl: async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ region: 'cn', checkedIn: true }));
  } });
  await call(rpc('tools/call', { name: 'workbuddy_checkin_status', arguments: {} }));
  await call(rpc('tools/call', { name: 'workbuddy_checkin', arguments: {} }));
  assert.deepEqual(requests.map(({ url, init }) => [url, init.method]), [
    ['http://127.0.0.1:32456/checkin-status', 'GET'],
    ['http://127.0.0.1:32456/checkin', 'POST'],
  ]);
  assert.deepEqual(JSON.parse(requests[1].init.body), {});
});

test('MCP rejects wrong workflow, unknown method, and invalid arguments without network calls', async () => {
  let requests = 0;
  const call = handler({ mode: 'connect', fetchImpl: async () => { requests++; throw new Error('unexpected request'); } });
  assert.equal((await call(rpc('missing'))).error.code, -32601);
  assert.equal((await call(rpc('tools/call', { name: 'workbuddy_checkin', arguments: {} }))).error.code, -32602);
  assert.equal((await call(rpc('tools/call', { name: 'workbuddy_models', arguments: { region: 'wrong' } }))).error.code, -32602);
  assert.equal((await call(rpc('tools/call', { name: 'workbuddy_status', arguments: { secret: 'x' } }))).error.code, -32602);
  assert.equal(requests, 0);
});

test('MCP refuses off-machine connection URLs before fetching', async (t) => {
  for (const url of ['https://example.com', 'http://127.0.0.1.evil.example', 'http://user:pass@localhost:32100', 'http://localhost:32100/base', 'http://localhost:32100/?secret=x']) {
    const stateDir = await connection(t, url);
    let requests = 0;
    const result = await handler({ mode: 'connect', stateDir, fetchImpl: async () => { requests++; } })(rpc('tools/call', { name: 'workbuddy_status' }));
    assert.equal(result.result.isError, true);
    assert.equal(requests, 0);
    assert.match(result.result.content[0].text, /本机|loopback/i);
  }
});

test('MCP removes account credentials, service keys, and bearer values from tool output', async (t) => {
  const stateDir = await connection(t);
  const call = handler({ mode: 'connect', stateDir, fetchImpl: async () => new Response(JSON.stringify({
    balance: 40, key: 'local-test-service-key', accessToken: 'account-secret', refresh_token: 'refresh-secret',
    nested: { authorization: 'Bearer bearer-secret', officialName: 'GPT-5' },
    message: 'Bearer bearer-secret local-test-service-key',
  })) });
  const result = await call(rpc('tools/call', { name: 'workbuddy_accounts' }));
  const value = decoded(result);
  assert.equal(value.balance, 40);
  assert.equal(value.nested.officialName, 'GPT-5');
  assert.doesNotMatch(JSON.stringify(result), /account-secret|refresh-secret|bearer-secret|local-test-service-key/);
});

test('MCP returns stable tool errors without leaking upstream exception details', async (t) => {
  const stateDir = await connection(t);
  const call = handler({ mode: 'connect', stateDir, fetchImpl: async () => { throw new Error('network failed token=account-secret'); } });
  const result = await call(rpc('tools/call', { name: 'workbuddy_status' }));
  assert.equal(result.result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /account-secret/);
});

test('stdio entrypoint initializes and calls a real authenticated local service', async (t) => {
  assert.equal(typeof implementation.createMcpHandler, 'function', 'MCP entrypoint must be implemented');
  const service = createServer((req, res) => {
    assert.equal(req.headers['x-workbuddy-key'], 'local-test-service-key');
    assert.equal(req.url, '/status');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ healthy: true, source: 'local-runtime' }));
  });
  await new Promise((resolve) => service.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => service.close(resolve)));
  const stateDir = await connection(t, `http://127.0.0.1:${service.address().port}`);
  const process = spawn(globalThis.process.execPath, [path.join(root, 'src', 'mcp.mjs'), 'connect'], {
    env: { ...globalThis.process.env, WORKBUDDY_STATE_DIR: stateDir }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  t.after(() => { if (!process.killed) process.kill(); });
  let stdout = '', stderr = '';
  process.stdout.on('data', (chunk) => { stdout += chunk; });
  process.stderr.on('data', (chunk) => { stderr += chunk; });
  process.stdin.write(`${JSON.stringify(rpc('initialize', { protocolVersion: '2025-06-18' }))}\n`);
  process.stdin.write(`${JSON.stringify(rpc('tools/call', { name: 'workbuddy_status' }, 2))}\n`);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('stdio response timeout')), 5000);
    process.stdout.on('data', () => {
      if (stdout.trim().split('\n').length >= 2) { clearTimeout(timeout); resolve(); }
    });
  });
  process.stdin.end();
  await new Promise((resolve) => process.on('exit', resolve));
  const responses = stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(responses.length, 2);
  assert.equal(decoded(responses.find(({ id }) => id === 2)).healthy, true);
  assert.equal(stderr, '');
  assert.doesNotMatch(stdout, /local-test-service-key/);
});

test('packaging preserves hidden compatibility manifests and a portable MCP runtime', async (t) => {
  let packaging = {};
  try { packaging = await import('../scripts/package.mjs'); } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
  assert.equal(typeof packaging.packagePlugins, 'function', 'Private plugin packaging must be implemented');
  const outDir = await mkdtemp(path.join(tmpdir(), 'workbuddy-package-test-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const packages = await packaging.packagePlugins({ outDir });
  assert.equal(packages.length, 2);
  for (const item of packages) {
    const archive = await readFile(item.archive);
    const files = new Map();
    let offset = 0;
    while (archive.readUInt32LE(offset) === 0x04034b50) {
      const method = archive.readUInt16LE(offset + 8);
      const compressedSize = archive.readUInt32LE(offset + 18);
      const nameLength = archive.readUInt16LE(offset + 26);
      const extraLength = archive.readUInt16LE(offset + 28);
      const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
      const start = offset + 30 + nameLength + extraLength;
      const compressed = archive.subarray(start, start + compressedSize);
      files.set(name, method === 8 ? inflateRawSync(compressed).toString('utf8') : compressed.toString('utf8'));
      offset = start + compressedSize;
    }
    const prefix = `${item.name}/`;
    const portable = JSON.parse(files.get(`${prefix}plugin.json`));
    const legacy = JSON.parse(files.get(`${prefix}.codex-plugin/plugin.json`));
    assert.equal(portable.name, item.name);
    assert.equal(legacy.name, portable.name);
    assert.equal(legacy.version, portable.version);
    assert.deepEqual(legacy.interface, portable.extensions['com.openai'].interface);
    assert.ok(portable.extensions['com.openai'].interface.shortDescription.length <= 30);
    assert.equal(legacy.mcpServers, './.mcp.json');
    const mcp = JSON.parse(files.get(`${prefix}mcp.json`));
    const nativeMcp = JSON.parse(files.get(`${prefix}.mcp.json`));
    assert.deepEqual(nativeMcp.mcpServers, mcp.mcpServers);
    const [server] = Object.values(mcp.mcpServers);
    assert.equal(server.command, 'node');
    assert.equal(server.args[0], '${PLUGIN_ROOT}/runtime/mcp.mjs');
    assert.equal(server.cwd, '${PLUGIN_ROOT}');
    assert.ok(files.has(`${prefix}runtime/mcp.mjs`));
    assert.ok([...files.keys()].some((name) => name.endsWith('/SKILL.md')));
    assert.equal([...files.keys()].every((name) => name.startsWith(prefix)), true);
    assert.equal([...files.keys()].some((name) => /(?:connection\.json|accounts\.json|node_modules|\.env(?:$|\/))/.test(name)), false);
  }
});
