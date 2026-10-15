import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createWorkBuddyClient as realCreateWorkBuddyClient, parseModels, desktopAuthPaths } from '../src/workbuddy.mjs';
const createWorkBuddyClient=options=>realCreateWorkBuddyClient({identity:async()=>({clientVersion:'5.6.2'}),...options});

test('catalog preserves explicit defaults and legacy effort alias without inventing selectable tiers',()=>{
  const data=structuredClone(catalog);
  Object.assign(data.models[0],{supportsReasoning:true,reasoning:{effort:'high'}});
  assert.equal(parseModels(data,'intl')[0].reasoning.defaultEffort,'high');
  assert.deepEqual(parseModels(data,'intl')[0].reasoning.supportedEfforts,[]);
  data.models[0].reasoning={defaultEffort:'xhigh',effort:'high',supportedEfforts:['low','low','xhigh','invalid']};
  assert.equal(parseModels(data,'intl')[0].reasoning.defaultEffort,'xhigh');
  assert.deepEqual(parseModels(data,'intl')[0].reasoning.supportedEfforts,['low','xhigh']);
});
test('undeclared effort sets use provider defaults instead of forwarding inherited choices',async t=>{
  const paths=await authFiles(t);
  const remote=await server(t,async()=>({type:'text/event-stream',body:'data: [DONE]\n\n'}));
  const client=createWorkBuddyClient({authPaths:{cn:[paths.cn]},endpoints:{cn:{chat:remote.base,billing:remote.base}}});
  await client.streamChat('cn',{model:'thinking',messages:[{role:'user',content:'Hi'}],reasoning:{effort:'xhigh'}},{modelMetadata:{id:'thinking',supportsReasoning:true,reasoning:{supportedEfforts:[],defaultEffort:'high'}}});
  const payload=JSON.parse(remote.requests[0].body);
  assert.equal(payload.reasoning_effort,undefined);
  assert.equal(payload.reasoning,undefined);
});
test('declared effort selections reach upstream unchanged, including max',async t=>{
  const paths=await authFiles(t);
  const remote=await server(t,async()=>({type:'text/event-stream',body:'data: [DONE]\n\n'}));
  const client=createWorkBuddyClient({authPaths:{cn:[paths.cn]},endpoints:{cn:{chat:remote.base,billing:remote.base}}});
  for(const effort of ['low','high','max'])await client.streamChat('cn',{model:'thinking',messages:[{role:'user',content:'Hi'}],reasoning:{effort}},{modelMetadata:{id:'thinking',supportsReasoning:true,reasoning:{supportedEfforts:['low','high','max'],defaultEffort:'high'}}});
  assert.deepEqual(remote.requests.map(x=>JSON.parse(x.body).reasoning_effort),['low','high','max']);
});
test('explicit off is omitted even if a conflicting nested effort is present',async t=>{
  const paths=await authFiles(t);
  const remote=await server(t,async()=>({type:'text/event-stream',body:'data: [DONE]\n\n'}));
  const client=createWorkBuddyClient({authPaths:{cn:[paths.cn]},endpoints:{cn:{chat:remote.base,billing:remote.base}}});
  await client.streamChat('cn',{model:'thinking',messages:[{role:'user',content:'Hi'}],reasoning_effort:'off',reasoning:{effort:'high'}},{modelMetadata:{id:'thinking',supportsReasoning:true,reasoning:{supportedEfforts:['low','high'],defaultEffort:'high'}}});
  assert.equal(JSON.parse(remote.requests[0].body).reasoning_effort,undefined);
});

