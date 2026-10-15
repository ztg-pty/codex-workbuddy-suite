import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {spawn} from 'node:child_process';import readline from 'node:readline';import assert from 'node:assert/strict';
import {mergeCatalog,publicCatalog} from '../src/catalog.mjs';import {createGateway} from '../src/gateway.mjs';import * as adapter from '../src/responses.mjs';
const root=path.resolve(import.meta.dirname,'..');
const exe=process.env.CODEX_EXE??(process.platform==='win32'?path.join(root,'.qa/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'):path.join(root,'.qa/node_modules/.bin/codex'));
const home=await fs.mkdtemp(path.join(os.tmpdir(),'workbuddy-standalone-'));const report={realCredentialsRead:false,realInference:false,chatgptLoginRequired:false};let stage=0,calls=0;
const catalog=mergeCatalog({models:[]},[{id:'fixture',name:'Standalone fixture',contextWindow:32000}]);
const gateway=await createGateway({catalog,key:'fixture-management-key',authorize:async value=>value==='Bearer fixture-local-provider-key',adapter,
  workbuddyClient:{async streamChat(region,body){calls++;let frames;
    if(stage++===0){const tool=body.tools.find(tool=>tool.function.name.includes('echo_probe'));assert(tool);frames=[{choices:[{index:0,delta:{tool_calls:[{index:0,id:'call_standalone',type:'function',function:{name:tool.function.name,arguments:'{"value":"STANDALONE_TOOL_OK"}'}}]},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'tool_calls'}]}];}
    else{assert(body.messages.some(message=>message.role==='tool'&&message.tool_call_id==='call_standalone'));frames=[{choices:[{index:0,delta:{content:'STANDALONE_OK'},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:2,total_tokens:4}}];}
    return new Response(frames.map(frame=>'data: '+JSON.stringify(frame)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }}
});
const catalogPath=path.join(home,'catalog.json');await fs.writeFile(catalogPath,JSON.stringify(publicCatalog(catalog)));
await fs.writeFile(path.join(home,'config.toml'),'model_provider="fixture"\nmodel="workbuddy-cn/fixture"\nmodel_catalog_json='+JSON.stringify(catalogPath.replaceAll('\\','/'))+'\n[analytics]\nenabled=false\n[model_providers.fixture]\nname="Local fixture"\nbase_url="'+gateway.url+'"\nwire_api="responses"\nenv_key="WORKBUDDY_GATEWAY_TOKEN"\nrequires_openai_auth=false\nsupports_websockets=false\nrequest_max_retries=0\nstream_max_retries=0\n');
const env={...process.env,CODEX_HOME:home,WORKBUDDY_GATEWAY_TOKEN:'fixture-local-provider-key',NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost',HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',http_proxy:'',https_proxy:'',all_proxy:''};for(const key of ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL'])delete env[key];
const cp=spawn(exe,['app-server','--stdio','--strict-config'],{cwd:home,env,windowsHide:true,stdio:['pipe','pipe','pipe']});cp.stderr.resume();const pending=new Map(),notices=[];let seq=0;
cp.on('error',()=>{for(const item of pending.values())item.reject(new Error('kernel-start-failed'));pending.clear();});
const lines=readline.createInterface({input:cp.stdout});lines.on('line',line=>{let message;try{message=JSON.parse(line);}catch{return;}
  if(message.method&&message.id!==undefined){if(message.method==='item/tool/call')cp.stdin.write(JSON.stringify({id:message.id,result:{contentItems:[{type:'inputText',text:'STANDALONE_TOOL_OK'}],success:true}})+'\n');else cp.stdin.write(JSON.stringify({id:message.id,error:{code:-32601,message:'Fixture only'}})+'\n');}
  else if(pending.has(message.id)){const item=pending.get(message.id);pending.delete(message.id);message.error?item.reject(new Error(message.error.message)):item.resolve(message.result);}
  else if(message.method)notices.push(message);
});
const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>reject(new Error('kernel-timeout')),20000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});cp.stdin.write(JSON.stringify({id,method,params})+'\n');});
try{
  await rpc('initialize',{clientInfo:{name:'standalone_gate',version:'0.2.0'},capabilities:{experimentalApi:true}});cp.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  const account=await rpc('account/read',{refreshToken:false});report.accountPresent=!!account.account;assert.equal(report.accountPresent,false);
  const models=await rpc('model/list',{includeHidden:true});assert(models.data.some(model=>model.model==='workbuddy-cn/fixture'));
  const thread=await rpc('thread/start',{model:'workbuddy-cn/fixture',modelProvider:'fixture',cwd:home,ephemeral:true,approvalPolicy:'never',sandbox:'danger-full-access',dynamicTools:[{type:'namespace',name:'fixture',description:'Synthetic local tool',tools:[{type:'function',name:'echo_probe',description:'Echo fixture',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}}]}]});
  const turn=await rpc('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:'Use echo_probe once then reply STANDALONE_OK.',text_elements:[]}]});
  const deadline=Date.now()+25000;let done;while(Date.now()<deadline){done=notices.find(message=>message.method==='turn/completed'&&message.params.turn.id===turn.turn.id);if(done)break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal(done?.params.turn.status,'completed');assert.equal(calls,2);report.passed=true;report.toolRoundtrip=true;
}catch(error){report.passed=false;report.error=error.message;process.exitCode=1;}
finally{lines.close();cp.stdin.end();cp.kill();if(cp.exitCode===null&&cp.pid)await new Promise(resolve=>{cp.once('exit',resolve);setTimeout(resolve,2000).unref();});cp.stdout.destroy();cp.stderr.destroy();cp.stdin.destroy();await gateway.close();try{await fs.rm(home,{recursive:true,force:true,maxRetries:3,retryDelay:100});}catch(error){report.fixtureCleanup=error.code;}}
await fs.mkdir(path.join(root,'verification'),{recursive:true});await fs.writeFile(path.join(root,'verification','standalone.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
