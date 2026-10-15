import fs from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import {randomBytes,createHash} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {assertSupportedPlatform,findCodex,findWorkBuddy,openUrl} from '../src/platform.mjs';
import {createWorkBuddyClient} from '../src/workbuddy.mjs';
import {mergeCatalog,publicCatalog} from '../src/catalog.mjs';
import {integrateConfig} from '../src/config.mjs';
import {atomicWrite,readOptional,mergeEnvironment} from '../src/install-state.mjs';
import {callCodex} from '../src/codex-rpc.mjs';
import {createService} from '../src/service.mjs';
import {waitReady,managementRequest} from './manage.mjs';

const runFile=promisify(execFile);
const pluginNames=['codex-workbuddy-connect','codex-workbuddy-checkin'];
const officialPages={cn:'https://www.codebuddy.cn/workbuddy',intl:'https://www.workbuddy.ai'};
const hash=text=>createHash('sha256').update(text).digest('hex');
export function parseSetupArgs(args) {
  const options={};for(let i=0;i<args.length;i++){const arg=args[i];if(arg==='--non-interactive')options.nonInteractive=true;else if(arg==='--no-service')options.noService=true;else if(['--regions','--port','--home','--state'].includes(arg)){if(!args[i+1]||args[i+1].startsWith('--'))throw new Error('missing-option-value');options[{'--regions':'regions','--port':'port','--home':'home','--state':'state'}[arg]]=args[++i];}else throw new Error('unknown-option');}return options;
}
export function regionsFor(value) {if(value==='all')return ['cn','intl'];if(value==='cn'||value==='intl')return [value];throw new Error('regions-invalid');}
export function validateCodexVersion(output){const m=/\b(\d+)\.(\d+)\.(\d+)\b/u.exec(output);if(!m||Number(m[1])===0&&Number(m[2])<162)throw new Error('codex-version-requires-0.162');return m[0];}
export async function compileMarketplace({root,state,node=process.execPath,home}) {
  const market=path.join(state,'marketplace');await fs.mkdir(market,{recursive:true});
  for(const name of pluginNames){const target=path.join(market,'plugins',name);await fs.cp(path.join(root,'plugins',name),target,{recursive:true});await fs.cp(path.join(root,'src'),path.join(target,'runtime'),{recursive:true});
    for(const file of ['.mcp.json','mcp.json']){const config=JSON.parse(await fs.readFile(path.join(target,file),'utf8'));for(const server of Object.values(config.mcpServers??{})){server.command=node;server.env={...server.env,CODEX_HOME:home,WORKBUDDY_STATE_DIR:state};}await atomicWrite(path.join(target,file),JSON.stringify(config,null,2)+'\n');}}
  const plugins=pluginNames.map(name=>({name,source:{source:'local',path:'./plugins/'+name},policy:{installation:'AVAILABLE',authentication:'ON_USE'},category:'Productivity'}));
  await atomicWrite(path.join(market,'.agents','plugins','marketplace.json'),JSON.stringify({name:'workbuddy-suite',plugins},null,2)+'\n');return market;
}
async function loginLocal(exe,token,{env,run}) {
  if(run)return run(exe,['login','--with-api-key','-c','cli_auth_credentials_store="file"'],{env,input:token+'\n',windowsHide:true,timeout:15000});
  return new Promise((resolve,reject)=>{const child=spawn(exe,['login','--with-api-key','-c','cli_auth_credentials_store="file"'],{env,windowsHide:true,stdio:['pipe','ignore','ignore']});const timer=setTimeout(()=>{child.kill();reject(new Error('local-login-timeout'));},15000);child.once('error',()=>{clearTimeout(timer);reject(new Error('local-login-failed'));});child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('local-login-failed'));});child.stdin.on('error',()=>{});child.stdin.end(token+'\n');});
}
export async function setup(options={},dependencies={}) {
  const platform=assertSupportedPlatform(options.platform??process.platform);const root=path.resolve(options.root??path.join(import.meta.dirname,'..'));
  const userHome=options.userHome??homedir();const env={...(options.env??process.env)};
  const home=path.resolve(options.home??env.CODEX_HOME??path.join(userHome,'.codex'));const state=path.resolve(options.state??env.WORKBUDDY_STATE_DIR??path.join(home,'workbuddy-suite'));
  env.CODEX_HOME=home;env.WORKBUDDY_STATE_DIR=state;
  const run=dependencies.run??runFile;const prompt=dependencies.prompt;const inform=dependencies.inform??(message=>console.log(message));
  const opener=dependencies.openUrl??(url=>openUrl(url,{platform,env}));
  const port=Number(options.port??51123);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('port-invalid');
  const regions=regionsFor(options.regions??(options.nonInteractive?'all':await prompt?.('选择地区：cn / intl / all（回车为 all）：')||'all'));
  const metadataFile=path.join(state,'installed.json');const prior=JSON.parse(await readOptional(metadataFile,'null'));
  if(prior){if(prior.root!==root||prior.home!==home)throw new Error('installation-owned-by-another-root');const service=dependencies.service??createService({...prior,userHome,env,run});if(!options.noService){await service.install();await service.start();}return {...prior,reused:true};}
  const configFile=path.join(home,'config.toml'),environmentFile=path.join(home,'.env');
  const original=await readOptional(configFile),originalEnvironment=await readOptional(environmentFile);
  if(/# BEGIN workbuddy-codex|\[model_providers\.workbuddy_gateway\]|workbuddy-local/iu.test(original))throw new Error('private-installation-detected-remove-with-original-tools-first');
  let exe=dependencies.exe;try{exe??=await findCodex({root,env,platform,home:userHome,run});}catch(error){inform('找不到 Codex CLI。请重新运行发布包的安装入口，或安装官方 Codex 0.162 及以上版本：https://developers.openai.com/codex/cli');throw error;}const version=validateCodexVersion((await run(exe,['--version'],{env,windowsHide:true,timeout:10000})).stdout);
  const rpc=dependencies.callCodex??callCodex;const account=await rpc(exe,'account/read',{refreshToken:false},{env});
  const authMode=account?.account?.type==='chatgpt'?'chatgpt':'local';
  const client=dependencies.client??createWorkBuddyClient({platform,env,home:userHome});const statuses=[];
  for(const region of regions){let status;for(let attempt=0;attempt<3;attempt++){
    try{if(!dependencies.client)await findWorkBuddy(region,{platform,env,home:userHome,run});status=await client.getAccountStatus(region);}catch(error){status={region,loggedIn:false,error:error.code??'client-unavailable'};}
    if(status.loggedIn&&status.models?.length)break;
    inform(`${region}: ${status.error??status.modelsError??'请在官方 WorkBuddy 客户端登录并重试'}`);
    if(options.nonInteractive||!prompt)break;
    if(status.error==='electron-path-unavailable')await opener(officialPages[region]);
    const answer=await prompt(`${region}：打开官方客户端并登录后按 Enter 重试，输入 skip 跳过：`);if(answer.trim().toLowerCase()==='skip')break;
  }statuses.push(status);}
  if(!statuses.some(status=>status.loggedIn&&status.models?.length))throw new Error('no-workbuddy-models-login-required');
  let official=[];if(authMode==='chatgpt'){try{official=JSON.parse(await readOptional(path.join(home,'models_cache.json'),'{}')).models??[];}catch{}}
  const catalog=mergeCatalog({models:official},statuses.find(s=>s.region==='cn')?.models??[],statuses.find(s=>s.region==='intl')?.models??[]);
  const tokenFile=path.join(state,'client-token');let token=(await readOptional(tokenFile)).trim();if(!token)token=randomBytes(32).toString('hex');
  const settings={exe,port,regions,authMode,autoCheckin:regions.includes('cn')};
  const patch=integrateConfig(original,{baseUrl:'http://127.0.0.1:'+port,catalogPath:path.join(state,'catalog.json'),envKey:authMode==='local'?'WORKBUDDY_GATEWAY_TOKEN':undefined,authHeader:authMode==='chatgpt'?'x-workbuddy-client-key':undefined,defaultModel:authMode==='local'?catalog.models.find(m=>m._workbuddy)?.slug:undefined});
  const environment=mergeEnvironment(originalEnvironment,{token});
  await fs.mkdir(state,{recursive:true,mode:0o700});const backup=path.join(state,'backups',new Date().toISOString().replaceAll(':','-'));
  await fs.mkdir(backup,{recursive:true,mode:0o700});await atomicWrite(path.join(backup,'config.toml'),original);await atomicWrite(path.join(backup,'environment'),originalEnvironment);
  let generatedAuth,serviceInstalled=false,shortcuts;const service=dependencies.service??createService({root,home,state,node:process.execPath,platform,userHome,env,run});
  const metadata={suiteVersion:'0.2.0',root,home,state,node:process.execPath,exe,codexVersion:version,platform,settings,patch:patch.patch,envChanges:environment.changes,backup,configExisted:!!await fs.stat(configFile).catch(()=>null),envExisted:!!await fs.stat(environmentFile).catch(()=>null),service:options.noService?null:service.info};
  try{
    await atomicWrite(tokenFile,token+'\n');await atomicWrite(path.join(state,'catalog.json'),JSON.stringify(publicCatalog(catalog),null,2));await atomicWrite(path.join(state,'settings.json'),JSON.stringify(settings,null,2));
    // WorkBuddy-only mode writes a local API-key credential so Codex starts
    // without any ChatGPT login. If the user already has an official credential
    // we keep it untouched and read it only in ChatGPT mode.
    if(authMode==='local'){
      const existing=await readOptional(path.join(home,'auth.json'));
      if(!existing){await loginLocal(exe,token,{env,run:dependencies.login??dependencies.run});const content=await readOptional(path.join(home,'auth.json'));if(!content)throw new Error('local-login-auth-file-missing');generatedAuth={path:path.join(home,'auth.json'),hash:hash(content)};metadata.generatedAuth=generatedAuth;}
    }
    await atomicWrite(configFile,patch.text);await atomicWrite(environmentFile,environment.text);
    const marketplace=await compileMarketplace({root,state,node:process.execPath,home});metadata.marketplace=marketplace;
    await run(exe,['plugin','marketplace','add',marketplace],{env,windowsHide:true,timeout:30000});
    for(const name of pluginNames)await run(exe,['plugin','add',name+'@workbuddy-suite'],{env,windowsHide:true,timeout:30000});
    if(!options.noService){await service.install();serviceInstalled=true;await service.start();await(dependencies.waitReady??waitReady)(state);}
    shortcuts=await service.shortcuts();metadata.shortcuts=shortcuts;
    await atomicWrite(metadataFile,JSON.stringify(metadata,null,2)+'\n');await fs.unlink(path.join(state,'install-failure.json')).catch(()=>{});
    inform(`WorkBuddy Suite 已安装（${authMode}，${catalog.models.length} 个模型）。请完全退出并从 Codex WorkBuddy 入口启动。`);return metadata;
  }catch(error){
    if(serviceInstalled){await service.stop().catch(()=>{});await managementRequest(state,'/shutdown',{method:'POST'}).catch(()=>{});await service.remove().catch(()=>{});}if(shortcuts)await service.removeShortcuts(shortcuts).catch(()=>{});
    if(metadata.configExisted)await atomicWrite(configFile,original);else await fs.unlink(configFile).catch(()=>{});if(metadata.envExisted)await atomicWrite(environmentFile,originalEnvironment);else await fs.unlink(environmentFile).catch(()=>{});
    if(generatedAuth&&hash(await readOptional(generatedAuth.path))===generatedAuth.hash)await fs.unlink(generatedAuth.path);
    await atomicWrite(path.join(state,'install-failure.json'),JSON.stringify({at:new Date().toISOString(),reason:error.code??'installation-failed',backup},null,2));throw new Error(error.code??'installation-failed; original configuration restored');
  }
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){const options=parseSetupArgs(process.argv.slice(2));const rl=options.nonInteractive?null:createInterface({input:process.stdin,output:process.stdout});setup(options,{prompt:rl?question=>rl.question(question):undefined}).catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>rl?.close());}
