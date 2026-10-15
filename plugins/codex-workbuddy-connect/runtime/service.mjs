import fs from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {assertSupportedPlatform} from './platform.mjs';
import {atomicWrite,readOptional} from './install-state.mjs';

const runFile=promisify(execFile);
export const serviceName='CodexWorkBuddySuite';
export const launchAgentName='com.ztgpty.codex-workbuddy-suite';
const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const sh=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
export function launchAgentPlist({node,root,home,state}) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>'+launchAgentName+'</string><key>ProgramArguments</key><array>'+[node,path.join(root,'scripts','daemon.mjs'),'--home',home].map(value=>'<string>'+xml(value)+'</string>').join('')+'</array><key>RunAtLoad</key><true/><key>EnvironmentVariables</key><dict><key>CODEX_HOME</key><string>'+xml(home)+'</string><key>WORKBUDDY_STATE_DIR</key><string>'+xml(state)+'</string></dict><key>StandardOutPath</key><string>'+xml(path.join(state,'service.stdout.log'))+'</string><key>StandardErrorPath</key><string>'+xml(path.join(state,'service.stderr.log'))+'</string></dict></plist>\n';
}
export function createService({root,home,state,node=process.execPath,platform=process.platform,userHome=homedir(),env=process.env,run=runFile,spawnProcess=spawn}={}) {
  assertSupportedPlatform(platform);
  const helper=path.join(root,'scripts','service-win.ps1');
  const plist=path.join(userHome,'Library','LaunchAgents',launchAgentName+'.plist');
  const expected=launchAgentPlist({node,root,home,state});
  const powershell=path.win32.join(env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const win=action=>run(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-Action',action,'-NodePath',node,'-RootPath',root,'-CodexHome',home,'-StatePath',state],{windowsHide:true,timeout:15000,maxBuffer:65536,env});
  const checkPlist=async()=>{const current=await readOptional(plist);if(current&&current!==expected)throw new Error('service-owned-by-another-installation');return current;};
  const uid=()=>{if(typeof process.getuid!=='function')throw new Error('mac-service-uid-unavailable');return process.getuid();};
  return {
    info:{platform,name:platform==='win32'?serviceName:launchAgentName,...platform==='darwin'?{plist}:{}},
    async install(){if(platform==='win32')await win('install');else{await checkPlist();await atomicWrite(plist,expected);await run('/bin/launchctl',['bootstrap','gui/'+uid(),plist],{timeout:15000}).catch(error=>{if(!/already|loaded|in progress/i.test(error.stderr??''))throw new Error('launchagent-bootstrap-failed');});}return this.info;},
    async start(){if(platform==='win32')await win('start');else{await checkPlist();await run('/bin/launchctl',['enable','gui/'+uid()+'/'+launchAgentName],{timeout:15000});await run('/bin/launchctl',['kickstart','gui/'+uid()+'/'+launchAgentName],{timeout:15000});}},
    async stop(){if(platform==='win32')await win('stop');else if(await checkPlist())await run('/bin/launchctl',['disable','gui/'+uid()+'/'+launchAgentName],{timeout:15000});},
    async remove(){if(platform==='win32')await win('remove');else if(await checkPlist()){await run('/bin/launchctl',['bootout','gui/'+uid(),plist],{timeout:15000}).catch(()=>{});await fs.unlink(plist);}},
    async startDirect(){await fs.mkdir(state,{recursive:true});const out=await fs.open(path.join(state,'service.stdout.log'),'a',0o600);const err=await fs.open(path.join(state,'service.stderr.log'),'a',0o600);try{const child=spawnProcess(node,[path.join(root,'scripts','daemon.mjs'),'--home',home,'--state',state],{cwd:root,env:{...env,CODEX_HOME:home,WORKBUDDY_STATE_DIR:state},detached:true,windowsHide:true,stdio:['ignore',out.fd,err.fd]});child.unref();}finally{await out.close();await err.close();}},
    async shortcuts(){
      if(platform==='win32'){await win('shortcuts');return {created:true};}
      const desktop=path.join(userHome,'Desktop');await fs.mkdir(desktop,{recursive:true});
      const files=[];for(const[action,label]of [['launch','Codex WorkBuddy'],['usage','WorkBuddy Usage']]){const file=path.join(desktop,label+'.command');const current=await readOptional(file);const body='#!/bin/sh\n# workbuddy-suite: '+root+'\nexec '+sh(node)+' '+sh(path.join(root,'scripts','manage.mjs'))+' '+action+' --home '+sh(home)+' --state '+sh(state)+'\n';if(current&&current!==body)throw new Error('shortcut-owned-by-another-installation');await atomicWrite(file,body);await fs.chmod(file,0o700);files.push({path:file,content:body});}return {created:true,files};
    },
    async removeShortcuts(info){if(platform==='win32'){await win('remove-shortcuts');return;}for(const item of info?.files??[]){if(await readOptional(item.path)===item.content)await fs.unlink(item.path);}}
  };
}
