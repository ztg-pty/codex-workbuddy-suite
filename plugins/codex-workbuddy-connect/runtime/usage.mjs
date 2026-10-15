import {spawn} from 'node:child_process';
import readline from 'node:readline';

export function normalizeOfficialUsage(result){
  const snapshot=result.rateLimitsByLimitId?.codex??result.rateLimits;
  if(!snapshot)throw new Error('official-usage-unavailable');
  const windows=[snapshot.primary,snapshot.secondary].filter(window=>window&&Number.isFinite(window.usedPercent)).map(window=>({
    remainingPercent:Math.max(0,Math.min(100,100-window.usedPercent)),durationMins:window.windowDurationMins??null,resetsAt:window.resetsAt??null
  }));
  return {plan:snapshot.planType??null,windows,credits:typeof snapshot.credits?.balance==='string'?snapshot.credits.balance:null};
}

// Read quota through the installed app-server protocol. No inference, login,
// reset-credit redemption, or account credential is exposed to the panel.
export async function readOfficialUsage({exe,timeoutMs=15000}){
  const cp=spawn(exe,['app-server','--stdio'],{cwd:import.meta.dirname,windowsHide:true,
    env:{...process.env,NO_PROXY:process.env.NO_PROXY??'127.0.0.1,localhost,::1'},stdio:['pipe','pipe','pipe']});
  cp.stderr.resume();let sequence=0;const pending=new Map();
  const fail=()=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('official-usage-unavailable'));}pending.clear();};
  cp.on('error',fail);cp.on('exit',fail);cp.stdin.on('error',fail);
  const lines=readline.createInterface({input:cp.stdout});
  lines.on('line',line=>{let message;try{message=JSON.parse(line);}catch{return;}
    const item=pending.get(message.id);if(!item)return;pending.delete(message.id);clearTimeout(item.timer);
    message.error?item.reject(new Error('official-usage-unavailable')):item.resolve(message.result);
  });
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('official-usage-unavailable'));},timeoutMs);
    pending.set(id,{resolve,reject,timer});cp.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
  try{
    await rpc('initialize',{clientInfo:{name:'workbuddy_usage_panel',version:'0.1.0'},capabilities:{experimentalApi:true}});
    cp.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
    return normalizeOfficialUsage(await rpc('account/rateLimits/read',{excludeResetCreditDetails:true}));
  }finally{lines.close();cp.stdin.end();cp.kill();fail();}
}

export function createUsageReader({readOfficial,readAccount,ttlMs=60000,now=Date.now}){
  let cached,expiresAt=0,inflight;
  return async()=>{
    if(cached&&now()<expiresAt)return cached;
    if(inflight)return inflight;
    inflight=(async()=>{
      const results=await Promise.allSettled([Promise.resolve().then(readOfficial),...['cn','intl'].map(region=>Promise.resolve().then(()=>readAccount(region)))]);
      const updatedAt=new Date(now()).toISOString();
      const official=results[0].status==='fulfilled'?{...results[0].value,status:'ok',updatedAt}:{status:'unavailable',updatedAt,windows:[],credits:null};
      const workbuddy=['cn','intl'].map((region,index)=>{
        const result=results[index+1];const account=result.status==='fulfilled'?result.value:null;
        const credits=account?.loggedIn&&Number.isFinite(account.credits)?account.credits:null;
        return {region,status:credits!==null?'ok':account?.loggedIn===false?'login-required':'unavailable',credits,updatedAt};
      });
      cached={official,workbuddy,checkedAt:updatedAt,refreshSeconds:ttlMs/1000};expiresAt=now()+ttlMs;return cached;
    })();
    try{return await inflight;}finally{inflight=undefined;}
  };
}
