import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
const home=await fs.mkdtemp(path.join(os.tmpdir(),'wb-local-login-'));const exe=process.env.CODEX_EXE??path.resolve('.qa/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
try{const result=spawnSync(exe,['-c','cli_auth_credentials_store="file"','login','--with-api-key'],{env:{...process.env,CODEX_HOME:home},input:'fixture-local-only-key\n',encoding:'utf8',windowsHide:true,timeout:20000});
 const present=await fs.stat(path.join(home,'auth.json')).then(()=>true,()=>false);console.log(JSON.stringify({passed:result.status===0&&present,exit:result.status,authFileCreated:present}));if(result.status!==0||!present)process.exitCode=1;
}finally{await fs.rm(home,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
