import test from 'node:test';import assert from 'node:assert/strict';
import {mergeCatalog} from '../src/catalog.mjs';import {createGateway} from '../src/gateway.mjs';
test('WorkBuddy models can form a catalog without any official account or cache',()=>{
  const catalog=mergeCatalog({models:[]},[{id:'fixture',name:'Fixture',contextWindow:32000}]);
  assert.equal(catalog.models.length,1);assert.equal(catalog.models[0].slug,'workbuddy-cn/fixture');
});
test('local gateway authentication is replaced by real official auth, and is never forwarded without it',async t=>{
  let auth=null,calls=[];
  const gateway=await createGateway({catalog:{models:[{slug:'official'}]},key:'fixture-management',authorize:async value=>value==='Bearer fixture-local',officialAuth:async()=>auth,
    fetchImpl:async(url,options)=>{calls.push(options.headers);return new Response('OK');}});t.after(()=>gateway.close());
  const request=()=>fetch(gateway.url+'/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture-local'},body:JSON.stringify({model:'official',input:[]})});
  assert.equal((await request()).status,401);assert.equal(calls.length,0);
  auth={accessToken:'fixture-official',accountId:'fixture-account'};assert.equal((await request()).status,200);
  assert.equal(calls[0].authorization,'Bearer fixture-official');assert.equal(calls[0]['chatgpt-account-id'],'fixture-account');
});
