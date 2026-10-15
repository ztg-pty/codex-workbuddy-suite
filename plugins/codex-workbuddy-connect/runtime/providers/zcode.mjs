// ZCode provider: a streamChat-shaped adapter over the Anthropic Messages
// endpoint, matching the interface the gateway already uses for WorkBuddy.
//
// Transport facts verified against jjjane233/workbuddy-3in1:
//   - zcode.z.ai/api/v1/zcode-plan/anthropic returns 405 + code 3012 for
//     non-official clients, so chat goes to open.bigmodel.cn (preferred) with
//     api.z.ai as fallback, both under /api/anthropic/v1/messages;
//   - the "<keyId>.<secret>" credential is used directly as x-api-key and
//     Authorization: Bearer, with no JWT and no client signature on that host.
import {discoverZCodeAccount,discoverZCodeCredential} from './zcode-credentials.mjs';
import {createSigner,DEFAULT_APP_VERSION,ZCodeSignError} from './zcode-sign.mjs';
import {anthropicEventToOpenAI,anthropicStopReasonToOpenAI,newAnthropicState,toAnthropicRequest} from './zcode-convert.mjs';

export class ZCodeError extends Error {
  constructor(code){super(`ZCode: ${code}`);this.name='ZCodeError';this.code=code;}
}

export const ZCODE_CHAT_HOSTS=[
  {host:'https://open.bigmodel.cn',path:'/api/anthropic/v1/messages',family:'bigmodel'},
  {host:'https://api.z.ai',path:'/api/anthropic/v1/messages',family:'zai'},
];
// Model capability catalog the official client reads anonymously. It lives on
// the zcode-plan host (the BigModel/Z.AI hosts 404 this path) and needs no
// credential. Shape: data.providers[].models[] with modelId/contextWindow.
export const ZCODE_CONFIG_PATH='/api/v1/client/configs';
export const ZCODE_CONFIG_HOST='https://zcode.z.ai';

export function modelsFromClientConfig(payload){
  const providers=payload?.data?.providers;
  const list=Array.isArray(providers)
    ?providers.flatMap(provider=>provider?.models??[])
    :Array.isArray(payload?.data?.builtinModels)?payload.data.builtinModels:[];
  const byId=new Map();
  for(const entry of list){
    const id=entry?.modelId??entry?.id??entry?.model;
    if(typeof id!=='string'||!id)continue;
    const model={id,name:entry.name??id};
    const context=Number(entry.contextWindow??entry.maxInputTokens);
    if(Number.isFinite(context)&&context>0)model.contextWindow=context;
    const maxOut=Number(entry.maxCompletionTokens??entry.maxOutputTokens);
    if(Number.isFinite(maxOut)&&maxOut>0)model.maxOutputTokens=maxOut;
    const capabilities=entry.capabilities??{};
    if(capabilities.vision===true||capabilities.image===true||entry.vision===true)model.supportsImages=true;
    const reasoning=entry.reasoning;
    const levels=reasoning&&typeof reasoning==='object'?Object.keys(reasoning.levels??{}).filter(level=>['low','medium','high','xhigh','max'].includes(level)):[];
    if(reasoning&&typeof reasoning==='object'&&Object.keys(reasoning).length){
      model.supportsReasoning=true;model.reasoning={supported:true};
      if(levels.length)model.reasoning.supportedEfforts=levels;
      if(reasoning.defaultLevel)model.reasoning.defaultEffort=reasoning.defaultLevel;
    }
    // The same model id can appear under several providers; keep the widest
    // declared context so the menu does not under-report capacity.
    const existing=byId.get(id);
    if(!existing)byId.set(id,model);
    else if((model.contextWindow??0)>(existing.contextWindow??0))byId.set(id,{...existing,...model});
  }
  return [...byId.values()];
}

function readSseFrames(buffer){
  const frames=[];let rest=buffer;
  while(true){
    const split=rest.indexOf('\n\n');
    if(split<0)break;
    const raw=rest.slice(0,split);rest=rest.slice(split+2);
    const dataLines=raw.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim());
    if(!dataLines.length)continue;
    const payload=dataLines.join('\n');
    if(payload==='[DONE]'){frames.push({done:true});continue;}
    try{frames.push({event:JSON.parse(payload)});}catch{}
  }
  return {frames,rest};
}

