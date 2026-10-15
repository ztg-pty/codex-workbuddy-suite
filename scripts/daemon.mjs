import path from 'node:path';import {spawn} from 'node:child_process';import {configureProcessProxy} from '../src/network.mjs';
const index=process.argv.indexOf('--home');if(index>=0)process.env.CODEX_HOME=process.argv[index+1];const stateIndex=process.argv.indexOf('--state');if(stateIndex>=0)process.env.WORKBUDDY_STATE_DIR=process.argv[stateIndex+1];configureProcessProxy();
const child=spawn(process.execPath,['--use-env-proxy',path.resolve(import.meta.dirname,'../src/main.mjs')],{cwd:path.resolve(import.meta.dirname,'..'),env:process.env,windowsHide:true,stdio:'inherit'});
child.on('exit',code=>process.exit(code??1));child.on('error',()=>process.exit(1));
process.once('SIGINT',()=>child.kill('SIGINT'));process.once('SIGTERM',()=>child.kill('SIGTERM'));
