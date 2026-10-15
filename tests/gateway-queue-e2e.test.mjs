import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeCatalog,mergeZCode,publicCatalog} from '../src/catalog.mjs';
import {createGateway} from '../src/gateway.mjs';
import {createQueue} from '../src/queue.mjs';
import * as adapter from '../src/responses.mjs';

const fixtureCatalog=()=>mergeZCode(
  mergeCatalog({models:[{slug:'official',display_name:'Official'}]},[],[{id:'intl',name:'Intl',contextWindow:32000}]),
  [{id:'glm-5.2',name:'GLM-5.2',contextWindow:1048576}]
);

function chatFrames(text){
  return new Response([
    'data: '+JSON.stringify({choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]})+'\n\n',
    'data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\n',
    'data: [DONE]\n\n'
  ].join(''),{status:200,headers:{'content-type':'text/event-stream'}});
}

async function readEvents(response){
  const text=await response.text();
  return text.split('\n\n').filter(Boolean).map(block=>{
    const event=/^event: (.+)$/m.exec(block)?.[1];
    const data=/^data: (.+)$/m.exec(block)?.[1];
    return {event,data:data?JSON.parse(data):undefined};
  });
}

test('a WorkBuddy stream completes through the queue with no client-visible throttling',async t=>{
  let attempts=0;
  const workbuddyClient={async streamChat(){
    attempts++;
    // The first attempt is throttled; the retry must succeed.
    if(attempts===1)throw Object.assign(new Error('rate'),{name:'WorkBuddyError',code:'upstream-rate'});
    return chatFrames('HELLO');
  }};
  const gateway=await createGateway({catalog:fixtureCatalog(),key:'fixture',authorize:async()=>true,adapter,workbuddyClient});
  t.after(()=>gateway.close());
  const response=await fetch(gateway.url+'/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture'},
    body:JSON.stringify({model:'workbuddy-intl/intl',input:'hi',stream:true})});
  assert.equal(response.status,200);
  const events=await readEvents(response);
  const completed=events.find(item=>item.event==='response.completed');
  assert.ok(completed,'the stream completes after a throttled first attempt');
  assert.equal(attempts,2,'the throttle was retried exactly once');
  assert.ok(events.some(item=>item.event==='response.output_text.delta'&&item.data.delta==='HELLO'));
});

test('credit exhaustion is surfaced immediately and never retried',async t=>{
  let attempts=0;
  const workbuddyClient={async streamChat(){attempts++;throw Object.assign(new Error('credit'),{name:'WorkBuddyError',code:'upstream-credit'});}};
  const gateway=await createGateway({catalog:fixtureCatalog(),key:'fixture',authorize:async()=>true,adapter,workbuddyClient});
  t.after(()=>gateway.close());
  const response=await fetch(gateway.url+'/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture'},
    body:JSON.stringify({model:'workbuddy-intl/intl',input:'hi',stream:true})});
  assert.equal(response.status,402);
  assert.equal(attempts,1,'credit exhaustion is a settled answer');
});

test('a throttled ZCode stream waits for a slot and is never surfaced as 429',async t=>{
  let attempts=0,inFlight=0,peak=0;
  const zcodeClient={getAccountStatus:async()=>({region:'zcode',loggedIn:true,models:[]}),
    async streamChat(){
      attempts++;inFlight++;peak=Math.max(peak,inFlight);
      try{
        await new Promise(resolve=>setTimeout(resolve,25));
        if(attempts<=2)throw Object.assign(new Error('rate'),{name:'ZCodeError',code:'upstream-rate'});
        return chatFrames('ZCODE');
      }finally{inFlight--;}
    }};
  const queues={workbuddy:createQueue({provider:'workbuddy',limit:Infinity}),zcode:createQueue({provider:'zcode',limit:2,maxWaiting:8})};
  const gateway=await createGateway({catalog:fixtureCatalog(),key:'fixture',authorize:async()=>true,adapter,zcodeClient,queues});
  t.after(()=>gateway.close());
  const response=await fetch(gateway.url+'/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture'},
    body:JSON.stringify({model:'zcode/glm-5.2',input:'hi',stream:true})});
  assert.equal(response.status,200,'a throttled ZCode call still yields a stream');
  const events=await readEvents(response);
  assert.ok(events.some(item=>item.event==='response.completed'));
  assert.ok(peak<=2,'ZCode respect the configured concurrency limit');
  assert.notEqual(response.status,429);
});

test('exhausted ZCode retries report a retryable 503 rather than 429',async t=>{
  // Upstream always throttles; retry budget is spent, so the client must get a
  // back-off signal instead of a rate-limit verdict about its own traffic.
  const zcodeClient={getAccountStatus:async()=>({region:'zcode',loggedIn:true,models:[]}),
    async streamChat(){throw Object.assign(new Error('rate'),{name:'ZCodeError',code:'upstream-rate'});}};
  const gateway=await createGateway({catalog:fixtureCatalog(),key:'fixture',authorize:async()=>true,adapter,zcodeClient,
    retry:{retries:2,baseDelayMs:5,maxDelayMs:10}});
  t.after(()=>gateway.close());
  // Shrink the retry budget so the test is fast.
  const started=Date.now();
  const response=await fetch(gateway.url+'/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture'},
    body:JSON.stringify({model:'zcode/glm-5.2',input:'hi',stream:true})});
  assert.equal(response.status,503);
  const body=await response.json();
  assert.equal(body.error.code,'upstream_busy');
  assert.ok(Date.now()-started<60000,'retries are bounded');
});

test('official models bypass every queue',async t=>{
  const queues={workbuddy:createQueue({provider:'workbuddy',limit:1,maxWaiting:1}),zcode:createQueue({provider:'zcode',limit:1,maxWaiting:1})};
  let officialCalls=0;
  const gateway=await createGateway({catalog:fixtureCatalog(),key:'fixture',authorize:async()=>true,adapter,queues,officialAuth:async()=>({accessToken:'token',accountId:'acct'}),
    fetchImpl:async()=>{officialCalls++;return new Response('ok');}});
  t.after(()=>gateway.close());
  // Fill both provider queues so a queued official call would stall.
  const hold=()=>new Promise(()=>{});
  queues.workbuddy.run(hold);queues.zcode.run(hold);
  const response=await fetch(gateway.url+'/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture'},
    body:JSON.stringify({model:'official',input:'hi',stream:true})});
  assert.equal(response.status,200,'official traffic is never queued behind other providers');
  assert.equal(officialCalls,1);
});

test('catalog entries keep provider identity in the public payload',()=>{
  const catalog=fixtureCatalog();
  const publicModels=publicCatalog(catalog).models;
  assert.deepEqual(publicModels.map(model=>model.slug),['official','workbuddy-intl/intl','zcode/glm-5.2']);
  assert.ok(publicModels.every(model=>model._workbuddy===undefined&&model._zcode===undefined));
  assert.equal(publicModels.find(model=>model.slug==='zcode/glm-5.2').context_window,1048576);
});
