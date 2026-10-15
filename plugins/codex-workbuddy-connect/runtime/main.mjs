import fs from 'node:fs/promises';import path from 'node:path';import {randomBytes} from 'node:crypto';import {pathToFileURL,fileURLToPath} from 'node:url';
import {codexHome,stateDir} from './paths.mjs';import {mergeCatalog,mergeZCode,publicCatalog} from './catalog.mjs';import {createGateway} from './gateway.mjs';import {createZCodeClient} from './providers/zcode.mjs';
import {startupTransition,desktopSessions} from './lifecycle.mjs';import {createUsageReader,normalizeOfficialUsage} from './usage.mjs';import {createUsagePanel} from './usage-panel.mjs';
import {atomicWrite,equalsToken,readOptional} from './install-state.mjs';import {callCodex} from './codex-rpc.mjs';
import {createCatalogCache} from './catalog-cache.mjs';
export {stateDir};
export async function runWorker(){
  const root=path.resolve(import.meta.dirname,'..');await fs.mkdir(stateDir,{recursive:true,mode:0o700});
  const settings=JSON.parse(await fs.readFile(path.join(stateDir,'settings.json'),'utf8'));const token=(await fs.readFile(path.join(stateDir,'client-token'),'utf8')).trim();
  // The WorkBuddy desktop daemon rewrites stateDir/runtime.lock, so the lock
  // lives beside the source to avoid a permanent EEXIST startup failure.
  const lockPath=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','runtime-gw.lock');let lock;
  try{lock=await fs.open(lockPath,'wx',0o600);}catch(error){if(error.code!=='EEXIST')throw error;const prior=JSON.parse(await fs.readFile(lockPath,'utf8'));
    try{process.kill(prior.pid,0);if(prior.root!==root)throw new Error('runtime-lock-owned-by-another-installation');return;}catch(check){if(check.code!=='ESRCH')throw check;}
    await fs.unlink(lockPath);lock=await fs.open(lockPath,'wx',0o600);
  }
  await lock.writeFile(JSON.stringify({pid:process.pid,root}));
  const client=await import('./workbuddy.mjs');const adapter=await import('./responses.mjs');const {checkCurrentAccount}=await import('./checkin.mjs');
  // ZCode is optional. It is only advertised when this machine has a signed-in
  // ZCode client, and any failure here must never block the other providers.
  let zcodeClient;let zcodeModels=[];
  if(settings.regions?.includes?.('zcode')){
    try{
      zcodeClient=createZCodeClient({});
      const status=await zcodeClient.getAccountStatus();
      if(status.loggedIn)zcodeModels=status.models??[];
    }catch{zcodeClient=undefined;}
  }
  let accounts=[],checkin={region:'cn',state:settings.autoCheckin?'not-checked':'disabled'};const catalog={models:[]};
  const safeAccounts=()=>accounts.map(({models,...rest})=>({...rest,modelCount:models?.length??0}));
  // Catalog reload is TTL-cached: concurrent callers share one refresh, and a
  // refresh that produces identical models skips the disk write entirely.
  const cache=createCatalogCache({
    ttlMs:Number(settings.catalogTtlMs??60000),
    persist:async value=>{await atomicWrite(path.join(stateDir,'catalog.json'),JSON.stringify(publicCatalog(value),null,2));},
    compute:async()=>{
      accounts=await Promise.all(['cn','intl'].map(region=>settings.regions.includes(region)?client.getAccountStatus(region):{region,enabled:false,loggedIn:false,models:[]}));
      let official=[];if(settings.authMode==='chatgpt'){try{const cached=JSON.parse(await readOptional(path.join(codexHome,'models_cache.json'),'{}'));official=cached.models??[];}catch{}}
      let next=mergeCatalog({models:official},accounts[0].models??[],accounts[1].models??[]);
      if(zcodeClient){try{const status=await zcodeClient.getAccountStatus();if(status.loggedIn)next=mergeZCode(next,status.models??zcodeModels);}catch{next=mergeZCode(next,zcodeModels);}}
      else next=mergeZCode(next,zcodeModels);
      catalog.models=next.models;
      return catalog;
    },
  });
  const reload=async({force=false}={})=>{
    const result=await cache.refresh({force});
    return {models:catalog.models.length,accounts:safeAccounts(),...(result.cached?{cached:true}:{})};
  };
  try{await reload({force:true});}catch(error){await lock.close();await fs.unlink(lockPath).catch(()=>{});throw error;}
  const key=randomBytes(32).toString('hex');
  const performCheckin=async()=>{if(!settings.autoCheckin||!settings.regions.includes('cn'))return {region:'cn',state:'disabled'};checkin=await checkCurrentAccount({stateDir,client});await atomicWrite(path.join(stateDir,'checkin-status.json'),JSON.stringify(checkin));return checkin;};
  const readUsage=createUsageReader({readAccount:region=>settings.regions.includes(region)?client.getAccountStatus(region):Promise.resolve({enabled:false,loggedIn:false}),readOfficial:async()=>{
    if(settings.authMode!=='chatgpt')throw new Error('official-not-connected');return normalizeOfficialUsage(await callCodex(settings.exe,'account/rateLimits/read',{excludeResetCreditDetails:true}));
  }});
  let timer;const stop=async()=>{clearInterval(timer);await gateway.close();await lock.close();await fs.unlink(lockPath).catch(()=>{});process.exit(0);};
  const gateway=await createGateway({catalog,key,workbuddyClient:client,zcodeClient,adapter,port:settings.port??51123,usagePanel:createUsagePanel({readUsage}),
    authorize:async(incoming,headers)=>settings.authMode==='chatgpt'?equalsToken(headers['x-workbuddy-client-key'],token)&&typeof incoming==='string'&&incoming.startsWith('Bearer '):equalsToken(incoming,'Bearer '+token),
    getStatus:async()=>({pid:process.pid,suiteVersion:'0.3.0',accounts:safeAccounts(),checkin,authMode:settings.authMode,zcode:zcodeClient?'enabled':'disabled',transport:'http-sse'}),
    onRoute:entry=>{fs.appendFile(path.join(stateDir,'routes.jsonl'),JSON.stringify(entry)+'\n').catch(()=>{});},
    management:{accounts:async()=>{await reload({force:true});return safeAccounts();},models:async(region)=>({models:catalog.models.filter(model=>region==='all'||model._workbuddy?.region===region||model._zcode).map(model=>({id:model.slug,name:model.display_name,region:model._workbuddy?.region??(model._zcode?'zcode':'official')}))}),checkinStatus:async()=>checkin,checkin:performCheckin,refresh:()=>reload({force:true}),shutdown:stop}
  });
  await atomicWrite(path.join(stateDir,'connection.json'),JSON.stringify({url:gateway.url,key,pid:process.pid}));
  console.log(JSON.stringify({state:'running',pid:process.pid,modelCount:catalog.models.length}));
  let sessions=[],watching=false;timer=setInterval(async()=>{if(watching)return;watching=true;try{const current=await desktopSessions();if(startupTransition(sessions,current))await performCheckin();sessions=current;}catch{}finally{watching=false;}},3000);
  process.once('SIGINT',stop);process.once('SIGTERM',stop);return {gateway,catalog};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)runWorker().catch(error=>{console.error(JSON.stringify({state:'failed',error:error.code??error.message}));process.exitCode=1;});
