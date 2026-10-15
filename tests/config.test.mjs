import test from 'node:test';
import assert from 'node:assert/strict';
test('config integration preserves official selection and unrelated tables, then restores precisely',async()=>{
  const { integrateConfig, restoreConfig }=await import('../src/config.mjs');
  const original='model = "gpt-6.1-sol"\nmodel_provider = "openai"\nmodel_reasoning_effort = "high"\n[projects."example"]\ntrust_level = "trusted"\n';
  const result=integrateConfig(original,{baseUrl:'http://127.0.0.1:12345',catalogPath:'C:/safe/catalog.json'});
  assert.match(result.text,/model = "gpt-6.1-sol"/);assert.match(result.text,/model_provider = "workbuddy_gateway"/);
  assert.match(result.text,/model_reasoning_effort = "high"/);assert.match(result.text,/\[projects\."example"\]/);
  const later=result.text.replace('trust_level = "trusted"','trust_level = "untrusted"');
  const restored=restoreConfig(later,result.patch);
  assert.match(restored,/model_provider = "openai"/);assert.match(restored,/trust_level = "untrusted"/);
  assert.doesNotMatch(restored,/workbuddy_gateway|catalog\.json/);
  const selected=result.text.replace('model = "gpt-6.1-sol"','model = "workbuddy-intl/deepseek-v4.1-flash"');
  assert.match(restoreConfig(selected,result.patch),/model = "gpt-6.1-sol"/);
});
