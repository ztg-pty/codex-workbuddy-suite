import test from 'node:test';
import assert from 'node:assert/strict';
test('official replay preserves visible history and call IDs without foreign response item references',async()=>{
  const {normalizeOfficialReplay}=await import('../src/gateway.mjs');
  const body={input:[{type:'reasoning',id:'rs_foreign',summary:[{type:'summary_text',text:'Readable foreign summary'}]},{type:'reasoning',id:'rs_official',encrypted_content:'official-inline-data',summary:[]},{type:'message',id:'msg_foreign',role:'assistant',content:[{type:'output_text',text:'Visible'}]},{type:'function_call',id:'fc_foreign',call_id:'stable-call',name:'probe',arguments:'{}'},{type:'function_call_output',call_id:'stable-call',output:'OK'}]};
  const out=normalizeOfficialReplay(body);
  assert.equal(out.input[0].role,'assistant');assert.match(out.input[0].content[0].text,/Readable foreign summary/);
  assert.deepEqual(out.input[1],body.input[1]);assert.equal(out.input[2].id,undefined);assert.equal(out.input[2].content[0].text,'Visible');assert.equal(out.input[3].id,undefined);assert.equal(out.input[3].call_id,'stable-call');assert.deepEqual(out.input[4],body.input[4]);assert.equal(body.input[2].id,'msg_foreign');
});
test('loopback gateway routes official and WorkBuddy IDs separately and forwards only official authentication', async () => {
  const { createGateway } = await import('../src/gateway.mjs');
  const calls=[];
  const catalog={models:[{slug:'gpt-official'},{slug:'workbuddy-cn/shared',_workbuddy:{region:'cn',model:'shared'}},{slug:'workbuddy-intl/shared',_workbuddy:{region:'intl',model:'shared'}}]};
  const gateway=await createGateway({catalog,key:'local-test',officialBaseUrl:'https://official.example/codex',authorize:async auth=>auth==='Bearer official-test-only',
    fetchImpl:async(url,opts)=>{calls.push({kind:'official',url:String(url),opts});return new Response('event: response.completed\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}});},
    workbuddyClient:{streamChat:async(region,body,opts)=>{calls.push({kind:region,body,opts});return new Response('fixture');}},
    adapter:{toChatRequest:body=>({...body,stream:true}),toResponseEvents:async function*(){yield{event:'response.completed',data:{type:'response.completed'}};}}
  });
  try {
    const headers={'content-type':'application/json',authorization:'Bearer official-test-only','chatgpt-account-id':'official-test-account','cookie':'never-forward'};
    for(const model of ['gpt-official','workbuddy-cn/shared','workbuddy-intl/shared']){
      const res=await fetch(gateway.url+'/responses',{method:'POST',headers,body:JSON.stringify({model,input:'hello',stream:true,tools:[{type:'web_search'}]})});
      assert.equal(res.status,200); assert.match(await res.text(),/response.completed/);
    }
    assert.equal(calls[0].opts.headers.authorization,'Bearer official-test-only');
    assert.equal(calls[0].opts.headers['chatgpt-account-id'],'official-test-account');
    assert.equal(calls[0].opts.headers.cookie,undefined);
    assert.equal(calls[1].kind,'cn'); assert.equal(calls[2].kind,'intl');
    assert.equal(calls[1].body.model,'shared');
    assert.deepEqual(calls[1].body.tools,[]);
    assert.match(calls[1].body.instructions,/server-side web_search/);
    assert.equal(calls[1].opts.headers,undefined);
    const unknown=await fetch(gateway.url+'/responses',{method:'POST',headers,body:JSON.stringify({model:'no-such-model',input:'x'})});
    assert.equal(unknown.status,404); assert.equal(calls.length,3);
    const status=await fetch(gateway.url+'/status');assert.equal(status.status,401);
    const crossOrigin=await fetch(gateway.url+'/responses',{method:'POST',headers:{...headers,origin:'https://evil.example'},body:'{}'});assert.equal(crossOrigin.status,403);
  } finally { await gateway.close(); }
});

test('WorkBuddy quota failure stays a quota failure and never switches providers',async()=>{
  const {createGateway}=await import('../src/gateway.mjs');let officialCalls=0;
  const gateway=await createGateway({catalog:{models:[{slug:'workbuddy-cn/m',_workbuddy:{region:'cn',model:'m'}}]},key:'key',authorize:async()=>true,
    adapter:{toChatRequest:x=>x},workbuddyClient:{streamChat:async()=>{throw Object.assign(new Error('private upstream body'),{name:'WorkBuddyError',code:'upstream-credit'});}},fetchImpl:async()=>{officialCalls++;}});
  try{const response=await fetch(gateway.url+'/responses',{method:'POST',headers:{authorization:'Bearer fake','content-type':'application/json'},body:JSON.stringify({model:'workbuddy-cn/m',input:'fixture'})});assert.equal(response.status,402);assert.equal((await response.json()).error.code,'upstream-credit');assert.equal(officialCalls,0);}finally{await gateway.close();}
});
