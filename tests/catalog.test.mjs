import test from 'node:test';
import assert from 'node:assert/strict';
test('context capacity uses the largest explicitly declared window, without adding output tokens',async()=>{
  const {mergeCatalog}=await import('../src/catalog.mjs');
  const model=mergeCatalog({models:[{slug:'official',context_window:10000}]},[],[{id:'glm-5.3-flash',contextWindow:300000,maxInputTokens:1000000,maxOutputTokens:32000,supportedContextWindows:[300000,1000000]}]).models[1];
  assert.equal(model.context_window,1000000);
  assert.equal(model.max_context_window,1000000);
  assert.equal(model._workbuddy.metadata.contextWindow,300000);
});
test('reasoning menu follows each region and model declared efforts and default',async()=>{
  const {mergeCatalog}=await import('../src/catalog.mjs');
  const official={models:[{slug:'official',supported_reasoning_levels:[{effort:'high',description:'Official'}],default_reasoning_level:'high'}]};
  const cn=[{id:'shared',supportsReasoning:true,reasoning:{supportedEfforts:['low','high','max'],defaultEffort:'high'}}];
  const intl=[{id:'shared',supportsReasoning:true,reasoning:{supportedEfforts:['low','medium','high','xhigh'],defaultEffort:'high'}}];
  const {models}=mergeCatalog(official,cn,intl);
  assert.deepEqual(models[0],official.models[0]);
  assert.deepEqual(models[1].supported_reasoning_levels.map(x=>x.effort),['low','high','max']);
  assert.deepEqual(models[2].supported_reasoning_levels.map(x=>x.effort),['low','medium','high','xhigh']);
  assert.equal(models[1].default_reasoning_level,'high');
  assert.equal(models[2].default_reasoning_level,'high');
  assert.equal(models[1].supports_reasoning_effort_updates,true);
});
test('invalid defaults fall back within the declared choices and effort choices are deduplicated',async()=>{
  const {mergeCatalog}=await import('../src/catalog.mjs');
  const model=mergeCatalog({models:[{slug:'official'}]},[{id:'dedup',supportsReasoning:true,reasoning:{supportedEfforts:['high','high','max','invalid'],defaultEffort:'xhigh'}}]).models[1];
  assert.deepEqual(model.supported_reasoning_levels.map(x=>x.effort),['high','max']);
  assert.equal(model.default_reasoning_level,'high');
});
test('fixed, undeclared and unsupported reasoning do not advertise adjustable choices',async()=>{
  const {mergeCatalog}=await import('../src/catalog.mjs');
  const entries=[
    {id:'fixed',supportsReasoning:true,reasoning:{supportedEfforts:['high'],defaultEffort:'high'}},
    {id:'undeclared',supportsReasoning:true,reasoning:{supportedEfforts:[],defaultEffort:'high'}},
    {id:'plain',supportsReasoning:false,reasoning:{supportedEfforts:['low','high'],defaultEffort:'high'}}
  ];
  const models=mergeCatalog({models:[{slug:'official'}]},entries).models.slice(1);
  assert.deepEqual(models[0].supported_reasoning_levels.map(x=>x.effort),['high']);
  assert.equal(models[0].default_reasoning_level,'high');
  assert.deepEqual(models[1].supported_reasoning_levels,[]);
  assert.equal(models[1].default_reasoning_level,'high');
  assert.deepEqual(models[2].supported_reasoning_levels,[]);
  assert.ok(models.every(x=>x.supports_reasoning_effort_updates===false));
});
test('official metadata is preserved, regions have independent IDs and requested labels', async () => {
  const { mergeCatalog, modelRoute } = await import('../src/catalog.mjs');
  const official = { models: [{ slug:'gpt-official', display_name:'Official unchanged', context_window:10000, upgrade:null, extra:{a:1} }] };
  const merged = mergeCatalog(official,[{id:'same',name:'Shared',contextWindow:20000}],[{id:'same',name:'Shared',contextWindow:30000}]);
  assert.deepEqual(merged.models[0],official.models[0]);
  assert.equal(merged.models[1].display_name,'国内版 WorkBuddy · Shared');
  assert.equal(merged.models[2].display_name,'国际版 WorkBuddy · Shared');
  assert.notEqual(merged.models[1].slug,merged.models[2].slug);
  assert.deepEqual(modelRoute(merged,merged.models[1].slug),{region:'cn',model:'same'});
  assert.deepEqual(modelRoute(merged,'gpt-official'),{region:'official',model:'gpt-official'});
  assert.equal(modelRoute(merged,'unknown'),null);
  assert.equal(merged.models[1].upgrade,null);
});
test('a cached merged catalog cannot duplicate WorkBuddy entries or turn them into official routes',async()=>{
  const {mergeCatalog,modelRoute}=await import('../src/catalog.mjs');
  const merged=mergeCatalog({models:[{slug:'gpt-official',display_name:'Official'},{slug:'workbuddy-cn/old',display_name:'Old cached'}]},[{id:'new',name:'New'}],[]);
  assert.equal(merged.models.length,2);assert.equal(modelRoute(merged,'workbuddy-cn/old'),null);assert.deepEqual(modelRoute(merged,'workbuddy-cn/new'),{region:'cn',model:'new'});
});
