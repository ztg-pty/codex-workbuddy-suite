import path from 'node:path';import fs from 'node:fs/promises';import {execFileSync,spawnSync} from 'node:child_process';
import {findCodex,assertSupportedPlatform} from '../src/platform.mjs';import {configureProcessProxy} from '../src/network.mjs';
assertSupportedPlatform();configureProcessProxy();const root=path.resolve(import.meta.dirname,'..');process.env.PATH=path.dirname(process.execPath)+path.delimiter+(process.env.PATH??'');
let exe;try{exe=await findCodex({root});const version=execFileSync(exe,['--version'],{encoding:'utf8',windowsHide:true,timeout:10000}).match(/(\d+)\.(\d+)\.(\d+)/);if(!version||Number(version[1])===0&&Number(version[2])<162)exe=undefined;}catch{}
if(!exe){
  const npmCandidates=[path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js')];let npm;
  for(const candidate of npmCandidates)if(await fs.stat(candidate).catch(()=>null)){npm=candidate;break;}
  if(!npm)throw new Error('npm is missing from the private Node toolchain');
  execFileSync(process.execPath,[npm,'install','--prefix',path.join(root,'.tools/codex'),'--no-save','--package-lock=false','@openai/codex@0.162.1'],{stdio:'inherit',env:process.env,windowsHide:true});
  exe=await findCodex({root});
}
process.env.CODEX_EXE=exe;const setup=spawnSync(process.execPath,['--use-env-proxy',path.join(root,'scripts/setup.mjs'),...process.argv.slice(2)],{stdio:'inherit',env:process.env,windowsHide:false});process.exit(setup.status??1);
