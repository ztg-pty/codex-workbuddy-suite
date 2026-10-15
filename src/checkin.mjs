/**
 * Current CN account only. Endpoint/result handling adapted from Corrine Hu's
 * dsh-buddy-checkin @ b8f521914c6847b30e0fefb5f9b81f1c36e5d66d (MIT).
 * Original notice: upstream/checkin-reference/LICENSE. Historical-account
 * discovery is intentionally absent. No automatic retries or polling loop.
 */
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import * as defaultClient from './workbuddy.mjs';
import { redactUid } from './workbuddy.mjs';

export function shanghaiServerDay(serverDate) {
  if(typeof serverDate!=='string'||!serverDate)return undefined;
  const stamp=Date.parse(serverDate);if(!Number.isFinite(stamp))return undefined;
  const date=new Date(stamp);const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const value=type=>parts.find(part=>part.type===type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
const failed=(error,extra={})=>({region:'cn',state:'failed',error,...extra});
async function load(path) {
  let raw;try{raw=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return {version:1,completed:{}};return undefined;}
  if(raw?.version!==1||!raw.completed||typeof raw.completed!=='object'||Array.isArray(raw.completed))return undefined;
  // Trust only fields the adapter writes. Raw state never reaches the caller.
  const completed={};for(const [key,value]of Object.entries(raw.completed))if(/^\d{4}-\d{2}-\d{2}:uid-[a-f0-9]{12}$/u.test(key)&&value&&['signed','already'].includes(value.state)&&typeof value.at==='string')completed[key]={state:value.state,at:value.at,...typeof value.credit==='number'&&Number.isFinite(value.credit)?{credit:value.credit}:{}};
  return {version:1,completed};
}
async function save(path,document) {
  const temporary=`${path}.${randomUUID()}.tmp`;let handle;
  try{handle=await open(temporary,'wx',0o600);await handle.writeFile(`${JSON.stringify(document,null,2)}\n`);await handle.sync();await handle.close();handle=undefined;await rename(temporary,path);}finally{await handle?.close().catch(()=>{});await rm(temporary,{force:true}).catch(()=>{});}
}
async function acquire(path) {
  try{const handle=await open(path,'wx',0o600);await handle.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString()}));return handle;}
  catch(error){if(error.code==='EEXIST')return undefined;throw error;}
}
export async function checkCurrentAccount({stateDir=join(homedir(),'.workbuddy-codex'),client=defaultClient,signal}={}) {
  let credential;try{credential=await client.getCredential('cn');}catch{return failed('auth-unreadable');}
  if(!credential)return {region:'cn',loggedIn:false,state:'skipped'};
  if(!credential.uid)return failed('account-identity-unavailable');
  const uid=redactUid(credential.uid,'cn');
  try{await mkdir(stateDir,{recursive:true,mode:0o700});}catch{return failed('state-unwritable',{uid});}
  const lockPath=join(stateDir,'checkin.lock');let lock;
  try{lock=await acquire(lockPath);}catch{return failed('state-unwritable',{uid});}
  if(!lock)return {region:'cn',uid,state:'busy'};
  try{
    const path=join(stateDir,'checkin.json');const document=await load(path);if(!document)return failed('state-unreadable',{uid});
    // Billing is read-only and supplies the server's Date header. Do not use
    // the local clock to decide whether another check-in is allowed.
    let balance;try{balance=await client.readCredits('cn',{credential,signal});}catch{return failed('balance-unavailable',{uid});}
    const day=shanghaiServerDay(balance.serverDate);if(!day)return failed('server-date-unavailable',{uid});
    const key=`${day}:${uid}`;const previous=document.completed[key];
    if(previous)return {region:'cn',uid,state:'already',day,credits:balance.credits};
    // Account switch while the read-only request was in flight must not sign
    // the former identity after the desktop app made another one current.
    let current;try{current=await client.getCredential('cn');}catch{return failed('auth-unreadable',{uid,day});}
    if(!current||current.uid!==credential.uid||current.enterpriseId!==credential.enterpriseId)return failed('account-changed',{uid,day});
    let response;try{response=await client.checkinRequest(current,{signal});}catch{return failed('checkin-transport',{uid,day});}
    let body;try{body=await response.json();}catch{return failed('checkin-response-invalid',{uid,day});}
    const already=typeof body?.msg==='string'&&(/已签到/u.test(body.msg)||/already\s+(?:checked[ -]?in|signed[ -]?in)/iu.test(body.msg));
    // A successful HTTP status alone cannot make a nonzero business code
    // successful. Require an explicit zero code, or a recognised already result.
    if(!already&&(!response.ok||body?.code!==0))return failed('checkin-rejected',{uid,day});
    const responseDay=shanghaiServerDay(response.headers.get('date'));if(!responseDay)return failed('server-date-unavailable',{uid,day});
    const state=already?'already':'signed';const credit=!already&&typeof body?.data?.credit==='number'&&Number.isFinite(body.data.credit)?body.data.credit:undefined;
    const savedKey=`${responseDay}:${uid}`;
    document.completed[savedKey]={state,at:new Date().toISOString(),...credit===undefined?{}:{credit}};
    // Keep a short, safe history; each key includes the account and server day.
    const days=[...new Set(Object.keys(document.completed).map(item=>item.slice(0,10)))].sort().slice(-7);
    document.completed=Object.fromEntries(Object.entries(document.completed).filter(([item])=>days.includes(item.slice(0,10))));
    try{await save(path,document);}catch{return failed('state-save-failed',{uid,day:responseDay});}
    return {region:'cn',uid,state,day:responseDay,credits:balance.credits,...credit===undefined?{}:{credit}};
  }finally{await lock.close().catch(()=>{});await rm(lockPath,{force:true}).catch(()=>{});}
}
