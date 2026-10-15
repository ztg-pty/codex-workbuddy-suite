import { access, readFile, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile=promisify(execFile);
const failure=code=>Object.assign(new Error(code),{code});
export function assertSupportedPlatform(platform=process.platform) {
  if(platform!=='win32'&&platform!=='darwin')throw failure('platform-unsupported');
  return platform;
}
const paths=platform=>platform==='win32'?path.win32:path.posix;
const powershell=env=>path.win32.join(env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
async function executable(file,platform) {
  try {
    if(!(await stat(file)).isFile())return false;
    if(platform==='darwin'&&process.platform==='darwin')await access(file,constants.X_OK);
    return true;
  }catch{return false;}
}
async function directories(root) {
  try{return(await readdir(root,{withFileTypes:true})).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort().reverse();}catch{return [];}
}
async function nativeCodex(modules,platform) {
  const p=paths(platform); const scope=p.join(modules,'@openai');
  for(const name of await directories(scope)) {
    if(name!=='codex'&&!name.startsWith('codex-'))continue;
    const vendor=p.join(scope,name,'vendor');
    for(const target of await directories(vendor))for(const tail of ['bin','codex']) {
      const candidate=p.join(vendor,target,tail,platform==='win32'?'codex.exe':'codex');
      if(await executable(candidate,platform))return candidate;
    }
    if(name==='codex') {
      const nested=await nativeCodex(p.join(scope,name,'node_modules'),platform);
      if(nested)return nested;
    }
  }
}
async function codexCandidate(file,platform) {
  const p=paths(platform);
  if(platform==='win32'&&p.extname(file).toLowerCase()==='.cmd') {
    // npm's .cmd shim cannot be spawned as a native executable by execFile.
    // Resolve only the installed official package; never execute shim text.
    return nativeCodex(p.join(p.dirname(file),'node_modules'),platform);
  }
  if(platform==='win32'&&p.basename(file).toLowerCase()!=='codex.exe')return;
  if(await executable(file,platform))return file;
}
async function appxLocations(run,env) {
  const script="[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); @(Get-AppxPackage -Name '*OpenAI.Codex*' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty InstallLocation) | ConvertTo-Json -Compress";
  try {
    const {stdout}=await run(powershell(env),['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,maxBuffer:65536});
    const rows=JSON.parse(stdout||'[]'); return(Array.isArray(rows)?rows:[rows]).filter(row=>typeof row==='string'&&row);
  }catch{return [];}
}
export async function findCodex({root,platform=process.platform,env=process.env,home=homedir(),run=runFile,appDirectories}={}) {
  assertSupportedPlatform(platform); const p=paths(platform);
  if(env.CODEX_EXE) {
    const found=await codexCandidate(env.CODEX_EXE,platform);
    if(!found)throw failure('codex-path-unavailable');
    return found;
  }
  const candidates=[];
  if(platform==='win32') {
    for(const install of await appxLocations(run,env))candidates.push(p.join(install,'app','resources','codex.exe'),p.join(install,'resources','codex.exe'));
    const local=env.LOCALAPPDATA||p.join(home,'AppData','Local');
    const base=p.join(local,'OpenAI','Codex','bin');
    for(const version of await directories(base))candidates.push(p.join(base,version,'codex.exe'));
  }else {
    for(const base of appDirectories??['/Applications',p.join(home,'Applications')])for(const app of ['ChatGPT.app','Codex.app'])candidates.push(p.join(base,app,'Contents','Resources','codex'));
  }
  for(const file of candidates){const found=await codexCandidate(file,platform);if(found)return found;}
  const searchPath=env.PATH??env.Path??'';
  for(const directory of searchPath.split(platform==='win32'?';':':').filter(Boolean))for(const filename of platform==='win32'?['codex.exe','codex.cmd']:['codex']) {
    const found=await codexCandidate(p.join(directory.replace(/^"|"$/gu,''),filename),platform);if(found)return found;
  }
  if(root){const found=await nativeCodex(p.join(root,'.tools','codex','node_modules'),platform);if(found)return found;}
  throw failure('codex-path-unavailable');
}

const products={cn:{exe:'workbuddy.exe',apps:['WorkBuddy.app'],names:['workbuddy']},global:{exe:'workbuddyai.exe',apps:['WorkBuddy AI.app','WorkBuddyAI.app'],names:['workbuddy ai','workbuddyai']}};
const productRegion=input=>input==='intl'||input==='global'?'global':input==='cn'?'cn':undefined;
async function plistExecutable(plist,run) {
  // plutil also supports Apple's binary plist format; XML fixtures and older
  // XML bundles remain readable without invoking a platform tool.
  try {
    const xml=await readFile(plist,'utf8');
    if(xml.includes('<plist')) {
      const match=/<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]+)<\/string>/u.exec(xml);
      return match?.[1].replaceAll('&amp;','&').replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>');
    }
    const {stdout}=await run('/usr/bin/plutil',['-extract','CFBundleExecutable','raw','-o','-',plist],{timeout:6000,maxBuffer:65536});
    return stdout.trim();
  }catch{return undefined;}
}
async function macWorkBuddy(candidate,region,run) {
  const normalized=candidate.replaceAll('\\','/');
  const match=/^(.*\/([^/]+\.app))(?:\/Contents\/MacOS\/([^/]+))?\/?$/u.exec(normalized);
  if(!match||!products[region].apps.includes(match[2]))throw failure('electron-product-mismatch');
  const bundle=match[1]; const name=await plistExecutable(path.posix.join(bundle,'Contents','Info.plist'),run);
  if(!name||/[\/\\\0\r\n]/u.test(name)||!products[region].names.includes(name.toLowerCase())||(match[3]&&match[3]!==name))throw failure('electron-product-mismatch');
  const bin=path.posix.join(bundle,'Contents','MacOS',name);
  if(!await executable(bin,'darwin'))throw failure('electron-product-mismatch');
  return bin;
}
export async function findWorkBuddy(input,{platform=process.platform,env=process.env,home=homedir(),run=runFile,electronPaths,appDirectories}={}) {
  assertSupportedPlatform(platform); const region=productRegion(input);if(!region)throw failure('region-invalid');
  const p=paths(platform); const configured=electronPaths?.[region]??electronPaths?.[region==='global'?'intl':region];
  if(configured) {
    if(platform==='darwin')return macWorkBuddy(configured,region,run);
    if(p.basename(configured).toLowerCase()!==products[region].exe||!await executable(configured,platform))throw failure('electron-product-mismatch');
    return configured;
  }
  if(platform==='darwin') {
    for(const base of appDirectories??['/Applications',p.join(home,'Applications')])for(const app of products[region].apps) {
      const bundle=p.join(base,app);try{await access(bundle);}catch{continue;}
      return macWorkBuddy(bundle,region,run);
    }
  }else {
    const name=products[region].exe.slice(0,-4);
    const script=`[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); @(Get-Process -Name '${name}' -ErrorAction SilentlyContinue | ForEach-Object { $_.Path } | Where-Object { $_ } | Select-Object -Unique) | ConvertTo-Json -Compress`;
    let apps=[];
    try {
      const {stdout}=await run(powershell(env),['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,maxBuffer:65536});
      const parsed=JSON.parse(stdout||'[]');
      for(const file of Array.isArray(parsed)?parsed:[parsed])if(typeof file==='string'&&p.basename(file).toLowerCase()===products[region].exe&&await executable(file,platform))apps.push(file);
    }catch{}
    apps=[...new Set(apps)]; if(apps.length===1)return apps[0];if(apps.length>1)throw failure('electron-path-ambiguous');
    const local=env.LOCALAPPDATA||p.join(home,'AppData','Local');
    for(const folder of region==='cn'?['WorkBuddy']:['WorkBuddy AI','WorkBuddyAI']) {
      const bin=p.join(local,'Programs',folder,products[region].exe);if(await executable(bin,platform))return bin;
    }
  }
  throw failure('electron-path-unavailable');
}
export async function openUrl(url,{platform=process.platform,env=process.env,run=runFile}={}) {
  assertSupportedPlatform(platform);
  let parsed;try{parsed=new URL(url);}catch{throw failure('url-invalid');}
  if(!['https:','http:'].includes(parsed.protocol)||/[\0\r\n]/u.test(url))throw failure('url-invalid');
  if(platform==='win32') {
    const quoted=url.replaceAll("'","''");
    await run(powershell(env),['-NoProfile','-NonInteractive','-Command',`Start-Process -FilePath '${quoted}'`],{windowsHide:true,timeout:10000,maxBuffer:65536});
  }else await run('/usr/bin/open',[url],{timeout:10000,maxBuffer:65536});
}
