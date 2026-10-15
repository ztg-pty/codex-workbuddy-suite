import test from 'node:test';
import assert from 'node:assert/strict';
test('desktop startup triggers once for a process session, not for backend or renderer changes', async()=>{
  const { startupTransition }=await import('../src/lifecycle.mjs');
  assert.equal(startupTransition([],['desktop-1']),true);
  assert.equal(startupTransition(['desktop-1'],['desktop-1']),false);
  assert.equal(startupTransition(['desktop-1'],[]),false);
  assert.equal(startupTransition(['desktop-1'],['desktop-2']),true);
});
