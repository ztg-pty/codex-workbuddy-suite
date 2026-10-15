import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeCatalog,mergeZCode,modelRoute,publicCatalog} from '../src/catalog.mjs';
import {toAnthropicRequest,toolChoiceToAnthropic,mapEffort,anthropicEventToOpenAI,anthropicStopReasonToOpenAI,newAnthropicState} from '../src/providers/zcode-convert.mjs';
import {modelsFromClientConfig,createZCodeClient} from '../src/providers/zcode.mjs';
import {createGateway} from '../src/gateway.mjs';

test('ZCode models join the catalog with their own prefix and route to the zcode provider',()=>{
  const base=mergeCatalog({models:[{slug:'official'}]},[{id:'cn-model',name:'CN'}],[]);
  const merged=mergeZCode(base,[{id:'glm-5.3',name:'GLM-5.3',contextWindow:200000,supportsReasoning:true,reasoning:{supported:true,supportedEfforts:['low','high','max'],defaultEffort:'high'}}]);
  const zcode=merged.models.find(model=>model.slug==='zcode/glm-5.3');
  assert.ok(zcode);
  assert.equal(zcode.display_name,'ZCode · GLM-5.3');
  assert.equal(zcode.context_window,200000);
  assert.deepEqual(zcode.supported_reasoning_levels.map(level=>level.effort),['low','high','max']);
  assert.deepEqual(modelRoute(merged,'zcode/glm-5.3'),{region:'zcode',provider:'zcode',model:'glm-5.3',metadata:{id:'glm-5.3',name:'GLM-5.3',contextWindow:200000,supportsReasoning:true,reasoning:{supported:true,supportedEfforts:['low','high','max'],defaultEffort:'high'}}});
  assert.equal(modelRoute(merged,'zcode/missing'),null);
  // The internal markers never leak to the client.
  assert.ok(publicCatalog(merged).models.every(model=>model._zcode===undefined));
});

test('reasoning levels map onto the effort values the upstream accepts',()=>{
  assert.equal(mapEffort('off'),'none');
  assert.equal(mapEffort('low'),'low');
  assert.equal(mapEffort('medium'),'medium');
  assert.equal(mapEffort('high'),'high');
  assert.equal(mapEffort('max'),'xhigh');
  assert.equal(mapEffort('xhigh'),'xhigh');
  assert.equal(mapEffort('bogus'),undefined);
});

test('system text is lifted, tool results keep their ids, and effort uses output_config',()=>{
  const request=toAnthropicRequest({
    model:'glm-5.3',stream:true,reasoning_effort:'high',
    messages:[
      {role:'system',content:'rules'},
      {role:'user',content:'hello'},
      {role:'assistant',content:null,tool_calls:[{id:'call_1',type:'function',function:{name:'shell',arguments:'{"cmd":"ls"}'}}]},
      {role:'tool',tool_call_id:'call_1',content:'ok'}
    ],
    tools:[{type:'function',function:{name:'shell',description:'run',parameters:{type:'object',properties:{cmd:{type:'string'}}}}}],
    tool_choice:'auto'
  },{model:'glm-5.3'});
  assert.equal(request.system,'rules');
  assert.equal(request.max_tokens,8192);
  assert.deepEqual(request.output_config,{effort:'high'});
  // Putting the level in thinking.type would be rejected with 400 code 1210.
  assert.equal(request.thinking,undefined);
  assert.deepEqual(request.messages.map(message=>message.role),['user','assistant','user']);
  assert.deepEqual(request.messages[1].content[0],{type:'tool_use',id:'call_1',name:'shell',input:{cmd:'ls'}});
  assert.deepEqual(request.messages[2].content[0],{type:'tool_result',tool_use_id:'call_1',content:'ok'});
  // Tools must be Anthropic-shaped; the OpenAI shape is rejected upstream.
  assert.deepEqual(request.tools,[{name:'shell',description:'run',input_schema:{type:'object',properties:{cmd:{type:'string'}}}}]);
  assert.deepEqual(request.tool_choice,{type:'auto'});
});

test('a system-only conversation still sends a placeholder user turn',()=>{
  const request=toAnthropicRequest({model:'m',stream:true,messages:[{role:'system',content:'only'}]},{model:'m'});
  assert.equal(request.system,'only');
  assert.deepEqual(request.messages,[{role:'user',content:[{type:'text',text:''}]}]);
});

test('tool_choice none drops tools entirely and named choice becomes a tool choice',()=>{
  assert.equal(toolChoiceToAnthropic('required').type,'any');
  assert.equal(toolChoiceToAnthropic({type:'function',function:{name:'probe'}}).name,'probe');
  const request=toAnthropicRequest({model:'m',stream:true,messages:[{role:'user',content:'x'}],tools:[{type:'function',function:{name:'probe'}}],tool_choice:'none'},{model:'m'});
  assert.equal(request.tools,undefined);
  assert.equal(request.tool_choice,undefined);
});

