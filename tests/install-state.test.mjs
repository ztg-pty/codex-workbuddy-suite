import test from 'node:test';import assert from 'node:assert/strict';
import {mergeEnvironment,restoreEnvironment} from '../src/install-state.mjs';import {integrateConfig,restoreConfig} from '../src/config.mjs';
test('standalone installation preserves unrelated environment and restores only managed values',()=>{
 const initial='HTTP_PROXY=http://fixture.example:7890\nNO_PROXY=example.test\nOTHER=value\n';const result=mergeEnvironment(initial,{token:'fixture-local'});
 assert.match(result.text,/NO_PROXY=example.test,127.0.0.1,localhost,::1/);assert.match(result.text,/OTHER=value/);assert.equal(restoreEnvironment(result.text,result.changes),initial);
 assert.throws(()=>restoreEnvironment(result.text.replace('fixture-local','changed'),result.changes),/environment changed/);
});
test('WorkBuddy-only config uses local env authentication and restores the former selection',()=>{
 const initial='model="official"\nmodel_provider="openai"\n';const result=integrateConfig(initial,{baseUrl:'http://127.0.0.1:51123',catalogPath:'/fixture/catalog.json',envKey:'WORKBUDDY_GATEWAY_TOKEN',defaultModel:'workbuddy-cn/test'});
 assert.match(result.text,/requires_openai_auth = false/);assert.match(result.text,/env_key = "WORKBUDDY_GATEWAY_TOKEN"/);assert.equal(restoreConfig(result.text,result.patch).trim(),initial.trim());
});
