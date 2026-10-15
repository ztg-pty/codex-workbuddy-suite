import test from 'node:test';
import assert from 'node:assert/strict';
import {createUsageReader,normalizeOfficialUsage} from '../src/usage.mjs';
import {createUsagePanel} from '../src/usage-panel.mjs';
import {createGateway} from '../src/gateway.mjs';
test('official quota uses the Codex bucket and treats absent data as absent, never as zero',()=>{
  const out=normalizeOfficialUsage({rateLimits:{primary:{usedPercent:99}},rateLimitsByLimitId:{codex:{planType:'plus',primary:{usedPercent:36,windowDurationMins:300,resetsAt:1234},secondary:null,credits:null}}});
  assert.deepEqual(out,{plan:'plus',windows:[{remainingPercent:64,durationMins:300,resetsAt:1234}],credits:null});
  assert.deepEqual(normalizeOfficialUsage({rateLimits:{primary:null,secondary:null}}).windows,[]);
});

test('usage refresh is shared, preserves units and timestamps, and isolates provider failures',async()=>{
  let time=1000,calls=0;
  const read=createUsageReader({now:()=>time,ttlMs:60000,
    readOfficial:async()=>{calls++;return {plan:'plus',windows:[{remainingPercent:64,durationMins:300,resetsAt:10000}],credits:'0'};},
    readAccount:async region=>{if(region==='intl')throw new Error('private credential exception');return {loggedIn:true,credits:2200};}
  });
  const [a,b]=await Promise.all([read(),read()]);
  assert.deepEqual(a,b);assert.equal(calls,1);assert.equal(a.official.windows[0].remainingPercent,64);assert.equal(a.workbuddy[0].credits,2200);
  assert.equal(a.workbuddy[1].status,'unavailable');assert.equal(a.workbuddy[1].credits,null);
  assert.equal(JSON.stringify(a).includes('private'),false);assert.equal(a.official.updatedAt,new Date(1000).toISOString());
  time=61001;await read();assert.equal(calls,2);
});
test('panel requires a one-use local ticket and cookie, rejecting cross-origin and unauthenticated requests',async t=>{
  let reads=0,time=1000;
  const panel=createUsagePanel({now:()=>time,readUsage:async()=>{reads++;return {official:{status:'ok'},workbuddy:[]};}});
  const gateway=await createGateway({catalog:{models:[]},key:'fixture-local-key',usagePanel:panel});
  t.after(()=>gateway.close());
  assert.equal((await fetch(gateway.url+'/usage/api')).status,401);
  assert.equal((await fetch(gateway.url+'/usage/session',{method:'POST'})).status,401);
  const issue=await fetch(gateway.url+'/usage/session',{method:'POST',headers:{'x-workbuddy-key':'fixture-local-key'}});
  assert.equal(issue.status,200);const link=(await issue.json()).path;
  const opened=await fetch(gateway.url+link,{redirect:'manual'});
  assert.equal(opened.status,303);const cookie=opened.headers.get('set-cookie').split(';')[0];
  assert.match(opened.headers.get('set-cookie'),/HttpOnly/);
  assert.equal((await fetch(gateway.url+link,{redirect:'manual'})).status,401);
  const page=await fetch(gateway.url+'/usage',{headers:{cookie}});assert.equal(page.status,200);assert.match(await page.text(),/统一额度/);
  const data=await fetch(gateway.url+'/usage/api',{headers:{cookie}});assert.equal(data.status,200);assert.equal(reads,1);
  const cross=await fetch(gateway.url+'/usage/api',{headers:{cookie,origin:'https://other.example'}});assert.equal(cross.status,403);assert.equal(reads,1);
  time+=86400001;assert.equal((await fetch(gateway.url+'/usage/api',{headers:{cookie}})).status,401);
});
test('expired panel tickets do not create sessions',async t=>{
  let time=1000;
  const gateway=await createGateway({catalog:{models:[]},key:'fixture-local-key',usagePanel:createUsagePanel({now:()=>time,readUsage:async()=>({})})});t.after(()=>gateway.close());
  const issue=await fetch(gateway.url+'/usage/session',{method:'POST',headers:{'x-workbuddy-key':'fixture-local-key'}});const link=(await issue.json()).path;
  time+=30001;assert.equal((await fetch(gateway.url+link,{redirect:'manual'})).status,401);
});
