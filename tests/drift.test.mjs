import test from 'node:test';
import assert from 'node:assert/strict';
import {integrateConfig,configDrift,reassertConfig} from '../src/config.mjs';
import {launchEnvironmentFor} from '../scripts/manage.mjs';
import {createGateway} from '../src/gateway.mjs';

const patch=integrateConfig('model = "gpt-test"\nmodel_provider = "openai"\n',{
  baseUrl:'http://127.0.0.1:51123',catalogPath:'/x/catalog.json',envKey:'WORKBUDDY_GATEWAY_TOKEN',defaultModel:'workbuddy-cn/model-test'
}).patch;

test('a third-party switcher rewriting model_provider is detected as drift',()=>{
  const hijacked=integrateConfig('model = "gpt-test"\nprovider_note = "keep"\n',{
    baseUrl:'http://127.0.0.1:51123',catalogPath:'/x/catalog.json',envKey:'WORKBUDDY_GATEWAY_TOKEN'
  }).text.replace('model_provider = "workbuddy_gateway"','model_provider = "cockpit_relay"');
  const drift=configDrift(hijacked,patch);
  assert.equal(drift.drifted,true);
  assert.equal(drift.reason,'top-level-model_provider');
});

test('reasserting repairs the provider wiring while keeping unrelated user edits',()=>{
  const hijacked=integrateConfig('model = "gpt-test"\n',{baseUrl:'http://127.0.0.1:51123',catalogPath:'/x/catalog.json',envKey:'WORKBUDDY_GATEWAY_TOKEN'})
    .text.replace('model_provider = "workbuddy_gateway"','model_provider = "cockpit_relay"\n[projects."keep"]\ntrust_level = "trusted"');
  const repaired=reassertConfig(hijacked,patch);
  assert.match(repaired,/model_provider = "workbuddy_gateway"/);
  assert.doesNotMatch(repaired,/cockpit_relay/);
  assert.match(repaired,/\[projects\."keep"\]/);
  assert.equal(configDrift(repaired,patch).drifted,false);
});

test('WorkBuddy-only launch strips official and relay credentials from the environment',()=>{
  const env=launchEnvironmentFor('local',{OPENAI_API_KEY:'relay-key',OPENAI_BASE_URL:'https://relay.example/v1',HTTPS_PROXY:'http://proxy'},'local-token','/home','/state');
  assert.equal(env.OPENAI_API_KEY,undefined);
  assert.equal(env.OPENAI_BASE_URL,undefined);
  assert.equal(env.WORKBUDDY_GATEWAY_TOKEN,'local-token');
  assert.equal(env.HTTPS_PROXY,'http://proxy');
});

test('a WorkBuddy model reaching a foreign relay path returns an actionable error, not a bare 404',async t=>{
  const gateway=await createGateway({catalog:{models:[]},key:'fixture',authorize:async()=>true,adapter:{}});
  t.after(()=>gateway.close());
  const response=await fetch(gateway.url+'/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture'},body:JSON.stringify({model:'workbuddy-cn/model-test',input:[]})});
  assert.equal(response.status,404);
  const body=await response.json();
  assert.equal(body.error.code,'workbuddy_model_on_foreign_provider');
  assert.match(body.error.message,/workbuddy_gateway/);
});