const fixture = (region = 'cn', token = 'fixture-only-access') => ({ auth: { accessToken: token, refreshToken: 'fixture-only-refresh', expiresAt: 2100000000, domain: region === 'cn' ? 'www.codebuddy.cn' : 'www.workbuddy.ai' }, account: { uid: `fixture-${region}-account`, nickname: 'Private fixture name' } });
async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'workbuddy-test-')); t.after(() => rm(path, {recursive:true,force:true})); return path; }
async function authFiles(t) { const dir = await directory(t); const cn = join(dir, 'workbuddy-desktop.info'); const global = join(dir, 'workbuddy-desktop-ai.info'); await writeFile(cn, JSON.stringify(fixture())); await writeFile(global, JSON.stringify(fixture('global'))); return {cn,global}; }
async function server(t, handler) { const requests=[]; const s=createServer(async (req,res)=>{ let body=''; for await(const c of req) body+=c; requests.push({path:req.url,method:req.method,headers:req.headers,body}); const result=await handler(requests.at(-1)); res.writeHead(result.status??200,{'content-type':result.type??'application/json',Date:result.date??'Mon, 12 Oct 2026 15:59:58 GMT'}); res.end(typeof result.body==='string'?result.body:JSON.stringify(result.body)); }); await new Promise(r=>s.listen(0,'127.0.0.1',r)); t.after(()=>new Promise(r=>s.close(r))); return {base:`http://127.0.0.1:${s.address().port}`,requests}; }
const catalog={agents:[{name:'cli',models:['enabled','disabled','unusable']}],models:[{id:'enabled',name:'Enabled',maxInputTokens:64000,maxOutputTokens:8192},{id:'outside-cli',name:'Other',maxInputTokens:1000,maxOutputTokens:100},{id:'disabled',disabled:true,maxInputTokens:1000,maxOutputTokens:100},{id:'unusable',maxInputTokens:0,maxOutputTokens:100}]};

