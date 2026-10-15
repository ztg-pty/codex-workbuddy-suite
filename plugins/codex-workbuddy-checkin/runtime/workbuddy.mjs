/**
 * Read-only current-account adapter, adapted from Corrine Hu's MIT projects:
 * dsh-workbuddy-connect @ caad7a9447e9c5c4f09653c6d5c2c34782c9ad81.
 * Credential fields, AES-GCM AAD and request headers follow that implementation.
 * The original MIT notice is preserved in upstream/connect-reference/LICENSE.
 * Unlike the upstream credential store, this adapter never saves or refreshes
 * a credential copy, and never discovers historical account backup files.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash, createDecipheriv } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, inspect } from 'node:util';
import { assertSupportedPlatform, findWorkBuddy } from './platform.mjs';

const runFile = promisify(execFile);
const CLI_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';
const DEFAULTS = Object.freeze({
  cn: {filename:'workbuddy-desktop.info', exe:'workbuddy.exe', product:'WorkBuddy', appVersion:'5.5.6', chat:'https://copilot.tencent.com', billing:'https://www.codebuddy.cn'},
  global: {filename:'workbuddy-desktop-ai.info', exe:'workbuddyai.exe', product:'WorkBuddy AI', appVersion:'5.6.2', chat:'https://www.workbuddy.ai', billing:'https://www.workbuddy.ai'},
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' ? value : '';
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const version = value => typeof value === 'string' && /^\d{1,6}(?:\.\d{1,6}){1,3}(?:-[0-9A-Za-z.]+)?$/u.test(value);

export class WorkBuddyError extends Error {
  constructor(code) { super(`WorkBuddy: ${code}`); this.name='WorkBuddyError'; this.code=code; }
}
export function normalizeRegion(region) {
  if (region === 'intl' || region === 'global') return 'global';
  if (region === 'cn') return 'cn';
  throw new WorkBuddyError('region-invalid');
}
export function redactUid(uid, region='cn') {
  return `uid-${createHash('sha256').update(`${normalizeRegion(region)}\0${uid}`).digest('hex').slice(0,12)}`;
}
function credentialRegion(domain) {
  if(typeof domain!=='string'||domain.length>512||/[\r\n\0]/u.test(domain))throw new WorkBuddyError('auth-domain-untrusted');
  const host=domain.trim().toLowerCase();
  if (host === 'workbuddy.ai' || host.endsWith('.workbuddy.ai')) return 'global';
  // Match the upstream's region rule. CN desktop login domains have changed
  // between releases; the domain is an identity header, never a fetch host.
  // Every network destination still comes from DEFAULTS for this region.
  return 'cn';
}
export function desktopAuthPaths(region, {platform=process.platform, env=process.env, home=homedir()}={}) {
  assertSupportedPlatform(platform);
  const filename=DEFAULTS[normalizeRegion(region)].filename;
  const tail=['CodeBuddyExtension','Data','Public','auth',filename];
  const bases=platform==='win32' ? [env.LOCALAPPDATA||join(home,'AppData','Local'),env.APPDATA||join(home,'AppData','Roaming')]
    : [join(home,'Library','Application Support')];
  return [...new Set(bases.map(base=>join(base,...tail)))];
}
function expiryMs(value) { return number(value)>1e12 ? value : number(value)*1000; }
function protectCredential(raw) {
  const credential={};
  // Access remains available to internal request code; serialization and
  // ordinary inspection cannot accidentally print any credential fields.
  for(const [key,value] of Object.entries(raw)) Object.defineProperty(credential,key,{value,enumerable:false});
  Object.defineProperty(credential,'toJSON',{value:()=>({region:raw.region,loggedIn:true,uid:redactUid(raw.uid,raw.region)})});
  Object.defineProperty(credential,inspect.custom,{value:()=>credential.toJSON()});
  return Object.freeze(credential);
}
function decodeBase64(value,length) {
  if(typeof value!=='string'||!value)throw new WorkBuddyError('auth-unreadable');
  const result=Buffer.from(value,'base64');
  if(!result.length||result.toString('base64').replace(/=+$/u,'')!==value.replace(/=+$/u,'')||(length!==undefined&&result.length!==length))throw new WorkBuddyError('auth-unreadable');
  return result;
}
function envelope(value) {
  if(!object(value)||value.$wbEncrypted!==1||typeof value.envelope!=='string')throw new WorkBuddyError('auth-unreadable');
  let data;try{data=JSON.parse(decodeBase64(value.envelope).toString('utf8'));}catch{throw new WorkBuddyError('auth-unreadable');}
  if(!object(data)||data.suite!==1||typeof data.keyId!=='string'||!/^[a-f0-9]{16}$/u.test(data.keyId))throw new WorkBuddyError('auth-unreadable');
  return {suite:1,keyId:data.keyId,nonce:decodeBase64(data.nonce,12),authTag:decodeBase64(data.authTag,16),ciphertext:decodeBase64(data.ciphertext)};
}
function aad(keyId) {
  const field=value=>{const bytes=Buffer.from(value);const header=Buffer.alloc(4);header.writeUInt32BE(bytes.length);return Buffer.concat([header,bytes]);};
  const suite=Buffer.alloc(4);suite.writeUInt32BE(1);
  return Buffer.concat([Buffer.from('WB-AAD\0'),Buffer.from([1]),field('WBEV1'),field('sym-v1'),suite,field(keyId),Buffer.from([2,0,0])]);
}
function openField(key,wrapped) {
  try{const decipher=createDecipheriv('aes-256-gcm',key,wrapped.nonce,{authTagLength:16});decipher.setAAD(aad(wrapped.keyId));decipher.setAuthTag(wrapped.authTag);return Buffer.concat([decipher.update(wrapped.ciphertext),decipher.final()]).toString('utf8');}
  catch{throw new WorkBuddyError('encrypted-credential-unreadable');}
}
async function electronPath(region, options) {
  try{return await findWorkBuddy(region,options);}catch(error){throw new WorkBuddyError(error.code??'electron-path-unavailable');}
}
async function localKey(region, options) {
  const bin=await electronPath(region,options);
  // Sensitive stdout is captured here only. Never forward the child error,
  // stdout, stderr, payload or key to any logger, JSON result or filesystem.
  let stdout;try{({stdout}=await (options.run??runFile)(bin,['-e','process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))'],{windowsHide:true,timeout:10000,maxBuffer:65536,env:{...(options.env??process.env),ELECTRON_RUN_AS_NODE:'1'}}));}catch{throw new WorkBuddyError('encrypted-credential-unreadable');}
  let payload;try{payload=JSON.parse(stdout);}catch{throw new WorkBuddyError('encrypted-credential-unreadable');}
  if(!object(payload)||payload.version!==1)throw new WorkBuddyError('encrypted-credential-unreadable');
  let bytes;try{bytes=decodeBase64(payload.atRestSecretKey,32);}catch{throw new WorkBuddyError('encrypted-credential-unreadable');}
  if(bytes.every(byte=>byte===0))throw new WorkBuddyError('encrypted-credential-unreadable');
  bytes.fill(0);
  return createHash('sha256').update(payload.atRestSecretKey,'utf8').digest();
}
async function readIdentity(region,options) {
  const fallback={clientVersion:DEFAULTS[region].appVersion};
  try{
    const bin=await electronPath(region,options);
    const resources=(options.platform??process.platform)==='darwin'?join(dirname(dirname(bin)),'Resources'):join(dirname(bin),'resources');
    const candidates=[join(resources,'app','package.json'),join(resources,'app.asar.unpacked','package.json')];
    let appVersion;
    for(const path of candidates){try{const pkg=JSON.parse(await readFile(path,'utf8'));if(version(pkg.version))appVersion=pkg.version;}catch{}if(appVersion)break;}
    let cliVersion;
    try{const pkg=JSON.parse(await readFile(join(resources,'app.asar.unpacked','cli','package.json'),'utf8'));const declared=pkg.version;const custom=pkg.publishConfig?.customPackage?.version;cliVersion=version(declared)&&declared!=='0.0.0'?declared:version(custom)?custom:undefined;}catch{}
    return {clientVersion:appVersion||fallback.clientVersion,...cliVersion?{cliVersion}:{}};
  }catch{return fallback;}
}
function requestHeaders(credential,region,{chat=false,identity}={}) {
  const origin=DEFAULTS[region].billing;
  const headers={'Accept':'application/json, text/plain, */*','Authorization':`Bearer ${credential.accessToken}`,'Content-Type':'application/json','Origin':origin,'Referer':`${origin}/`,'X-Requested-With':'XMLHttpRequest','User-Agent':CLI_UA};
  if(credential.uid)headers['X-User-Id']=credential.uid;else if(chat)headers['X-No-User-Id']='1';
  if(credential.domain)headers['X-Domain']=credential.domain;else if(chat)headers['X-No-Department-Info']='1';
  if(credential.enterpriseId){headers['X-Enterprise-Id']=credential.enterpriseId;if(!chat)headers['X-Tenant-Id']=credential.enterpriseId;}else if(chat)headers['X-No-Enterprise-Id']='1';
  if(chat){headers['User-Agent']=`WorkBuddy/${identity.clientVersion} ${DEFAULTS[region].product}/${identity.clientVersion}${identity.cliVersion?` CLI/${identity.cliVersion}`:''}`;headers['X-IDE-Type']='WorkBuddy';headers['X-IDE-Name']='WorkBuddy';headers['X-IDE-Version']=identity.clientVersion;headers['X-Product']='SaaS';}
  return headers;
}
function upstreamFailure(response){return new WorkBuddyError(response.status===401||response.status===403?'upstream-auth':response.status===429?'upstream-rate':response.status===402?'upstream-credit':'upstream-rejected');}
async function readJson(response) {
  let raw;try{raw=await response.json();}catch{throw new WorkBuddyError('upstream-response-invalid');}
  if(!response.ok||!object(raw)||(raw.code!==undefined&&raw.code!==0))throw upstreamFailure(response);
  return object(raw.data)?raw.data:raw;
}
function billingMetadata(row, promotions, now) {
  const credits=typeof row.credits==='string'&&row.credits.trim()?row.credits.trim():undefined;
  const multiplier=credits?.replace(/\s+credits?$/iu,'').trim();
  const badges=[...new Set((Array.isArray(row.tags)?row.tags:[]).filter(tag=>typeof tag==='string'&&tag.toLowerCase().startsWith('badge:')).map(tag=>tag.slice(6).split(':')[0]).filter(Boolean))];
  const billing={free:multiplier!==undefined&&/^x?0\.0+$/u.test(multiplier),...credits?{credits,multiplier}:{},...badges.length?{badges}:{}};
  if(!promotions.length)return billing;
  const active=[...promotions].sort((a,b)=>b.priority-a.priority).find(p=>now>=p.start&&now<p.end);
  if(!active)return {free:false,rateUnknown:true};
  const base=multiplier?.startsWith('x')?Number(multiplier.slice(1)):Number.NaN;
  if(active.factor!==0&&!Number.isFinite(base))return billing;
  const effective=active.factor===0?0:base*active.factor;
  return {...billing,credits:`x${effective.toFixed(2)}`,multiplier:`x${effective.toFixed(2)}`,free:effective===0,...active.label?{badges:[...badges,active.label]}:{}};
}
function promotionsFor(data,id) {
  if(!Array.isArray(data.modelPromotions))return [];
  return data.modelPromotions.flatMap(item=>{
    if(!object(item)||item.enabled!==true||!Array.isArray(item.modelIds)||!item.modelIds.includes(id)||!object(item.schedule)||!object(item.discount)||!object(item.badge)||item.discount.displayMode!=='replace')return [];
    const start=Date.parse(item.schedule.validFrom);const end=Date.parse(item.schedule.validUntil);const factor=item.discount.factor;
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||typeof factor!=='number'||!Number.isFinite(factor)||factor<0)return [];
    return [{start,end,factor,label:typeof item.badge.label==='string'?item.badge.label:'',priority:number(item.priority)}];
  });
}
export function parseModels(data, region='cn', now=Date.now()) {
  const global=normalizeRegion(region)==='global';
  const cli=(Array.isArray(data.agents)?data.agents:[]).find(agent=>object(agent)&&agent.name==='cli');
  if(!cli||!Array.isArray(cli.models)||cli.models.length===0)throw new WorkBuddyError('catalog-empty');
  const ids=new Set(cli.models.filter(id=>typeof id==='string'));
  const rows=new Map();
  for(const row of Array.isArray(data.models)?data.models:[]){
    if(!object(row)||typeof row.id!=='string'||!ids.has(row.id)||row.disabled===true||!positive(row.maxInputTokens)||!positive(row.maxOutputTokens))continue;
    const window=global&&positive(row.contextWindow?.defaultLength)?row.contextWindow.defaultLength:row.maxInputTokens;
    const validEffort=value=>['low','medium','high','xhigh','max'].includes(value);
    const efforts=object(row.reasoning)&&Array.isArray(row.reasoning.supportedEfforts)?[...new Set(row.reasoning.supportedEfforts.filter(validEffort))]:[];
    const defaultEffort=validEffort(row.reasoning?.defaultEffort)?row.reasoning.defaultEffort:validEffort(row.reasoning?.effort)?row.reasoning.effort:undefined;
    const promotions=global?promotionsFor(data,row.id):[];
    rows.set(row.id,{id:row.id,name:typeof row.name==='string'&&row.name?row.name:row.id,contextWindow:window,maxInputTokens:row.maxInputTokens,maxTokens:row.maxOutputTokens,maxOutputTokens:row.maxOutputTokens,supportsImages:row.supportsImages===true&&row.disabledMultimodal!==true,supportsReasoning:row.supportsReasoning===true,onlyReasoning:row.onlyReasoning===true,reasoning:{supported:row.supportsReasoning===true,only:row.onlyReasoning===true,supportedEfforts:efforts,...defaultEffort?{defaultEffort}:{}},billing:billingMetadata(row,promotions,now),...(global?{supportedContextWindows:Array.isArray(row.contextWindow?.supportedLengths)?row.contextWindow.supportedLengths.filter(positive):[],promotions}:{})});
  }
  const models=cli.models.map(id=>rows.get(id)).filter(Boolean);
  if(!models.length)throw new WorkBuddyError('catalog-empty');return models;
}
function chatBody(body,region,modelMetadata) {
  let source;try{source=typeof body==='string'?JSON.parse(body):structuredClone(body);}catch{throw new WorkBuddyError('chat-body-invalid');}
  if(!object(source))throw new WorkBuddyError('chat-body-invalid');source.stream=true;
  if(Array.isArray(source.messages))for(const message of source.messages)if(object(message)&&message.role==='developer')message.role='system';
  const requestedEffort=typeof source.reasoning_effort==='string'?source.reasoning_effort:typeof source.reasoning?.effort==='string'?source.reasoning.effort:undefined;
  if(source.reasoning_effort==='off')delete source.reasoning_effort;
  if(modelMetadata){
    const supported=modelMetadata.supportsReasoning===true||modelMetadata.reasoning?.supported===true;
    delete source.reasoning;
    delete source.reasoning_effort;
    const allowed=modelMetadata.reasoning?.supportedEfforts;
    if(supported&&requestedEffort&&requestedEffort!=='off'&&Array.isArray(allowed)&&allowed.length){
      const selected=allowed.includes(requestedEffort)?requestedEffort:modelMetadata.reasoning?.defaultEffort;
      if(allowed.includes(selected))source.reasoning_effort=selected;
    }
  }
  const choice=source.tool_choice;
  if(choice==='none'||object(choice)&&choice.type==='none'){delete source.tool_choice;delete source.tools;delete source.functions;}
  else if(object(choice)){const type=string(choice.type);source.tool_choice=type==='function'?string(choice.function?.name||choice.name).trim()||'auto':['auto','required'].includes(type)?type:'auto';}
  // The international service requires a system message even for a user-only
  // conversation; its upstream adapter prepends an empty system prompt.
  if(region==='global'&&Array.isArray(source.messages)&&source.messages[0]?.role!=='system')source.messages.unshift({role:'system',content:''});
  return JSON.stringify(source);
}