test('OpenAI-hosted web_search is stripped because only client tools exist',()=>{
  const request=toAnthropicRequest({model:'m',stream:true,messages:[{role:'user',content:'x'}],tools:[{type:'web_search'},{type:'function',function:{name:'probe'}}]},{model:'m'});
  assert.deepEqual(request.tools.map(tool=>tool.name),['probe']);
});

test('streamed Anthropic events rebuild text, thinking and tool call deltas',()=>{
  const state=newAnthropicState();
  const deltas=[];
  for(const event of [
    {type:'message_start',message:{usage:{input_tokens:10}}},
    {type:'content_block_start',index:0,content_block:{type:'text'}},
    {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'hi'}},
    {type:'content_block_start',index:1,content_block:{type:'tool_use',id:'toolu_1',name:'shell'}},
    {type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"cmd":'}},
    {type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'"ls"}'}},
    {type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:5}}
  ])deltas.push(...anthropicEventToOpenAI(event,state));
  assert.equal(deltas[0].choice.delta.content,'hi');
  const firstToolCall=deltas.find(delta=>delta.choice.delta.tool_calls);
  assert.equal(firstToolCall.choice.delta.tool_calls[0].function.name,'shell');
  assert.equal(firstToolCall.choice.delta.tool_calls[0].id,'toolu_1');
  const joined=deltas.filter(delta=>delta.choice.delta.tool_calls).map(delta=>delta.choice.delta.tool_calls[0].function.arguments??'').join('');
  assert.equal(joined,'{"cmd":"ls"}');
  assert.equal(anthropicStopReasonToOpenAI(state.stopReason),'tool_calls');
});

test('thinking deltas become reasoning content and max_tokens maps to length',()=>{
  const state=newAnthropicState();
  const deltas=anthropicEventToOpenAI({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'pondering'}},state);
  assert.equal(deltas[0].choice.delta.reasoning_content,'pondering');
  assert.equal(anthropicStopReasonToOpenAI('max_tokens'),'length');
  assert.equal(anthropicStopReasonToOpenAI('end_turn'),'stop');
});

test('the client config catalog reads providers[].models[] and merges duplicate ids',()=>{
  const models=modelsFromClientConfig({code:0,data:{providers:[
    {id:'bigmodel',models:[
      {modelId:'GLM-5.2',name:'GLM-5.2',contextWindow:1048576,maxCompletionTokens:131072,capabilities:{vision:true},reasoning:{}}
    ]},
    {id:'z-ai',models:[
      // The same id with a narrower window must not shrink the reported one.
      {modelId:'GLM-5.2',name:'GLM-5.2',contextWindow:200000},
      {modelId:'GLM-5-Turbo',name:'GLM-5-Turbo',contextWindow:204800}
    ]}
  ]}});
  assert.equal(models.length,2);
  const glm=models[0];
  assert.equal(glm.contextWindow,1048576);
  assert.equal(glm.supportsImages,true);
  assert.equal(models[1].contextWindow,204800);
  assert.equal(models[1].maxOutputTokens,undefined);
});

test('an empty or erroring config response yields no models instead of throwing',()=>{
  assert.deepEqual(modelsFromClientConfig({}),[]);
  assert.deepEqual(modelsFromClientConfig({code:500,data:{}}),[]);
  assert.deepEqual(modelsFromClientConfig({code:0,data:{providers:[]}}),[]);
});

test('a gateway without a ZCode client still answers, and ZCode models report their route',async t=>{
  const base=mergeCatalog({models:[{slug:'official'}]},[],[{id:'intl-model',name:'Intl'}]);
  const catalog=mergeZCode(base,[{id:'glm-5.3',name:'GLM-5.3'}]);
  const gateway=await createGateway({catalog,key:'fixture',authorize:async()=>true,adapter:{toChatRequest:body=>body,toResponseEvents:async function*(){}}});
  t.after(()=>gateway.close());
  // A zcode-prefixed id that is not in the catalog is still recognised as a
  // local-only model, so the user gets the routing hint rather than a bare 404.
  const missing=await fetch(gateway.url+'/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture'},body:JSON.stringify({model:'zcode/nope',input:[]})});
  assert.equal((await missing.json()).error.code,'workbuddy_model_on_foreign_provider');
  const unknown=await fetch(gateway.url+'/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture'},body:JSON.stringify({model:'totally-unknown',input:[]})});
  assert.equal((await unknown.json()).error.code,'unknown_model');
  // A ZCode model id arriving without provider wiring is reported as local-only.
  const foreign=await createGateway({catalog,key:'fixture',authorize:async()=>true,adapter:{}});
  t.after(()=>foreign.close());
  const misrouted=await fetch(foreign.url+'/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture'},body:JSON.stringify({model:'zcode/glm-5.3',input:[]})});
  assert.equal(misrouted.status,501);
  assert.equal((await misrouted.json()).error.code,'zcode_not_configured');
});

test('the ZCode client reports a missing local credential instead of throwing',async()=>{
  const client=createZCodeClient({readFile:async()=>{const error=new Error('missing');error.code='ENOENT';throw error;}});
  const status=await client.getAccountStatus();
  assert.equal(status.loggedIn,false);
  assert.equal(status.error,'no-local-credential');
});
