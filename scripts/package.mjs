import { readdir, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const names = ['codex-workbuddy-connect', 'codex-workbuddy-checkin'];
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

async function walkFiles(root, relative = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Plugin contains a symbolic link: ${child}`);
    if (entry.isDirectory()) files.push(...await walkFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Unsupported plugin entry: ${child}`);
  }
  return files.sort();
}

async function validatePlugin(pluginRoot, name) {
  const portable = JSON.parse(await readFile(path.join(pluginRoot, 'plugin.json'), 'utf8'));
  const legacy = JSON.parse(await readFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  const mcp = JSON.parse(await readFile(path.join(pluginRoot, 'mcp.json'), 'utf8'));
  const nativeMcp = JSON.parse(await readFile(path.join(pluginRoot, '.mcp.json'), 'utf8'));
  if (portable.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json' || portable.name !== name ||
      !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(portable.version)) throw new Error(`Invalid portable identity: ${name}`);
  for (const field of ['name', 'version', 'description', 'author', 'license', 'keywords']) {
    if (JSON.stringify(portable[field]) !== JSON.stringify(legacy[field])) throw new Error(`Compatibility ${field} differs: ${name}`);
  }
  const presentation = portable.extensions?.['com.openai']?.interface;
  if (!presentation || JSON.stringify(presentation) !== JSON.stringify(legacy.interface) ||
      typeof presentation.shortDescription !== 'string' || [...presentation.shortDescription].length > 30) {
    throw new Error(`Invalid or unsynchronized presentation: ${name}`);
  }
  for (const forbidden of ['skills', 'mcpServers', 'apps', 'interface']) {
    if (Object.hasOwn(portable, forbidden)) throw new Error(`Portable manifest contains ${forbidden}: ${name}`);
  }
  if (legacy.skills !== './skills/' || legacy.mcpServers !== './.mcp.json' || legacy.apps || portable.extensions['com.openai'].apps) {
    throw new Error(`Invalid local compatibility declarations: ${name}`);
  }
  if (mcp.$schema !== 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' ||
      JSON.stringify(nativeMcp.mcpServers) !== JSON.stringify(mcp.mcpServers)) throw new Error(`MCP manifests differ: ${name}`);
  const servers = Object.values(mcp.mcpServers || {});
  const mode = name.endsWith('-connect') ? 'connect' : 'checkin';
  if (servers.length !== 1 || servers[0].type !== 'stdio' || servers[0].command !== 'node' ||
      JSON.stringify(servers[0].args) !== JSON.stringify(['${PLUGIN_ROOT}/runtime/mcp.mjs', mode]) || servers[0].cwd !== '${PLUGIN_ROOT}') {
    throw new Error(`Invalid local MCP launch command: ${name}`);
  }
  const files = await walkFiles(pluginRoot);
  if (!files.includes('runtime/mcp.mjs')) throw new Error(`Missing MCP runtime: ${name}`);
  for (const asset of [presentation.logo, presentation.composerIcon]) {
    if (typeof asset !== 'string' || !asset.startsWith('./') || !files.includes(asset.slice(2))) throw new Error(`Missing icon: ${name}`);
  }
  const skills = files.filter((file) => /^skills\/[^/]+\/SKILL\.md$/.test(file));
  if (skills.length !== 1) throw new Error(`Expected one local workflow skill: ${name}`);
  const skill = await readFile(path.join(pluginRoot, skills[0]), 'utf8');
  const skillName = skills[0].split('/')[1];
  if (!skill.startsWith('---\n') || !skill.includes(`\nname: ${skillName}\n`) || !/^description: .+/m.test(skill)) {
    throw new Error(`Invalid skill metadata: ${name}`);
  }
  const forbiddenFiles = /(?:^|\/)(?:node_modules|\.git|\.env(?:\.[^/]*)?|connection\.json|accounts\.json|credentials\.json|tokens?\.json)(?:$|\/)/i;
  if (files.some((file) => forbiddenFiles.test(file))) throw new Error(`Private state or dependency directories found: ${name}`);
  return { version: portable.version, files };
}

// ZIP writing uses only Node built-ins, including hidden compatibility files.
// Each archive has one top-level plugin directory; timestamps are deterministic.
async function zipPlugin(pluginRoot, name, files) {
  const parts = [], central = [];
  let offset = 0;
  const dosDate = (2026 - 1980) << 9 | 1 << 5 | 1;
  for (const relative of files) {
    const data = await readFile(path.join(pluginRoot, relative));
    const compressed = deflateRawSync(data, { level: 9 });
    const filename = Buffer.from(`${name}/${relative}`, 'utf8');
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    parts.push(local, filename, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt16LE(dosDate, 14);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuffer, end]);
}

export async function packagePlugins({ outDir = path.join(projectRoot, 'dist') } = {}) {
  const sourceFiles = (await readdir(path.join(projectRoot, 'src'), { withFileTypes: true })).filter((file) => file.isFile() && file.name.endsWith('.mjs'));
  if (!sourceFiles.some((file) => file.name === 'mcp.mjs')) throw new Error('MCP source entrypoint is missing.');
  const destination = path.resolve(outDir);
  await mkdir(destination, { recursive: true });
  const packages = [];
  for (const name of names) {
    const pluginRoot = path.join(projectRoot, 'plugins', name);
    const runtimeRoot = path.join(pluginRoot, 'runtime');
    await mkdir(runtimeRoot, { recursive: true });
    for (const file of sourceFiles) await copyFile(path.join(projectRoot, 'src', file.name), path.join(runtimeRoot, file.name));
    const { version, files } = await validatePlugin(pluginRoot, name);
    const archive = path.join(destination, `${name}-${version}.zip`);
    const buffer = await zipPlugin(pluginRoot, name, files);
    await writeFile(archive, buffer);
    packages.push({ name, version, archive, files: files.length, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') });
  }
  return packages;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--out')) throw new Error('Usage: node scripts/package.mjs [--out DIRECTORY]');
  const packages = await packagePlugins(args.length ? { outDir: args[1] } : {});
  process.stdout.write(`${JSON.stringify({ privateLocalPackages: packages }, null, 2)}\n`);
}