export function createWorkBuddyClient(options={}) {
  const fetcher=options.fetch??globalThis.fetch;
  const pendingKeys=new Map();
  const keyFor=async(region,keyIds)=>{
    const cacheKey=`${region}:${[...keyIds].sort().join(',')}`;
    if(!pendingKeys.has(cacheKey))pendingKeys.set(cacheKey,(async()=>{const key=await(options.keyProvider??(r=>localKey(r,options)))(region,keyIds);if(!Buffer.isBuffer(key)||key.length!==32)throw new WorkBuddyError('encrypted-credential-unreadable');const id=createHash('sha256').update(key).digest('hex').slice(0,16);if(keyIds.some(value=>value!==id))throw new WorkBuddyError('encrypted-credential-unreadable');return key;})().catch(()=>{pendingKeys.delete(cacheKey);throw new WorkBuddyError('encrypted-credential-unreadable');}));
    return pendingKeys.get(cacheKey);
  };
  const getCredential=async input=>{
    const region=normalizeRegion(input);const paths=options.authPaths?.[region]??options.authPaths?.[region==='global'?'intl':region]??desktopAuthPaths(region,options);
    for(const path of paths){
      let text;try{text=await readFile(path,'utf8');}catch(error){if(error.code==='ENOENT')continue;throw new WorkBuddyError('auth-unreadable');}
      // Any existing current file is authoritative, including an empty one.
      if(!text.trim())return undefined;
      let raw;try{raw=JSON.parse(text.replace(/^\uFEFF/u,''));}catch{throw new WorkBuddyError('auth-unreadable');}
      if(!object(raw))throw new WorkBuddyError('auth-unreadable');
      const auth=object(raw.auth)?raw.auth:raw;const account=object(raw.auth)?object(raw.account)?raw.account:{}:raw;
      const domain=string(auth.domain)||string(account.domain?.domain);if(credentialRegion(domain)!==region)throw new WorkBuddyError('credential-region-mismatch');
      const wrapped=[];for(const field of ['accessToken','refreshToken'])if(auth[field]!==undefined&&typeof auth[field]!=='string')wrapped.push([field,envelope(auth[field])]);
      const tokens={};if(wrapped.length){const key=await keyFor(region,wrapped.map(([,item])=>item.keyId));for(const [field,item]of wrapped)tokens[field]=openField(key,item);}
      const accessToken=tokens.accessToken??string(auth.accessToken);if(!accessToken)return undefined;
      return protectCredential({region,accessToken,refreshToken:tokens.refreshToken??string(auth.refreshToken),uid:string(account.uid),domain,enterpriseId:string(account.enterpriseId)||undefined,expiresAtMs:expiryMs(auth.expiresAt),source:'desktop'});
    }return undefined;
  };
  const requireCredential=async region=>{const c=await getCredential(region);if(!c)throw new WorkBuddyError('not-logged-in');return c;};
  const base=(region,kind)=>options.endpoints?.[region]?.[kind]??options.endpoints?.[region==='global'?'intl':region]?.[kind]??DEFAULTS[region][kind];
  const request=async(url,init)=>{try{return await fetcher(url,{...init,redirect:'error'});}catch{throw new WorkBuddyError(init.signal?.aborted?'request-cancelled':'upstream-transport');}};
  const identityFor=async region=>{try{const identity=await(options.identity??(r=>readIdentity(r,options)))(region);if(!version(identity.clientVersion)||identity.cliVersion!==undefined&&!version(identity.cliVersion))throw new Error();return identity;}catch{return {clientVersion:DEFAULTS[region].appVersion};}};
  const getModels=async(input,{credential,signal}={})=>{const region=normalizeRegion(input);const c=credential??await requireCredential(region);if(credentialRegion(c.domain)!==region)throw new WorkBuddyError('credential-region-mismatch');const headers=requestHeaders(c,region);if(region==='global'){const identity=await identityFor(region);headers['User-Agent']=`WorkBuddy/${identity.clientVersion}`;headers['X-Product']='SaaS';}
    const response=await request(`${base(region,'chat')}/v3/config`,{headers,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});return parseModels(await readJson(response),region);};
  const readCredits=async(input,{credential,signal}={})=>{const region=normalizeRegion(input);const c=credential??await requireCredential(region);if(credentialRegion(c.domain)!==region)throw new WorkBuddyError('credential-region-mismatch');const enterprise=region==='cn'&&Boolean(c.enterpriseId);const path=enterprise?'get-enterprise-user-usage':'get-user-resource';const response=await request(`${base(region,'billing')}/v2/billing/meter/${path}`,{method:'POST',headers:requestHeaders(c,region),body:JSON.stringify(enterprise?{}:{PageNumber:1,PageSize:100,ProductCode:'p_tcaca',Status:[0,3]}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});const data=await readJson(response);let credits;
    if(enterprise){const inner=object(data.data)?data.data:data;const limit=inner.limitNum??inner.limit_num;const used=inner.credit??inner.used_num;if(typeof limit!=='number'||typeof used!=='number')throw new WorkBuddyError('billing-shape-invalid');credits=Math.max(0,limit-used);}
    else{const accounts=data.Response?.Data?.Accounts;if(!Array.isArray(accounts))throw new WorkBuddyError('billing-shape-invalid');credits=accounts.reduce((sum,account)=>{if(!object(account))return sum;const remain=number(account.CycleCapacitySize)>0||number(account.CycleCapacityRemain)>0||number(account.CycleCapacityUsed)>0?number(account.CycleCapacityRemain):number(account.CapacityRemain);return sum+Math.max(0,remain);},0);}
    return {credits,...response.headers.get('date')?{serverDate:response.headers.get('date')}:{}};
  };
  const getAccountStatus=async(input,{signal}={})=>{const region=normalizeRegion(input);let credential;try{credential=await getCredential(region);}catch(error){return {region:input==='intl'?'intl':region,loggedIn:false,error:error instanceof WorkBuddyError?error.code:'auth-unreadable'};}if(!credential)return {region:input==='intl'?'intl':region,loggedIn:false};
    const status={region:input==='intl'?'intl':region,loggedIn:true,uid:redactUid(credential.uid,region)};
    const results=await Promise.allSettled([getModels(region,{credential,signal}),readCredits(region,{credential,signal})]);
    if(results[0].status==='fulfilled')status.models=results[0].value;else status.modelsError=results[0].reason instanceof WorkBuddyError?results[0].reason.code:'upstream-rejected';
    if(results[1].status==='fulfilled')status.credits=results[1].value.credits;else status.creditsError=results[1].reason instanceof WorkBuddyError?results[1].reason.code:'upstream-rejected';
    return status;
  };
  const streamChat=async(input,body,{signal,modelMetadata}={})=>{const region=normalizeRegion(input);const credential=await requireCredential(region);let source;try{source=typeof body==='string'?JSON.parse(body):body;}catch{throw new WorkBuddyError('chat-body-invalid');}
    if(modelMetadata&&modelMetadata.id!==source?.model)throw new WorkBuddyError('model-metadata-mismatch');
    if(!modelMetadata&&(source?.reasoning_effort!==undefined||source?.reasoning!==undefined)){modelMetadata=(await getModels(region,{credential,signal})).find(model=>model.id===source.model);if(!modelMetadata)throw new WorkBuddyError('model-unavailable');}
    const identity=await identityFor(region);const response=await request(`${base(region,'chat')}/v2/chat/completions`,{method:'POST',headers:requestHeaders(credential,region,{chat:true,identity}),body:chatBody(body,region,modelMetadata),...(signal?{signal}:{})});if(!response.ok){await response.body?.cancel();throw upstreamFailure(response);}return response;};
  const checkinRequest=async(credential,{signal}={})=>{if(credentialRegion(credential.domain)!=='cn')throw new WorkBuddyError('credential-region-mismatch');return request(`${base('cn','billing')}/v2/billing/meter/daily-checkin`,{method:'POST',headers:requestHeaders(credential,'cn'),body:'{}',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});};
  return {getCredential,getModels,getAccountStatus,streamChat,readCredits,checkinRequest};
}
const defaultClient=createWorkBuddyClient();
export const getCredential=(...args)=>defaultClient.getCredential(...args);
export const getModels=(...args)=>defaultClient.getModels(...args);
export const getAccountStatus=(...args)=>defaultClient.getAccountStatus(...args);
export const streamChat=(...args)=>defaultClient.streamChat(...args);
export const readCredits=(...args)=>defaultClient.readCredits(...args);
export const checkinRequest=(...args)=>defaultClient.checkinRequest(...args);
