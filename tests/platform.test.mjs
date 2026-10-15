import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { assertSupportedPlatform, findCodex, findWorkBuddy, openUrl } from '../src/platform.mjs';
import { desktopSessions } from '../src/lifecycle.mjs';

async function fixture(t,base=tmpdir()) {
  const root=(await mkdtemp(join(base,'suite-platform-'))).replaceAll('\\','/');
  t.after(()=>rm(root,{recursive:true,force:true}));
  return root;
}
async function file(path,content='fixture') { await mkdir(path.slice(0,path.lastIndexOf('/')),{recursive:true}); await writeFile(path,content,{mode:0o755}); return path; }
const noCommand=async()=>({stdout:''});

test('only Windows and macOS are supported',()=>{
  assert.doesNotThrow(()=>assertSupportedPlatform('win32'));
  assert.doesNotThrow(()=>assertSupportedPlatform('darwin'));
  assert.throws(()=>assertSupportedPlatform('linux'),{code:'platform-unsupported'});
});
test('explicit CODEX_EXE wins over discovery and missing override fails closed',async t=>{
  const root=await fixture(t); const exe=await file(`${root}/codex.exe`);
  assert.equal(await findCodex({root,platform:'win32',env:{CODEX_EXE:exe},run:async()=>{throw Error('must not run');}}),exe);
  await assert.rejects(()=>findCodex({root,platform:'win32',env:{CODEX_EXE:`${root}/missing.exe`},run:noCommand}),{code:'codex-path-unavailable'});
});
test('Windows discovers dynamic Appx install resources',async t=>{
  const root=await fixture(t); const install=`${root}/OpenAI.Codex_999`; await file(`${install}/app/resources/codex.exe`);
  const exe=await findCodex({root,platform:'win32',env:{},home:root,run:async(command,args)=>{
    assert.match(command,/powershell\.exe$/u); assert.match(args.at(-1),/Get-AppxPackage/u); return {stdout:JSON.stringify([install])};
  }});
  assert.equal(exe.replaceAll('\\','/'),`${install}/app/resources/codex.exe`);
});
test('Windows resolves npm cmd shim to vendor native binary',async t=>{
  const root=await fixture(t); await file(`${root}/npm/codex.cmd`);
  const expected=await file(`${root}/npm/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`);
  const exe=await findCodex({root,platform:'win32',env:{PATH:`${root}/npm`},home:root,run:noCommand});
  assert.equal(exe.replaceAll('\\','/'),expected);
});
test('Windows npm shims resolve nested optional packages without launching cmd',async t=>{
  const root=await fixture(t);const shim=await file(`${root}/npm/codex.cmd`,'untrusted shim text');
  const expected=await file(`${root}/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`);
  const exe=await findCodex({platform:'win32',env:{CODEX_EXE:shim},run:async()=>{throw Error('must not execute shim');}});
  assert.equal(exe.replaceAll('\\','/'),expected);
});
test('Windows discovers user install versions and isolated vendored fallback',async t=>{
  const root=await fixture(t); const expected=await file(`${root}/OpenAI/Codex/bin/build-999/codex.exe`);
  assert.equal((await findCodex({platform:'win32',env:{LOCALAPPDATA:root},home:root,root,run:noCommand})).replaceAll('\\','/'),expected);
  await rm(`${root}/OpenAI`,{recursive:true});
  const vendor=await file(`${root}/.tools/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex/codex.exe`);
  assert.equal((await findCodex({platform:'win32',env:{},home:root,root,run:noCommand})).replaceAll('\\','/'),vendor);
});
test('macOS finds Codex app resources and PATH fallback',async t=>{
  const root=await fixture(t,process.cwd()); const expected=await file(`${root}/Applications/Codex.app/Contents/Resources/codex`);
  assert.equal(await findCodex({platform:'darwin',env:{},home:root,appDirectories:[`${root}/Applications`],run:noCommand}),expected);
  await rm(`${root}/Applications`,{recursive:true});
  const pathExe=await file(`${root}/bin/codex`);
  const pathDirectory=relative(process.cwd(),`${root}/bin`).replaceAll('\\','/');
  assert.equal(resolve(await findCodex({platform:'darwin',env:{PATH:pathDirectory},home:root,appDirectories:[],run:noCommand})).replaceAll('\\','/'),pathExe);
});
test('macOS WorkBuddy requires correct region bundle and plist executable',async t=>{
  const root=await fixture(t);
  const app=`${root}/WorkBuddy AI.app`; const exe=await file(`${app}/Contents/MacOS/WorkBuddy AI`);
  await file(`${app}/Contents/Info.plist`,'<plist><dict><key>CFBundleExecutable</key><string>WorkBuddy AI</string><key>CFBundleName</key><string>WorkBuddy AI</string></dict></plist>');
  assert.equal(await findWorkBuddy('intl',{platform:'darwin',electronPaths:{intl:exe},run:noCommand}),exe);
  await assert.rejects(()=>findWorkBuddy('cn',{platform:'darwin',electronPaths:{cn:exe},run:noCommand}),{code:'electron-product-mismatch'});
  await file(`${app}/Contents/Info.plist`,'<plist><dict><key>CFBundleExecutable</key><string>Other</string></dict></plist>');
  await assert.rejects(()=>findWorkBuddy('intl',{platform:'darwin',electronPaths:{intl:exe},run:noCommand}),{code:'electron-product-mismatch'});
});
test('macOS binary plist discovery reads only CFBundleExecutable with plutil',async t=>{
  const root=await fixture(t);const app=`${root}/WorkBuddy.app`;const exe=await file(`${app}/Contents/MacOS/WorkBuddy`);
  await file(`${app}/Contents/Info.plist`,'bplist00 synthetic binary fixture');
  const bin=await findWorkBuddy('cn',{platform:'darwin',appDirectories:[root],run:async(command,args)=>{
    assert.equal(command,'/usr/bin/plutil');assert.deepEqual(args,['-extract','CFBundleExecutable','raw','-o','-',`${app}/Contents/Info.plist`]);return {stdout:'WorkBuddy\n'};
  }});
  assert.equal(bin,exe);
});
test('Windows WorkBuddy refuses ambiguous installs and a different product executable',async t=>{
  const root=await fixture(t);const one=await file(`${root}/one/workbuddy.exe`);const two=await file(`${root}/two/workbuddy.exe`);
  await assert.rejects(()=>findWorkBuddy('cn',{platform:'win32',run:async()=>({stdout:JSON.stringify([one,two])})}),{code:'electron-path-ambiguous'});
  await assert.rejects(()=>findWorkBuddy('intl',{platform:'win32',electronPaths:{intl:one}}),{code:'electron-product-mismatch'});
});
test('macOS desktop sessions exclude helper and --type children',async()=>{
  const sessions=await desktopSessions({platform:'darwin',run:async()=>({stdout:' 11 /Applications/Codex.app/Contents/MacOS/Codex\n 12 /Applications/Codex.app/Contents/MacOS/Codex --type=renderer\n 13 /Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/ChatGPT Helper\n 14 /Users/demo/Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n 15 /Applications/Other.app/Contents/MacOS/Codex\n'})});
  assert.deepEqual(sessions,['11','14']);
});
test('opening supported URLs uses hidden PowerShell or macOS open',async()=>{
  let call;
  await openUrl('https://www.workbuddy.ai',{platform:'win32',run:async(...args)=>{call=args;}});
  assert.equal(call[2].windowsHide,true); assert.match(call[1].at(-1),/Start-Process/u);
  await openUrl('http://127.0.0.1:51123/usage',{platform:'darwin',run:async(...args)=>{call=args;}});
  assert.equal(call[0],'/usr/bin/open'); assert.deepEqual(call[1],['http://127.0.0.1:51123/usage']);
  await assert.rejects(()=>openUrl('file:///etc/passwd',{platform:'darwin',run:noCommand}),{code:'url-invalid'});
});
