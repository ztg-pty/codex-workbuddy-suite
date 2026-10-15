import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
const outDir=path.join(root,'dist');
await fs.mkdir(outDir,{recursive:true});

// Deterministic source archive of exactly the files a release needs.
const include=['README.md','LICENSE','THIRD_PARTY_NOTICES.md','package.json','toolchain.json','install.ps1','install.sh','src','scripts','plugins','.agents'];
const tarPath=path.join(outDir,`codex-workbuddy-suite-${version}.tar.gz`);
await fs.rm(tarPath,{force:true});
execFileSync('tar.exe',['-czf',tarPath,'-C',root,...include],{stdio:'pipe'});
const bytes=await fs.readFile(tarPath);
const sha256=createHash('sha256').update(bytes).digest('hex');
await fs.writeFile(path.join(outDir,`codex-workbuddy-suite-${version}.sha256`),`${sha256}  codex-workbuddy-suite-${version}.tar.gz\n`);
console.log(JSON.stringify({version,archive:tarPath,bytes:bytes.length,sha256},null,2));
