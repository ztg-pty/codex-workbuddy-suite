import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeCatalog,mergeZCode,publicCatalog} from '../src/catalog.mjs';
import {createCatalogCache} from '../src/catalog-cache.mjs';

function counter(){
  let calls=0;
  return {get calls(){return calls;},bump(){calls++;}};
}

test('the catalog is served from cache within its TTL',async()=>{
  const compute=counter(),persist=counter();
  let clock=1000;
  const cache=createCatalogCache({
    ttlMs:60000,now:()=>clock,
    compute:async()=>{compute.bump();return {models:[{slug:'a'}]};},
    persist:async()=>{persist.bump();},
  });
  await cache.refresh();
  clock+=30000;
  const second=await cache.refresh();
  assert.equal(second.cached,true);
  assert.equal(compute.calls,1,'a cached read does not recompute');
  assert.equal(persist.calls,1,'a cached read does not rewrite');
  clock+=40000;
  await cache.refresh();
  assert.equal(compute.calls,2,'the TTL expiry triggers a refresh');
});

test('concurrent refreshes share one computation',async()=>{
  const compute=counter();
  const cache=createCatalogCache({ttlMs:60000,compute:async()=>{compute.bump();await new Promise(r=>setTimeout(r,20));return {models:[{slug:'a'}]};}});
  await Promise.all([cache.refresh(),cache.refresh(),cache.refresh()]);
  assert.equal(compute.calls,1);
});

test('an unchanged catalog is not rewritten, a changed one is',async()=>{
  let models=[{slug:'a',context_window:100,display_name:'A'}];
  const persist=counter();
  const cache=createCatalogCache({
    ttlMs:0,compute:async()=>({models}),
    persist:async()=>{persist.bump();},
  });
  await cache.refresh();
  await cache.refresh();
  assert.equal(persist.calls,1,'identical models skip persistence');
  models=[{slug:'a',context_window:200,display_name:'A'}];
  await cache.refresh();
  assert.equal(persist.calls,2,'a changed context window is persisted');
});

test('a forced refresh bypasses the TTL',async()=>{
  const compute=counter();
  const cache=createCatalogCache({ttlMs:600000,compute:async()=>{compute.bump();return {models:[{slug:'a'}]};}});
  await cache.refresh();
  await cache.refresh({force:true});
  assert.equal(compute.calls,2);
});

test('ZCode models merge without disturbing the other providers',()=>{
  const base=mergeCatalog({models:[{slug:'official'}]},[{id:'cn',name:'CN'}],[{id:'intl',name:'Intl'}]);
  const withZ=mergeZCode(base,[{id:'glm',name:'GLM',contextWindow:200000}]);
  assert.deepEqual(withZ.models.map(m=>m.slug),['official','workbuddy-cn/cn','workbuddy-intl/intl','zcode/glm']);
  assert.deepEqual(publicCatalog(withZ).models.map(m=>m.slug),withZ.models.map(m=>m.slug));
});
