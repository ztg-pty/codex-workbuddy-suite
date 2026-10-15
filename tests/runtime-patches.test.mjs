import test from 'node:test';
import assert from 'node:assert/strict';
import {toChatRequest} from '../src/responses.mjs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

test('compaction and agent_message input items convert instead of failing',()=>{
  const body={
    model:'m',
    input:[
      {type:'compaction',id:'cmp_1'},
      {type:'agent_message',content:[{type:'input_text',text:'delegate note'},{type:'input_text',text:' and more'}]},
      {type:'message',role:'user',content:[{type:'input_text',text:'go'}]}
    ]
  };
  const request=toChatRequest(body);
  assert.deepEqual(request.messages.map(message=>message.role),['assistant','user']);
  assert.equal(request.messages[0].content,'delegate note and more');
});

test('an upstream exec call is mapped to the declared shell tool',()=>{
  const request=toChatRequest({model:'m',input:'run something',tools:[{type:'function',name:'shell',description:'Run',parameters:{type:'object',properties:{},additionalProperties:false}}]});
  assert.ok(request.tools.some(tool=>tool.function.name==='shell'));
});

test('the gateway accepts request bodies larger than the old 16MB cap',async()=>{
  const source=await readFile(path.join(import.meta.dirname,'..','src','gateway.mjs'),'utf8');
  assert.match(source,/128\*1024\*1024/);
  assert.doesNotMatch(source,/16\*1024\*1024/);
});

test('the runtime lock lives outside the WorkBuddy daemon state directory',async()=>{
  const source=await readFile(path.join(import.meta.dirname,'..','src','main.mjs'),'utf8');
  assert.match(source,/runtime-gw\.lock/);
  assert.doesNotMatch(source,/path\.join\(stateDir,'runtime\.lock'\)/);
});