export function createZCodeClient({fetchImpl=fetch,appVersion=DEFAULT_APP_VERSION,platform=process.platform,env=process.env,home,credential,readFile}={}){
  let cachedCredential=credential;
  const resolve=async()=>{
    if(cachedCredential)return cachedCredential;
    const found=await discoverZCodeCredential({platform,env,home,readFile});
    if(!found)throw new ZCodeError('no-local-credential');
    cachedCredential=found.value;return cachedCredential;
  };

  const getAccountStatus=async()=>{
    let value;
    try{value=await resolve();}
    catch{return {region:'zcode',loggedIn:false,error:'no-local-credential'};}
    const account=await discoverZCodeAccount({platform,env,home,readFile});
    const status={region:'zcode',loggedIn:true,models:[]};
    if(account)status.uid=account.uid;
    else if(value){const dot=value.indexOf('.');if(dot>0)status.uid='zcode-'+value.slice(0,dot).slice(0,12);}
    try{status.models=await getModels();}catch{}
    return status;
  };

  const getModels=async()=>{
    try{
      const response=await fetchImpl(`${ZCODE_CONFIG_HOST}${ZCODE_CONFIG_PATH}?app_version=${encodeURIComponent(appVersion)}&platform=${encodeURIComponent(clientPlatform(platform))}`,{headers:{accept:'application/json'},signal:AbortSignal.timeout(15000)});
      if(!response.ok){await response.body?.cancel?.().catch?.(()=>{});return [];}
      const payload=await response.json();
      if(payload?.code!==0&&payload?.code!==undefined&&payload?.code!==200)return [];
      return modelsFromClientConfig(payload);
    }catch{}
    return [];
  };

  const streamChat=async(body,{signal,modelMetadata}={})=>{
    const credentialValue=await resolve();
    const request=toAnthropicRequest(body,{model:modelMetadata?.id??body.model});
    const sessionId=(modelMetadata?.sessionId)||credentialValue.slice(0,credentialValue.indexOf('.'));
    // Signing is required by the zcode-plan host. On the BigModel/Z.AI hosts the
    // credential alone authenticates, so a signature failure degrades to an
    // unsigned request instead of failing the turn.
    let signature;
    try{const signer=createSigner({credential:credentialValue,clientVersion:appVersion,fetchImpl});signature=await signer.signingHeaders({sessionId,signal});}
    catch(error){if(!(error instanceof ZCodeSignError))throw error;}
    let lastError='zcode-unreachable';
    for(const {host,path} of ZCODE_CHAT_HOSTS){
      let response;
      const headers={
        'content-type':'application/json',
        'anthropic-version':'2023-06-01',
        'x-api-key':credentialValue,
        authorization:`Bearer ${credentialValue}`,
        'user-agent':`ZCode/${appVersion}`,
        'x-zcode-app-version':appVersion,
        ...(request.stream?{accept:'text/event-stream'}:{accept:'application/json'}),
        ...(signature??{}),
      };
      try{response=await fetchImpl(host+path,{method:'POST',headers,body:JSON.stringify(request),signal});}
      catch(error){
        if(error?.name==='AbortError')throw error;
        lastError='zcode-unreachable';continue;
      }
      if(response.status===401||response.status===403){await response.body?.cancel?.().catch?.(()=>{});throw new ZCodeError('upstream-auth');}
      if(response.status===429){await response.body?.cancel?.().catch?.(()=>{});throw new ZCodeError('upstream-rate');}
      if(response.status===402){await response.body?.cancel?.().catch?.(()=>{});throw new ZCodeError('upstream-credit');}
      if(!response.ok){
        let text='';try{text=(await response.text()).slice(0,400);}catch{}
        if(/\b3012\b|unusual activity/u.test(text)){lastError='unusual-activity';continue;}
        throw new ZCodeError('upstream-rejected');
      }
      if(!request.stream)return new Response(JSON.stringify(convertWholeResponse(await response.json())),{status:200,headers:{'content-type':'application/json'}});
      return new Response(convertStream(response.body,signal),{status:200,headers:{'content-type':'text/event-stream'}});
    }
    throw new ZCodeError(lastError);
  };

  return {getAccountStatus,getModels,streamChat,resolveCredential:resolve};
}
function clientPlatform(platform){return platform==='win32'?'win32-x64':platform==='darwin'?'darwin-arm64':'linux-x64';}

function convertWholeResponse(payload){
  const blocks=Array.isArray(payload?.content)?payload.content:[];
  let text='';const toolCalls=[];let reasoning='';
  for(const block of blocks){
    if(block?.type==='text')text+=block.text??'';
    else if(block?.type==='thinking')reasoning+=block.thinking??'';
    else if(block?.type==='tool_use'){
      toolCalls.push({id:block.id,type:'function',function:{name:block.name,arguments:JSON.stringify(block.input??{})}});
    }
  }
  const message={role:'assistant',content:text};
  if(reasoning)message.reasoning_content=reasoning;
  if(toolCalls.length)message.tool_calls=toolCalls;
  const finish=anthropicStopReasonToOpenAI(payload?.stop_reason);
  return {id:`chatcmpl_${payload?.id??'zcode'}`,object:'chat.completion',model:payload?.model??'zcode',choices:[{index:0,message,finish_reason:finish}],usage:toOpenAIUsage(payload?.usage)};
}
function toOpenAIUsage(usage){
  if(!usage||typeof usage!=='object')return undefined;
  const prompt=Number(usage.input_tokens??0);
  const completion=Number(usage.output_tokens??0);
  return {prompt_tokens:prompt,completion_tokens:completion,total_tokens:prompt+completion};
}

// Re-emit Anthropic SSE as OpenAI chat-completions frames, which is the shape
// the existing responses.mjs adapter consumes.
export async function*convertStream(body,signal){
  const decoder=new TextDecoder();let buffer='';const state=newAnthropicState();
  for await(const chunk of body){
    if(signal?.aborted)return;
    buffer+=decoder.decode(chunk,{stream:true});
    const {frames,rest}=readSseFrames(buffer);buffer=rest;
    for(const frame of frames){
      if(frame.done){yield `data: [DONE]\n\n`;continue;}
      const deltas=anthropicEventToOpenAI(frame.event,state);
      for(const delta of deltas){
        if(delta.error){yield `data: ${JSON.stringify({error:delta.error})}\n\n`;continue;}
        yield `data: ${JSON.stringify({object:'chat.completion.chunk',choices:[{index:0,delta:delta.choice.delta,finish_reason:null}]})}\n\n`;
      }
    }
  }
  const finish=anthropicStopReasonToOpenAI(state.stopReason);
  const final={object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:finish}]};
  if(state.usage)final.usage=state.usage;
  yield `data: ${JSON.stringify(final)}\n\n`;
  yield `data: [DONE]\n\n`;
}