test('current desktop files isolate CN and global without looking at account backups',async t=>{ const paths=await authFiles(t); await writeFile(join(await directory(t),'workbuddy-desktop.2026-backup.info'),JSON.stringify(fixture('cn','stale-fixture'))); const client=createWorkBuddyClient({authPaths:{cn:[paths.cn],global:[paths.global]}}); const cn=await client.getCredential('cn'); const global=await client.getCredential('global'); assert.equal(cn.uid,'fixture-cn-account'); assert.equal(global.uid,'fixture-global-account'); assert.equal(JSON.stringify(cn).includes('fixture-only-access'),false,'credentials must refuse accidental JSON serialization'); assert.equal(cn.accessToken,'fixture-only-access'); });
test('a present malformed current file cannot fall back to an older directory',async t=>{const paths=await authFiles(t); const broken=join(await directory(t),'current.info'); await writeFile(broken,'{broken'); const client=createWorkBuddyClient({authPaths:{cn:[broken,paths.cn]}}); await assert.rejects(()=>client.getCredential('cn'),{code:'auth-unreadable'});});
test('a signed-out current file cannot resurrect a credential from an older directory',async t=>{const paths=await authFiles(t); const empty=join(await directory(t),'current.info'); await writeFile(empty,'{}'); const client=createWorkBuddyClient({authPaths:{cn:[empty,paths.cn]}}); assert.equal(await client.getCredential('cn'),undefined);});
test('region mismatch and a login domain containing header injection are rejected before any request',async t=>{const paths=await authFiles(t); let calls=0; const client=createWorkBuddyClient({authPaths:{cn:[paths.global]},fetch:async()=>{calls++;}}); await assert.rejects(()=>client.getModels('cn'),{code:'credential-region-mismatch'}); const raw=fixture();raw.auth.domain='invalid.example\r\nAuthorization: injected';await writeFile(paths.cn,JSON.stringify(raw)); await assert.rejects(()=>createWorkBuddyClient({authPaths:{cn:[paths.cn]}}).getCredential('cn'),{code:'auth-domain-untrusted'}); assert.equal(calls,0);});
test('catalog uses CLI roster, filters disabled rows and never includes secrets',async t=>{ const paths=await authFiles(t); const remote=await server(t,async()=>({body:{code:0,data:catalog}})); const client=createWorkBuddyClient({authPaths:{cn:[paths.cn]},endpoints:{cn:{chat:remote.base,billing:remote.base}}}); const models=await client.getModels('cn'); assert.equal(models.length,1);assert.equal(models[0].id,'enabled'); assert.equal(remote.requests[0].path,'/v3/config'); assert.equal(remote.requests[0].headers.authorization,'Bearer fixture-only-access'); assert.equal(remote.requests[0].headers['x-refresh-token'],undefined); assert.equal(JSON.stringify(models).includes('Private fixture'),false); });
test('account status aggregates credit-only packages and exposes a redacted identity',async t=>{const paths=await authFiles(t);const remote=await server(t,async req=>({body:req.path==='/v3/config'?{code:0,data:catalog}:{code:0,data:{Response:{Data:{Accounts:[{CycleCapacitySize:100,CycleCapacityRemain:25},{CycleCapacitySize:0,CycleCapacityRemain:0,CapacityRemain:12}]}}}}})); const status=await createWorkBuddyClient({authPaths:{cn:[paths.cn]},endpoints:{cn:{chat:remote.base,billing:remote.base}}}).getAccountStatus('cn'); assert.equal(status.loggedIn,true);assert.equal(status.credits,37);assert.equal(status.models[0].id,'enabled');const text=JSON.stringify(status); for(const forbidden of ['fixture-cn-account','fixture-only-access','fixture-only-refresh','Private fixture name']) assert.equal(text.includes(forbidden),false);assert.match(status.uid,/^uid-[a-f0-9]{12}$/);});
test('chat targets its own region, accepts cancellation and forwards no refresh token',async t=>{const paths=await authFiles(t);const remote=await server(t,async()=>({type:'text/event-stream',body:'data: [DONE]\n\n'}));const controller=new AbortController();const client=createWorkBuddyClient({authPaths:{global:[paths.global]},endpoints:{global:{chat:remote.base,billing:remote.base}},identity:async()=>({clientVersion:'5.6.2',cliVersion:'2.137.1'})});const response=await client.streamChat('global',{model:'enabled',messages:[{role:'developer',content:'Rules'},{role:'user',content:'Hi'}],tool_choice:{type:'function',function:{name:'lookup'}}},{signal:controller.signal});assert.equal(response.ok,true);const request=remote.requests[0];assert.equal(request.path,'/v2/chat/completions');assert.equal(request.headers['user-agent'],'WorkBuddy/5.6.2 WorkBuddy AI/5.6.2 CLI/2.137.1');assert.equal(request.headers['x-refresh-token'],undefined);const body=JSON.parse(request.body);assert.equal(body.stream,true);assert.equal(body.messages[0].role,'system');assert.equal(body.tool_choice,'lookup');});
test('transport and upstream errors use fixed safe codes instead of echoing private bodies',async t=>{const paths=await authFiles(t);const remote=await server(t,async()=>({status:401,body:{code:11,msg:'fixture-only-access fixture-cn-account'}}));const client=createWorkBuddyClient({authPaths:{cn:[paths.cn]},endpoints:{cn:{chat:remote.base,billing:remote.base}}});await assert.rejects(()=>client.getModels('cn'),error=>error.code==='upstream-auth'&&!error.message.includes('fixture'));});
test('encrypted fields decrypt only in memory and the desktop file remains byte-identical',async t=>{const paths=await authFiles(t);const key=Buffer.alloc(32,17);const keyId=createHash('sha256').update(key).digest('hex').slice(0,16);const lp=value=>{const b=Buffer.from(value);const n=Buffer.alloc(4);n.writeUInt32BE(b.length);return Buffer.concat([n,b]);};const suite=Buffer.alloc(4);suite.writeUInt32BE(1);const aad=Buffer.concat([Buffer.from('WB-AAD\0'),Buffer.from([1]),lp('WBEV1'),lp('sym-v1'),suite,lp(keyId),Buffer.from([2,0,0])]);const wrap=value=>{const nonce=Buffer.alloc(12,3);const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad);const ciphertext=Buffer.concat([cipher.update(value),cipher.final()]);return {$wbEncrypted:1,envelope:Buffer.from(JSON.stringify({suite:1,keyId,nonce:nonce.toString('base64'),authTag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')})).toString('base64')};};const raw=fixture();raw.auth.accessToken=wrap('fixture-encrypted-access');raw.auth.refreshToken=wrap('fixture-encrypted-refresh');await writeFile(paths.cn,JSON.stringify(raw));const before=await readFile(paths.cn);let lookups=0;const client=createWorkBuddyClient({authPaths:{cn:[paths.cn]},keyProvider:async region=>{assert.equal(region,'cn');lookups++;return key;}});const credential=await client.getCredential('cn');assert.equal(credential.accessToken,'fixture-encrypted-access');assert.equal(lookups,1);assert.deepEqual(await readFile(paths.cn),before);assert.equal(JSON.stringify(credential).includes('fixture-encrypted'),false);});
test('intl alias selects the global current file and preserves its public region label',async t=>{const paths=await authFiles(t);const remote=await server(t,async req=>({body:req.path==='/v3/config'?{code:0,data:catalog}:{code:0,data:{Response:{Data:{Accounts:[]}}}}}));const client=createWorkBuddyClient({authPaths:{intl:[paths.global]},endpoints:{intl:{chat:remote.base,billing:remote.base}}});assert.equal((await client.getCredential('intl')).uid,'fixture-global-account');assert.equal((await client.getAccountStatus('intl')).region,'intl');});
test('unsupported models drop inherited Codex reasoning effort before chat',async t=>{const paths=await authFiles(t);const remote=await server(t,async()=>({type:'text/event-stream',body:'data: [DONE]\n\n'}));const client=createWorkBuddyClient({authPaths:{cn:[paths.cn]},endpoints:{cn:{chat:remote.base,billing:remote.base}}});await client.streamChat('cn',{model:'plain',messages:[{role:'user',content:'Hi'}],reasoning_effort:'low',reasoning:{effort:'low'}},{modelMetadata:{id:'plain',supportsReasoning:false}});const payload=JSON.parse(remote.requests[0].body);assert.equal(payload.reasoning_effort,undefined);assert.equal(payload.reasoning,undefined);});
test('reasoning efforts are limited to the model catalogue values',async t=>{const paths=await authFiles(t);const remote=await server(t,async()=>({type:'text/event-stream',body:'data: [DONE]\n\n'}));const client=createWorkBuddyClient({authPaths:{cn:[paths.cn]},endpoints:{cn:{chat:remote.base,billing:remote.base}}});await client.streamChat('cn',{model:'thinking',messages:[{role:'user',content:'Hi'}],reasoning_effort:'xhigh'},{modelMetadata:{id:'thinking',supportsReasoning:true,reasoning:{supported:true,supportedEfforts:['low','high'],defaultEffort:'high'}}});assert.equal(JSON.parse(remote.requests[0].body).reasoning_effort,'high');});
test('legacy CN login domains are header identity only and cannot change the fixed request host',async t=>{const paths=await authFiles(t);const raw=fixture();raw.auth.domain='legacy-login.example';await writeFile(paths.cn,JSON.stringify(raw));const remote=await server(t,async()=>({body:{code:0,data:catalog}}));const client=createWorkBuddyClient({authPaths:{cn:[paths.cn]},endpoints:{cn:{chat:remote.base,billing:remote.base}}});assert.equal((await client.getCredential('cn')).region,'cn');assert.equal((await client.getModels('cn'))[0].id,'enabled');assert.equal(remote.requests[0].headers['x-domain'],'legacy-login.example');});
test('only a declared zero multiplier or a live zero-cost promotion labels a model free',()=>{const data=structuredClone(catalog);data.models[0].credits='x0.00 credits';let model=parseModels(data,'intl',Date.parse('2026-10-12T00:00:00Z'))[0];assert.equal(model.billing.free,true);assert.equal(model.billing.multiplier,'x0.00');data.models[0].credits='';model=parseModels(data,'intl')[0];assert.equal(model.billing.free,false);data.modelPromotions=[{enabled:true,modelIds:['enabled'],schedule:{validFrom:'2026-10-12T00:00:00Z',validUntil:'2026-10-13T00:00:00Z'},discount:{displayMode:'replace',factor:0},badge:{label:'Free today'},priority:1}];model=parseModels(data,'intl',Date.parse('2026-10-12T12:00:00Z'))[0];assert.equal(model.billing.free,true);assert.deepEqual(model.billing.badges,['Free today']);model=parseModels(data,'intl',Date.parse('2026-10-14T00:00:00Z'))[0];assert.equal(model.billing.free,false);assert.equal(model.billing.rateUnknown,true);});
test('global conversations always start with a system message even when a later system exists',async t=>{const paths=await authFiles(t);const remote=await server(t,async()=>({type:'text/event-stream',body:'data: [DONE]\n\n'}));await createWorkBuddyClient({authPaths:{global:[paths.global]},endpoints:{global:{chat:remote.base,billing:remote.base}}}).streamChat('global',{model:'enabled',messages:[{role:'user',content:'Hi'},{role:'system',content:'Late rule'}]});assert.equal(JSON.parse(remote.requests[0].body).messages[0].role,'system');});

async function macApp(t) {
  const app=join(await directory(t),'WorkBuddy AI.app');
  const bin=join(app,'Contents','MacOS','WorkBuddy AI');
  await mkdir(join(app,'Contents','MacOS'),{recursive:true}); await writeFile(bin,'synthetic executable',{mode:0o755});
  await writeFile(join(app,'Contents','Info.plist'),'<plist><dict><key>CFBundleExecutable</key><string>WorkBuddy AI</string></dict></plist>');
  return {bin,resources:join(app,'Contents','Resources')};
}
test('macOS identity reads versions from app Contents/Resources',async t=>{
  const paths=await authFiles(t); const app=await macApp(t);
  await mkdir(join(app.resources,'app'),{recursive:true});
  await writeFile(join(app.resources,'app','package.json'),JSON.stringify({version:'9.8.7'}));
  await mkdir(join(app.resources,'app.asar.unpacked','cli'),{recursive:true});
  await writeFile(join(app.resources,'app.asar.unpacked','cli','package.json'),JSON.stringify({version:'3.2.1'}));
  const remote=await server(t,async()=>({type:'text/event-stream',body:'data: [DONE]\n\n'}));
  const client=realCreateWorkBuddyClient({platform:'darwin',electronPaths:{intl:app.bin},authPaths:{intl:[paths.global]},endpoints:{intl:{chat:remote.base,billing:remote.base}}});
  await client.streamChat('intl',{model:'enabled',messages:[{role:'user',content:'Hi'}]});
  assert.equal(remote.requests[0].headers['user-agent'],'WorkBuddy/9.8.7 WorkBuddy AI/9.8.7 CLI/3.2.1');
});
test('macOS encrypted current login invokes only the verified product executable and preserves file',async t=>{
  const paths=await authFiles(t);const app=await macApp(t);
  const secret=Buffer.alloc(32,23).toString('base64'); const key=createHash('sha256').update(secret,'utf8').digest();
  const keyId=createHash('sha256').update(key).digest('hex').slice(0,16);
  const field=value=>{const b=Buffer.from(value);const h=Buffer.alloc(4);h.writeUInt32BE(b.length);return Buffer.concat([h,b]);};
  const suite=Buffer.alloc(4);suite.writeUInt32BE(1);
  const aad=Buffer.concat([Buffer.from('WB-AAD\0'),Buffer.from([1]),field('WBEV1'),field('sym-v1'),suite,field(keyId),Buffer.from([2,0,0])]);
  const nonce=Buffer.alloc(12,7);const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad);
  const ciphertext=Buffer.concat([cipher.update('synthetic-mac-access'),cipher.final()]);
  const raw=fixture('global');
  raw.auth.accessToken={$wbEncrypted:1,envelope:Buffer.from(JSON.stringify({suite:1,keyId,nonce:nonce.toString('base64'),authTag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')})).toString('base64')};
  await writeFile(paths.global,JSON.stringify(raw));const before=await readFile(paths.global);let called=0;
  const client=realCreateWorkBuddyClient({platform:'darwin',electronPaths:{intl:app.bin},authPaths:{intl:[paths.global]},run:async(bin,args,options)=>{
    called++;assert.equal(bin,app.bin.replaceAll('\\','/'));
    assert.equal(args[0],'-e');assert.match(args[1],/electron_browser_workbuddy_storage.*loggerGet/u);
    assert.equal(options.env.ELECTRON_RUN_AS_NODE,'1');return {stdout:JSON.stringify({version:1,atRestSecretKey:secret})};
  }});
  const credential=await client.getCredential('intl');assert.equal(credential.accessToken,'synthetic-mac-access');assert.equal(called,1);
  assert.deepEqual(await readFile(paths.global),before);assert.equal(JSON.stringify(credential).includes('synthetic-mac-access'),false);
});
test('Linux current account paths reject unsupported platform explicitly',()=>{
  assert.throws(()=>desktopAuthPaths('cn',{platform:'linux'}),{code:'platform-unsupported'});
});
