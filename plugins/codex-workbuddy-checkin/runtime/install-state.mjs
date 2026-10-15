import fs from 'node:fs/promises';import path from 'node:path';import {randomBytes,timingSafeEqual} from 'node:crypto';
export function mergeEnvironment(original,{token}){
  const changes=[];let text=original.replaceAll('\r\n','\n');
  for(const [key,value]of Object.entries({WORKBUDDY_GATEWAY_TOKEN:token,NO_PROXY:[...new Set([...(text.match(/^NO_PROXY\s*=\s*(.*)$/m)?.[1]??'').replace(/^["']|["']$/g,'').split(',').filter(Boolean),'127.0.0.1','localhost','::1'])].join(',')})){
    const pattern=new RegExp('^'+key+'\\s*=[^\\n]*$','m');const old=text.match(pattern)?.[0];const next=key+'='+value;
    text=old?text.replace(pattern,next):text.replace(/\n*$/,'\n')+next+'\n';changes.push({key,old,next});
  }
  return {text,changes};
}
export function restoreEnvironment(current,changes){let text=current.replaceAll('\r\n','\n');for(const change of changes){const pattern=new RegExp('^'+change.key+'\\s*=[^\\n]*$','m');if(text.match(pattern)?.[0]!==change.next)throw new Error('Managed environment changed: '+change.key);text=change.old?text.replace(pattern,change.old):text.replace(new RegExp('^'+change.key+'\\s*=[^\\n]*\\n?','m'),'');}return text;}
export async function readOptional(file,fallback=''){try{return await fs.readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return fallback;throw error;}}
export async function atomicWrite(file,content){const temp=file+'.suite-'+randomBytes(6).toString('hex');await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(temp,content,{mode:0o600});try{await fs.rename(temp,file);}catch(error){await fs.unlink(temp).catch(()=>{});throw error;}}
export function equalsToken(actual,expected){const a=Buffer.from(actual??''),b=Buffer.from(expected??'');return a.length===b.length&&timingSafeEqual(a,b);}
