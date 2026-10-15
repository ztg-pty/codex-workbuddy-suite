// Read-only discovery of the signing credential that the local ZCode client
// already holds. Reimplements the findings of jjjane233/workbuddy-3in1
// (MIT): the client resolves "<keyId>.<secret>" itself and persists it, so the
// gateway only has to read that product. We never write client state.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createDecipheriv,createHash,createHmac} from 'node:crypto';

export const CREDENTIAL_KEYS=['builtin:bigmodel-coding-plan','builtin:zai-coding-plan','builtin:zcode-plan'];

// The client encrypts with os.platform(), so Windows is "win32", not "windows".
export function platformTag(platform=process.platform){return platform==='win32'?'win32':platform==='darwin'?'darwin':'linux';}

export function clientConfigPaths({platform=process.platform,env=process.env,home}={}){
  const out=[];
  const base=home??env.USERPROFILE??env.HOME;
  if(base)out.push(path.join(base,'.zcode','v2','config.json'));
  if(platform==='win32'&&env.APPDATA)out.push(path.join(env.APPDATA,'ZCode','config.json'));
  if(platform==='darwin'&&base)out.push(path.join(base,'Library','Application Support','ZCode','config.json'));
  return out;
}
export function credentialsPaths({platform=process.platform,env=process.env,home}={}){
  const out=[];const base=home??env.USERPROFILE??env.HOME;
  if(base)out.push(path.join(base,'.zcode','v2','credentials.json'));
  if(platform==='win32'&&env.APPDATA)out.push(path.join(env.APPDATA,'ZCode','credentials.json'));
  return out;
}

// "enc:v1:" values are AES-256-GCM. Key derivation mirrors the client: a
// machine-bound secret hashed with the platform tag. We only decrypt values the
// client itself wrote; an undecryptable value is reported as absent.
export function decryptCredential(value,{platform=process.platform,machineId}={}){
  if(typeof value!=='string'||!value.startsWith('enc:v1:'))return value;
  if(!machineId)return undefined;
  try{
    const payload=Buffer.from(value.slice(7),'base64');
    const nonce=payload.subarray(0,12);
    const tag=payload.subarray(payload.length-16);
    const ciphertext=payload.subarray(12,payload.length-16);
    const key=createHash('sha256').update(`${machineId}\0${platformTag(platform)}\0zcode-credential-v1`).digest();
    const decipher=createDecipheriv('aes-256-gcm',key,nonce,{authTagLength:16});
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8');
  }catch{return undefined;}
}

function collectCredentials(node,out,seen){
  if(!node||typeof node!=='object')return;
  if(seen.has(node))return;seen.add(node);
  if(Array.isArray(node)){for(const item of node)collectCredentials(item,out,seen);return;}
  for(const [key,value] of Object.entries(node)){
    if(key==='apiKey'&&typeof value==='string'&&isSignCredential(value))out.push({key,value});
    else collectCredentials(value,out,seen);
  }
}
export function isSignCredential(value){
  if(typeof value!=='string')return false;
  const dot=value.indexOf('.');
  if(dot<=0||dot===value.length-1)return false;
  return /^[0-9a-f]{16,64}$/i.test(value.slice(0,dot))&&value.length-dot-1>=8;
}

function parseCredentialDocument(raw,options){
  let doc;try{doc=JSON.parse(raw);}catch{return undefined;}
  const found=[];
  for(const wanted of CREDENTIAL_KEYS){
    const provider=doc?.provider?.[wanted];
    const apiKey=provider?.options?.apiKey;
    if(typeof apiKey==='string'&&isSignCredential(apiKey))return {value:apiKey,provider:wanted,source:'provider'};
  }
  collectCredentials(doc,found,new Set());
  if(found.length)return {value:found[0].value,provider:undefined,source:'inline'};
  return undefined;
}

// Returns {value, provider, source, path} or undefined when the machine has no
// usable ZCode signing credential. Missing files are normal, not errors.
export async function discoverZCodeCredential({platform=process.platform,env=process.env,home,readFile=fs.readFile}={}){
  for(const file of clientConfigPaths({platform,env,home})){
    let raw;try{raw=await readFile(file,'utf8');}catch{continue;}
    const parsed=parseCredentialDocument(raw,{platform});
    if(parsed)return {...parsed,path:file};
  }
  return undefined;
}

export function jwtUid(token){
  if(typeof token!=='string')return undefined;
  const parts=token.split('.');
  if(parts.length!==3)return undefined;
  try{
    const payload=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
    for(const value of [payload.user_id,payload.sub]){
      if(typeof value==='string'&&value.trim())return value.trim();
      if(typeof value==='number'&&value)return String(value);
    }
  }catch{}
  return undefined;
}
export async function discoverZCodeAccount({platform=process.platform,env=process.env,home,readFile=fs.readFile}={}){
  for(const file of credentialsPaths({platform,env,home})){
    let raw;try{raw=await readFile(file,'utf8');}catch{continue;}
    let doc;try{doc=JSON.parse(raw);}catch{continue;}
    for(const [key,value] of Object.entries(doc)){
      if(!key.endsWith(':user_info')||typeof value!=='string'||!value.trim())continue;
      try{const info=JSON.parse(value);const uid=info.id??info.customer_id??info.user_id;if(uid)return {uid:String(uid),path:file};}catch{}
    }
    const token=doc.zcodejwttoken;
    if(typeof token==='string'&&token.trim()){const uid=jwtUid(token);if(uid)return {uid,path:file};}
  }
  return undefined;
}
