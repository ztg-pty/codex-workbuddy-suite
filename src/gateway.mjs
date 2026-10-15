import http from 'node:http';
import { randomUUID,timingSafeEqual } from 'node:crypto';
import { modelRoute,publicCatalog } from './catalog.mjs';
import {createQueue,QueueFullError,QueueTimeoutError,QueueAbortedError,withRetry,isRetryableBeforeStream} from './queue.mjs';

function keyEquals(a,b){const aa=Buffer.from(a??''),bb=Buffer.from(b??'');return aa.length===bb.length&&timingSafeEqual(aa,bb);}
function json(res,status,body){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));}
async function readJson(req){let n=0;const chunks=[];for await(const chunk of req){n+=chunk.length;if(n>128*1024*1024)throw Object.assign(new Error('Request too large'),{status:413});chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(new Error('Invalid JSON'),{status:400});}}
async function writeChunk(res,chunk){if(!res.write(chunk))await new Promise((resolve,reject)=>{res.once('drain',resolve);res.once('error',reject);});}
function officialHeaders(headers){const output={};for(const [key,value]of Object.entries(headers)){
  if(typeof value==='string'&&(['authorization','chatgpt-account-id','content-type','accept','user-agent','originator','version','session_id'].includes(key)||key.startsWith('x-codex-')))output[key]=value;
}return output;}
export function normalizeOfficialReplay(body){
  if(!Array.isArray(body.input))return body;
  const input=[];
  for(const item of body.input){
    if(item.type==='reasoning'&&!item.encrypted_content){
      const summary=(item.summary??[]).map(part=>part.text??'').join('\n');
      if(summary)input.push({type:'message',role:'assistant',content:[{type:'output_text',text:'Previous model reasoning summary:\n'+summary}]});
      continue;
    }
    if((item.type==='message'&&item.content)||(['function_call','custom_tool_call'].includes(item.type))){const{id,...inline}=item;input.push(inline);}
    else input.push(item);
  }
  return{...body,input};
}
export async function createGateway({catalog,key,workbuddyClient,zcodeClient,adapter,officialBaseUrl='https://chatgpt.com/backend-api/codex',fetchImpl=fetch,port=0,onRoute=()=>{},getStatus=async()=>({}),authorize=async()=>false,management={},usagePanel,officialAuth,queues}) {
  // Official models are never queued. WorkBuddy runs without a concurrency cap
  // (unlimited limit) but still passes through the queue so an upstream 429 can
  // be retried instead of reaching the client. ZCode is capped per the user's
  // configuration, defaulting to four in flight.
  const providerQueues=queues??{
    workbuddy:createQueue({provider:'workbuddy',limit:Infinity,maxWaiting:256,waitTimeoutMs:300000}),
    zcode:createQueue({provider:'zcode',limit:Number(process.env.WORKBUDDY_ZCODE_CONCURRENCY??4),maxWaiting:64,waitTimeoutMs:180000}),
  };
  // Only failures raised while opening the upstream response are retried; a
  // stream that already delivered bytes must not be replayed.
  const retryOptions={retries:6,baseDelayMs:800,maxDelayMs:10000,isRetryable:error=>isRetryableBeforeStream(error)};
  const server=http.createServer(async(req,res)=>{
    const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort();});
    try {
      const host=req.headers.host??'';
      if(!/^127\.0\.0\.1(?::\d+)?$/.test(host)){json(res,403,{error:{code:'loopback_only'}});return;}
      const url=new URL(req.url,'http://127.0.0.1');const path=url.pathname;
      if(usagePanel&&await usagePanel(req,res,url,{managementKeyValid:keyEquals(req.headers['x-workbuddy-key'],key)}))return;
      if(req.headers.origin){json(res,403,{error:{code:'browser_origin_rejected'}});return;}
      if(['/accounts','/checkin-status','/checkin','/refresh','/shutdown'].includes(path)||(path==='/models'&&url.searchParams.has('region'))){
        if(!keyEquals(req.headers['x-workbuddy-key'],key)){json(res,401,{error:{code:'local_auth_required'}});return;}
        if(path==='/accounts'&&req.method==='GET')json(res,200,await management.accounts());
        else if(path==='/checkin-status'&&req.method==='GET')json(res,200,await management.checkinStatus());
        else if(path==='/checkin'&&req.method==='POST'){await readJson(req);json(res,200,await management.checkin());}
        else if(path==='/refresh'&&req.method==='POST'){await readJson(req);json(res,200,await management.refresh());}
        else if(path==='/shutdown'&&req.method==='POST'){await readJson(req);json(res,200,{stopping:true});setTimeout(()=>management.shutdown(),100).unref();}
        else if(path==='/models'&&req.method==='GET')json(res,200,await management.models(url.searchParams.get('region')));
        else json(res,405,{error:{code:'method_not_allowed'}});
        return;
      }
      if(path==='/status'){
        if(!keyEquals(req.headers['x-workbuddy-key'],key)){json(res,401,{error:{code:'local_auth_required'}});return;}
        json(res,200,{ok:true,models:catalog.models.length,...await getStatus()});return;
      }
      if(req.method==='GET'&&path.endsWith('/models')){
        if(!await authorize(req.headers.authorization,req.headers)){json(res,401,{error:{code:'authorization_required'}});return;}
        json(res,200,publicCatalog(catalog));return;
      }
      if(req.method!=='POST'||!/^\/(?:v1\/|backend-api\/codex\/)?responses(?:\/(?:compact|lite))?$/.test(path)){json(res,404,{error:{code:'unknown_endpoint'}});return;}
      if(!await authorize(req.headers.authorization,req.headers)){json(res,401,{error:{code:'authorization_required'}});return;}
      if(!(req.headers['content-type']??'').startsWith('application/json')){json(res,415,{error:{code:'json_required'}});return;}
      const body=await readJson(req);const route=modelRoute(catalog,body.model);
      // A WorkBuddy model id arriving through a foreign relay means the client
      // was misrouted: explain the fix instead of a bare 404.
      if(!route){
        const looksWorkBuddy=typeof body.model==='string'&&/^workbuddy-(cn|intl)\//.test(body.model);
        const looksZCode=typeof body.model==='string'&&/^zcode\//.test(body.model);
        const local=looksWorkBuddy||looksZCode;
        const message=looksWorkBuddy?'This WorkBuddy model is served by the local WorkBuddy Suite gateway. Set model_provider to workbuddy_gateway (run the suite launch entry) instead of the third-party relay.'
          :looksZCode?'This ZCode model is served by the local WorkBuddy Suite gateway. Set model_provider to workbuddy_gateway (run the suite launch entry) instead of the third-party relay.':undefined;
        json(res,404,{error:{code:local?'workbuddy_model_on_foreign_provider':'unknown_model',message}});return;
      }
      onRoute({region:route.region,model:route.model,time:new Date().toISOString()});
      if(route.region==='zcode'){
        if(!zcodeClient){json(res,501,{error:{code:'zcode_not_configured',message:'ZCode is not enabled in this installation.'}});return;}
        if(path.endsWith('/compact')||path.endsWith('/lite')){json(res,501,{error:{code:'zcode_operation_not_supported'}});return;}
        let zcodeRouted={...body,model:route.model};
        if(body.tools?.some(tool=>tool.type==='web_search'||tool.type==='web_search_preview')){
          if(body.tool_choice&&typeof body.tool_choice==='object'&&!['function','custom'].includes(body.tool_choice.type))throw Object.assign(new Error('This ZCode model does not support OpenAI-hosted web_search; use a client search tool'),{status:400});
          zcodeRouted.tools=body.tools.filter(tool=>!['web_search','web_search_preview'].includes(tool.type));
          zcodeRouted.instructions=(body.instructions??'')+'\nProvider capabilities: OpenAI-hosted server-side web_search is unavailable on this ZCode route. Use a client/MCP search tool if supplied. Never claim to have performed an unavailable search.';
        }
        const zcodeBody=adapter.toChatRequest(zcodeRouted);
        // Wait for a ZCode slot, then retry throttling with backoff so the
        // client sees a working stream instead of a 429.
        let zcodeUpstream;
        try{
          zcodeUpstream=await providerQueues.zcode.run(()=>withRetry(
            ()=>zcodeClient.streamChat(zcodeBody,{signal:abort.signal,modelMetadata:{id:route.model,metadata:route.metadata}}),
            {signal:abort.signal,...retryOptions}
          ),{signal:abort.signal});
        }catch(error){
          if(error instanceof QueueFullError){json(res,503,{error:{code:'zcode_queue_full',message:'ZCode is at capacity; retry shortly.'}});return;}
          if(error instanceof QueueTimeoutError){json(res,503,{error:{code:'zcode_queue_timeout',message:'ZCode queue wait timed out; retry shortly.'}});return;}
          if(error instanceof QueueAbortedError||abort.signal.aborted)return;
          throw error;
        }
        if(!zcodeUpstream.ok){json(res,zcodeUpstream.status,{error:{code:'zcode_upstream_error',region:'zcode',status:zcodeUpstream.status}});return;}
        const zcodeEvents=adapter.toResponseEvents(zcodeUpstream.body,{model:body.model,responseId:'resp_'+randomUUID().replaceAll('-',''),tools:body.tools??[]});
        if(body.stream===false){let final;for await(const e of zcodeEvents){if(['response.completed','response.incomplete','response.failed'].includes(e.event))final=e.data.response;}if(!final)throw new Error('No completed response');json(res,200,final);return;}
        res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','x-workbuddy-route':'zcode'});
        for await(const item of zcodeEvents)await writeChunk(res,'event: '+item.event+'\ndata: '+JSON.stringify(item.data)+'\n\n');
        res.end();return;
      }
      if(route.region==='official') {
        const headers=officialHeaders(req.headers);
        if(officialAuth){
          let auth;try{auth=await officialAuth();}catch{}
          if(!auth?.accessToken||!auth?.accountId){json(res,401,{error:{code:'official_login_required',message:'Sign in to ChatGPT to use official models'}});return;}
          headers.authorization='Bearer '+auth.accessToken;headers['chatgpt-account-id']=auth.accountId;
        }
        const suffix=path.endsWith('/compact')?'/responses/compact':path.endsWith('/lite')?'/responses/lite':'/responses';
        const upstream=await fetchImpl(officialBaseUrl+suffix,{method:'POST',headers,body:JSON.stringify(normalizeOfficialReplay(body)),signal:abort.signal});
        res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json','cache-control':'no-store','x-workbuddy-route':'official'});
        if(upstream.body)for await(const chunk of upstream.body)await writeChunk(res,chunk);
        res.end();return;
      }
      if(path.endsWith('/compact')||path.endsWith('/lite')){json(res,501,{error:{code:'workbuddy_operation_not_supported'}});return;}
      // Codex advertises its OpenAI-hosted search even for a catalog entry that
      // declares supports_search_tool=false. Negotiate that absent capability
      // explicitly in the instructions; preserve all client/MCP tool schemas.
      let routedBody={...body,model:route.model};
      if(body.tools?.some(tool=>tool.type==='web_search'||tool.type==='web_search_preview')){
        if(body.tool_choice&&typeof body.tool_choice==='object'&&!['function','custom'].includes(body.tool_choice.type))throw Object.assign(new Error('This WorkBuddy model does not support OpenAI-hosted web_search; use a client search tool'),{status:400});
        routedBody.tools=body.tools.filter(tool=>!['web_search','web_search_preview'].includes(tool.type));
        routedBody.instructions=(body.instructions??'')+'\nProvider capabilities: OpenAI-hosted server-side web_search is unavailable on this WorkBuddy route. Use a client/MCP search tool if supplied. Never claim to have performed an unavailable search.';
      }
      const chatBody=adapter.toChatRequest(routedBody);
      let upstream;
      try{
        upstream=await providerQueues.workbuddy.run(()=>withRetry(
          ()=>workbuddyClient.streamChat(route.region,chatBody,{signal:abort.signal,modelMetadata:catalog.models.find(m=>m.slug===body.model)?._workbuddy?.metadata}),
          {signal:abort.signal,...retryOptions}
        ),{signal:abort.signal});
      }catch(error){
        if(error instanceof QueueFullError){json(res,503,{error:{code:'workbuddy_queue_full',message:'WorkBuddy is at capacity; retry shortly.'}});return;}
        if(error instanceof QueueTimeoutError){json(res,503,{error:{code:'workbuddy_queue_timeout',message:'WorkBuddy queue wait timed out; retry shortly.'}});return;}
        if(error instanceof QueueAbortedError||abort.signal.aborted)return;
        throw error;
      }
      if(!upstream.ok){json(res,upstream.status,{error:{code:'workbuddy_upstream_error',region:route.region,status:upstream.status}});return;}
      const events=adapter.toResponseEvents(upstream.body,{model:body.model,responseId:'resp_'+randomUUID().replaceAll('-',''),tools:body.tools??[]});
      if(body.stream===false){let final;for await(const e of events){if(['response.completed','response.incomplete','response.failed'].includes(e.event))final=e.data.response;}if(!final)throw new Error('No completed response');json(res,200,final);return;}
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','x-workbuddy-route':route.region});
      for await(const item of events)await writeChunk(res,'event: '+item.event+'\ndata: '+JSON.stringify(item.data)+'\n\n');
      res.end();
    }catch(err){
      if(abort.signal.aborted)return;
      const isWorkBuddy=err.name==='WorkBuddyError';
      // A throttled upstream that survived every retry is reported as a
      // retryable 503 so clients back off instead of treating it as their own
      // rate limit. Credit exhaustion keeps its own meaning.
      const throttle=err.code==='upstream-rate';
      const status=err.status??(throttle?503:{'upstream-credit':402,'upstream-rate':429,'upstream-auth':401,'not-logged-in':401}[err.code]??502);
      const code=throttle?'upstream_busy':(isWorkBuddy?err.code:status===400?'invalid_request':'bridge_failure');
      const message=status===400?err.message:throttle?'The upstream provider is throttling after retries; retry shortly.':isWorkBuddy?'WorkBuddy request failed: '+err.code:'Request or stream failed';
      if(!res.headersSent)json(res,status,{error:{code,message}});
      else res.end('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"bridge_failure"}}}\n\n');
    }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return{server,url:'http://127.0.0.1:'+server.address().port,queues:providerQueues,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
