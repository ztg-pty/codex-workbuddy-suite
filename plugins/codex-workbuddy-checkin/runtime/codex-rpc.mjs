import {spawn} from 'node:child_process';import readline from 'node:readline';
export async function callCodex(exe,method,params={},options={}){
  const cp=spawn(exe,['app-server','--stdio',...(options.args??[])],{cwd:options.cwd??import.meta.dirname,env:options.env??process.env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  cp.stderr.resume();const pending=new Map();let seq=0;
  const fail=()=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('codex-rpc-failed'));}pending.clear();};
  cp.on('error',fail);cp.on('exit',fail);cp.stdin.on('error',fail);
  const lines=readline.createInterface({input:cp.stdout});lines.on('line',line=>{let message;try{message=JSON.parse(line);}catch{return;}
    const item=pending.get(message.id);if(!item)return;pending.delete(message.id);clearTimeout(item.timer);message.error?item.reject(new Error('codex-rpc-failed')):item.resolve(message.result);
  });
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('codex-rpc-timeout'));},options.timeoutMs??15000);pending.set(id,{resolve,reject,timer});cp.stdin.write(JSON.stringify({id,method,params})+'\n');});
  try{await rpc('initialize',{clientInfo:{name:'workbuddy_suite',version:'0.2.0'},capabilities:{experimentalApi:true}});cp.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');return await rpc(method,params);}
  finally{lines.close();cp.stdin.end();cp.kill();cp.stdout.destroy();cp.stderr.destroy();cp.stdin.destroy();fail();}
}
