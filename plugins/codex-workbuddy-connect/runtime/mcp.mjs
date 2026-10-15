import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import {stateDir as defaultStateDir} from './paths.mjs';

const emptyArguments = { type: 'object', properties: {}, additionalProperties: false };
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const workflows = {
  connect: [
    { name: 'workbuddy_status', title: 'WorkBuddy 本机状态', description: '查询本机共享运行时、官方两区连接与模型网关状态。该诊断不代表当前聊天已切换模型。', inputSchema: emptyArguments, annotations: readOnly, route: '/status' },
    { name: 'workbuddy_accounts', title: 'WorkBuddy 两区账户', description: '读取国内和国际区账号状态与余额。账号凭据不会作为工具结果返回。', inputSchema: emptyArguments, annotations: readOnly, route: '/accounts' },
    { name: 'workbuddy_models', title: 'WorkBuddy 官方模型', description: '读取指定区域官方模型目录，保留官方模型名称和 WorkBuddy 区域前缀。', inputSchema: { type: 'object', properties: { region: { type: 'string', enum: ['cn', 'intl', 'all'], default: 'all', description: 'cn 国内区、intl 国际区、all 两区' } }, additionalProperties: false }, annotations: readOnly, route: '/models' },
  ],
  checkin: [
    { name: 'workbuddy_checkin_status', title: 'WorkBuddy 国内签到状态', description: '只读查询国内区当前账号今日签到状态与记录。', inputSchema: emptyArguments, annotations: readOnly, route: '/checkin-status' },
    { name: 'workbuddy_checkin', title: 'WorkBuddy 国内签到', description: '通过本机共享运行时为当前国内区账号执行今日签到。仅在用户已要求签到时调用。', inputSchema: emptyArguments, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }, route: '/checkin', method: 'POST' },
  ],
};

const errorResponse = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const resultResponse = (id, result) => ({ jsonrpc: '2.0', id, result });
const secretField = (key) => /^(?:key|servicekey|token|accesstoken|refreshtoken|idtoken|apikey|authorization|cookie|password|secret|credentials?)$/.test(key.replace(/[_\- ]/g, '').toLowerCase());

function safeOutput(value, serviceKey) {
  const secrets = new Set([serviceKey]);
  function collect(item) {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (secretField(key) && typeof child === 'string' && child) secrets.add(child);
      else collect(child);
    }
  }
  collect(value);
  function clean(item) {
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, secretField(key) ? '[已隐藏]' : clean(child)]));
    }
    if (typeof item === 'string') {
      let text = item.replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [已隐藏]');
      for (const secret of secrets) if (secret) text = text.split(secret).join('[已隐藏]');
      return text;
    }
    return item;
  }
  return clean(value);
}

async function readConnection(stateDir) {
  let connection;
  try { connection = JSON.parse(await readFile(path.join(stateDir, 'connection.json'), 'utf8')); }
  catch { throw new Error('本机 WorkBuddy 共享运行时未启动，或连接文件不可读。'); }
  let url;
  try { url = new URL(connection.url); } catch { throw new Error('本机 loopback 服务地址无效。'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('仅允许本机 loopback HTTP 服务地址。');
  }
  if (typeof connection.key !== 'string' || !connection.key || /[\r\n]/.test(connection.key)) {
    throw new Error('本机共享运行时服务密钥无效。');
  }
  return { url, key: connection.key };
}

export function createMcpHandler({ mode = 'connect', stateDir = defaultStateDir, fetchImpl = globalThis.fetch } = {}) {
  if (!workflows[mode]) throw new Error('MCP mode must be connect or checkin.');
  const definitions = workflows[mode];
  return async function handle(message) {
    const id = message?.id ?? null;
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return errorResponse(id, -32600, 'Invalid JSON-RPC request.');
    }
    if (!Object.hasOwn(message, 'id')) return null;
    if (message.method === 'initialize') {
      const requested = message.params?.protocolVersion;
      const protocolVersion = ['2024-11-05', '2025-03-26', '2025-06-18'].includes(requested) ? requested : '2025-06-18';
      return resultResponse(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: `codex-workbuddy-${mode}`, version: '0.1.0' }, instructions: '这是本机 WorkBuddy 管理工具。状态和模型目录查询不代表当前聊天的主模型已接入。不得输出账户凭据。' });
    }
    if (message.method === 'ping') return resultResponse(id, {});
    if (message.method === 'tools/list') {
      return resultResponse(id, { tools: definitions.map(({ route, method, ...tool }) => tool) });
    }
    if (message.method !== 'tools/call') return errorResponse(id, -32601, 'Method not found.');
    const definition = definitions.find(({ name }) => name === message.params?.name);
    if (!definition) return errorResponse(id, -32602, 'Unknown tool for this plugin.');
    const args = message.params?.arguments ?? {};
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some((key) => !Object.hasOwn(definition.inputSchema.properties, key)) ||
        (args.region !== undefined && !['cn', 'intl', 'all'].includes(args.region))) {
      return errorResponse(id, -32602, 'Invalid tool arguments.');
    }
    let connection;
    try { connection = await readConnection(stateDir); }
    catch (error) { return resultResponse(id, { isError: true, content: [{ type: 'text', text: error.message }] }); }
    try {
      const url = new URL(definition.route, connection.url);
      if (definition.name === 'workbuddy_models') url.searchParams.set('region', args.region || 'all');
      const method = definition.method || 'GET';
      const response = await fetchImpl(url, {
        method, headers: { 'x-workbuddy-key': connection.key, accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: '{}' } : {}), redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        return resultResponse(id, { isError: true, content: [{ type: 'text', text: `本机 WorkBuddy 服务返回 HTTP ${response.status}，请检查运行时状态。` }] });
      }
      const output = await response.json();
      const safe = safeOutput(output, connection.key);
      return resultResponse(id, { content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }], ...(safe && typeof safe === 'object' && !Array.isArray(safe) ? { structuredContent: safe } : {}) });
    } catch {
      return resultResponse(id, { isError: true, content: [{ type: 'text', text: '无法获取本机 WorkBuddy 服务结果；请检查共享运行时、网络与账号状态。' }] });
    }
  };
}

async function runStdio() {
  const handle = createMcpHandler({ mode: process.argv[2] || 'connect' });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let result;
    try { result = await handle(JSON.parse(line)); }
    catch { result = errorResponse(null, -32700, 'Invalid JSON.'); }
    if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await runStdio().catch(() => { process.stderr.write('WorkBuddy MCP startup failed.\n'); process.exitCode = 1; });
}
