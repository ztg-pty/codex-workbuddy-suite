import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertSupportedPlatform } from './platform.mjs';
const run=promisify(execFile);
export function startupTransition(previous,current){return current.length>0&&(previous.length===0||!current.some(id=>previous.includes(id)));}
export async function desktopSessions({platform=process.platform,run:execute=run}={}){
  assertSupportedPlatform(platform);
  if(platform==='darwin'){
    try{
      const {stdout}=await execute('/bin/ps',['-axo','pid=,command='],{timeout:6000,maxBuffer:1024*1024});
      return stdout.split('\n').flatMap(line=>{
        const match=/^\s*(\d+)\s+(.+)$/u.exec(line);
        if(!match||/--type=/u.test(match[2]))return [];
        return /^(?:\/Applications|\/Users\/[^/]+\/Applications)\/(ChatGPT|Codex)\.app\/Contents\/MacOS\/\1(?:\s|$)/u.test(match[2])?[match[1]]:[];
      });
    }catch{return [];}
  }
  const command="Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe' OR Name='Codex.exe'\" | Where-Object { $_.ExecutablePath -match 'WindowsApps.*OpenAI.Codex.*\\\\app\\\\(ChatGPT|Codex)\\.exe$' -and $_.CommandLine -notmatch '--type=' } | Select-Object -ExpandProperty ProcessId | ConvertTo-Json -Compress";
  try{const {stdout}=await execute('powershell.exe',['-NoProfile','-Command',command],{windowsHide:true,timeout:6000});const result=JSON.parse(stdout||'[]');return(Array.isArray(result)?result:[result]).filter(Number.isInteger).map(String);}catch{return [];}
}
