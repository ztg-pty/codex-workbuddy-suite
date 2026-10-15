import fs from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {restoreConfig} from '../src/config.mjs';
import {configDrift,reassertConfig} from '../src/config.mjs';
import {restoreEnvironment,readOptional,atomicWrite} from '../src/install-state.mjs';
import {assertSupportedPlatform,openUrl} from '../src/platform.mjs';
import {createService} from '../src/service.mjs';

const runFile=promisify(execFile);
export async function managementRequest(state,route,{method='GET',fetcher=fetch}={}) {
  const connection=JSON.parse(await readOptional(path.join(state,'connection.json'),'null'));if(!connection)throw new Error('suite-not-running');
  const url=new URL(connection.url);if(url.hostname!=='127.0.0.1'||url.protocol!=='http:'||url.username||url.password||!Number.isInteger(connection.pid))throw new Error('invalid-local-connection');
  let response;try{response=await fetcher(new URL(route,url),{method,headers:{'x-workbuddy-key':connection.key,...method==='POST'?{'content-type':'application/json'}:{}},...method==='POST'?{body:'{}'}:{},signal:AbortSignal.timeout(3000)});}catch{throw new Error('suite-not-running');}
  if(!response.ok)throw new Error('suite-management-request-failed');return response.json();
}
export async function waitReady(state,{timeoutMs=45000,request=managementRequest,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=Date.now}={}) {
  const started=now();while(now()-started<Math.min(timeoutMs,45000)){try{const status=await request(state,'/status');if(status.ok)return status;}catch{}await delay(300);}throw new Error('suite-start-timeout-check-service-log');
}
export function launchEnvironment(env,token,home,state){const noProxy=[...new Set([...(env.NO_PROXY??env.no_proxy??'').split(',').filter(Boolean),'127.0.0.1','localhost','::1'])].join(',');return {...env,CODEX_HOME:home,WORKBUDDY_STATE_DIR:state,WORKBUDDY_GATEWAY_TOKEN:token,NO_PROXY:noProxy,no_proxy:noProxy};}
// WorkBuddy-only (local) mode must never depend on a ChatGPT login. A foreign
// switcher can add/keep an OpenAI-style provider; strip it from the launching
// env so Codex cannot fall back to an unauthenticated official login prompt.
export function launchEnvironmentFor(mode,env,token,home,state){
  const base=launchEnvironment(env,token,home,state);
  if(mode==='local'){for(const key of ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL','CHATGPT_BASE_URL'])delete base[key];}
  return base;
}
async function defaultLaunch(metadata,env,{run,spawnProcess=spawn,args=[]}) {
  if(metadata.platform==='darwin'){
    const match=/^(.*\.app)\/Contents\/Resources\/codex$/u.exec(metadata.exe);
    if(match){await run('/usr/bin/open',['--env','WORKBUDDY_GATEWAY_TOKEN='+env.WORKBUDDY_GATEWAY_TOKEN,'--env','NO_PROXY='+env.NO_PROXY,'--env','CODEX_HOME='+env.CODEX_HOME,'--env','WORKBUDDY_STATE_DIR='+env.WORKBUDDY_STATE_DIR,'-a',match[1]],{env,timeout:15000});return {launched:'desktop',existingAppMustExitFirst:true};}
  }else {
    const base=path.dirname(path.dirname(metadata.exe));for(const name of ['Codex.exe','ChatGPT.exe']){const app=path.join(base,name);if(await fs.stat(app).catch(()=>null)){const child=spawnProcess(app,[],{env,windowsHide:true,detached:true,stdio:'ignore'});child.unref();return {launched:'desktop',existingAppMustExitFirst:true};}}
  }
  await new Promise((resolve,reject)=>{const child=spawnProcess(metadata.exe,args,{env,windowsHide:false,stdio:'inherit'});child.once('error',()=>reject(new Error('codex-launch-failed')));child.once('exit',code=>code===0?resolve():reject(new Error('codex-exited-unsuccessfully')));});return {launched:'cli'};
}
export async function manage(command,options={},dependencies={}) {
  const platform=assertSupportedPlatform(options.platform??process.platform);const env={...(options.env??process.env)};
  const home=path.resolve(options.home??env.CODEX_HOME??path.join(options.userHome??homedir(),'.codex'));const state=path.resolve(options.state??env.WORKBUDDY_STATE_DIR??path.join(home,'workbuddy-suite'));
  const metadata=JSON.parse(await readOptional(path.join(state,'installed.json'),'null'));if(!metadata)throw new Error('suite-not-installed');if(metadata.home!==home||metadata.state!==state)throw new Error('installation-path-mismatch');
  env.CODEX_HOME=home;env.WORKBUDDY_STATE_DIR=state;const run=dependencies.run??runFile;const service=dependencies.service??createService({...metadata,platform,userHome:options.userHome,env,run});
  const request=dependencies.request??managementRequest;const ready=()=>waitReady(state,{request,...dependencies.waitOptions});
  const start=async()=>{try{return await request(state,'/status');}catch{}if(metadata.service){await service.install();await service.start();}else await service.startDirect();return ready();};
  const stop=async()=>{if(metadata.service)await service.stop();let stopping;try{stopping=await request(state,'/shutdown',{method:'POST'});}catch(error){if(error.message!=='suite-not-running')throw error;return {stopped:true,wasRunning:false};}return stopping;};
  if(command==='start')return start();
  if(command==='status'){try{return await request(state,'/status');}catch(error){if(error.message==='suite-not-running')return {running:false};throw error;}}
  if(command==='refresh'){await start();return request(state,'/refresh',{method:'POST'});}
  if(command==='usage'){await start();const ticket=await request(state,'/usage/session',{method:'POST'});const connection=JSON.parse(await readOptional(path.join(state,'connection.json'),'null'));if(!ticket.path?.startsWith('/usage/open?ticket=')||!connection)throw new Error('usage-session-unavailable');const url=new URL(ticket.path,connection.url).href;await(dependencies.openUrl??(url=>openUrl(url,{platform,env,run})))(url);return {opened:true};}
  if(command==='launch'){
    await start();
    // Repair drift before launching: a third-party switcher may have rewritten
    // model_provider/model, which would route WorkBuddy model ids to a relay.
    const configFile=path.join(home,'config.toml');let driftWarn;
    try{
      const current=await readOptional(configFile);
      const drift=configDrift(current,metadata.patch);
      if(drift.drifted){await atomicWrite(configFile,reassertConfig(current,metadata.patch));driftWarn=drift.reason;}
    }catch(error){driftWarn=error.message;}
    const token=(await fs.readFile(path.join(state,'client-token'),'utf8')).trim();
    const result=await(dependencies.launch??defaultLaunch)(metadata,launchEnvironmentFor(metadata.settings.authMode,env,token,home,state),{run,args:options.args??[]});
    return driftWarn?{...result,configDriftRepaired:driftWarn}:result;
  }
  if(command==='doctor'){
    const configFile=path.join(home,'config.toml');const current=await readOptional(configFile);
    const drift=configDrift(current,metadata.patch);const token=await readOptional(path.join(state,'client-token'));
    const authFile=await readOptional(path.join(home,'auth.json'));
    let authMode=authFile?'unknown':'missing';
    try{authMode=JSON.parse(authFile).auth_mode??'unknown';}catch{}
    return {authMode:metadata.settings.authMode,regions:metadata.settings.regions,configDrift:drift,localKeyPresent:!!token.trim(),codexAuthMode:authMode,
      healthy:!drift.drifted&&!!token.trim()&&(metadata.settings.authMode==='chatgpt'||authMode!=='missing'),
      note:metadata.settings.authMode==='local'?'WorkBuddy-only mode: no ChatGPT login required. If Codex shows a login prompt, run the suite launch entry again so the local credential is injected.':'ChatGPT mode: official models use the existing ChatGPT login.'};
  }
  if(command==='stop')return stop();
  if(command==='uninstall'){
    // Preflight both restoration patches before stopping or removing anything.
    const configFile=path.join(home,'config.toml'),environmentFile=path.join(home,'.env');
    const config=restoreConfig(await readOptional(configFile),metadata.patch);const environment=restoreEnvironment(await readOptional(environmentFile),metadata.envChanges);
    const auth=metadata.generatedAuth;const removeAuth=!!auth&&createHash('sha256').update(await readOptional(auth.path)).digest('hex')===auth.hash;
    await stop();
    // SDK changes its own plugin config. Restore the provider after those changes
    // so newly-added unrelated plugin settings survive removal.
    for(const name of ['codex-workbuddy-connect','codex-workbuddy-checkin'])await run(metadata.exe,['plugin','remove',name+'@workbuddy-suite'],{env,windowsHide:true,timeout:30000});
    await run(metadata.exe,['plugin','marketplace','remove','workbuddy-suite'],{env,windowsHide:true,timeout:30000});
    const afterSdk=await readOptional(configFile);await atomicWrite(configFile,afterSdk.includes(metadata.patch.block)?restoreConfig(afterSdk,metadata.patch):config);
    await atomicWrite(environmentFile,environment);if(removeAuth)await fs.unlink(auth.path);
    if(metadata.service)await service.remove();await service.removeShortcuts(metadata.shortcuts);
    // Keep backups and diagnostic records. Remove only the managed installation marker.
    await atomicWrite(path.join(state,'uninstalled.json'),JSON.stringify({at:new Date().toISOString(),backup:metadata.backup,generatedAuthRemoved:removeAuth,generatedAuthPreserved:!!auth&&!removeAuth},null,2));
    await fs.unlink(path.join(state,'installed.json'));return {uninstalled:true,backup:metadata.backup,generatedAuthRemoved:removeAuth,generatedAuthPreserved:!!auth&&!removeAuth};
  }
  throw new Error('unknown-command');
}
export function parseManageArgs(args){const command=args.shift()??'status',options={};for(let i=0;i<args.length;i++){if(args[i]==='--'){options.args=args.slice(i+1);break;}if(!['--home','--state'].includes(args[i])||!args[i+1])throw new Error('unknown-option');options[args[i].slice(2)]=args[++i];}return {command,options};}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{const{command,options}=parseManageArgs(process.argv.slice(2));manage(command,options).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});}catch(error){console.error(error.message);process.exitCode=1;}}
