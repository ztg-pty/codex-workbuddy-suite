const begin='# BEGIN workbuddy-codex';const end='# END workbuddy-codex';
const quote=value=>JSON.stringify(value);
// A foreign tool (e.g. a "cockpit tools" switcher or another OpenAI-compatible
// relay) may rewrite model_provider/model or the whole provider block. Detect
// that drift so launch/status can tell the user instead of silently sending a
// WorkBuddy model id to the relay's base_url (which surfaces as 404/403).
export function configDrift(current,patch){
  const text=current.replaceAll('\r\n','\n');
  if(!text.includes(patch.block))return {drifted:true,reason:'provider-block-missing'};
  const header=text.search(/^\s*\[/m);const top=header<0?text:text.slice(0,header);
  const expected=new Map(patch.changes.map(change=>[change.key,change.next]));
  for(const key of ['model_provider','model_catalog_json']){
    const want=expected.get(key);if(!want)continue;
    const actual=top.match(new RegExp('^'+key+'\\s*=[^\\n]*$','m'))?.[0];
    if(actual!==want)return {drifted:true,reason:'top-level-'+key,actual,want};
  }
  return {drifted:false};
}
// Re-apply only the provider wiring after a foreign tool changed it, keeping
// the user's other edits (plugins, projects, unrelated providers) intact.
export function reassertConfig(current,patch){
  const text=current.replaceAll('\r\n','\n');
  const kept=text.includes(patch.block)?text.replace(patch.block,'').replace(/\n*$/,'\n'):text;
  const header=kept.search(/^\s*\[/m);let top=header<0?kept:kept.slice(0,header);const tail=header<0?'':kept.slice(header);
  for(const change of patch.changes){
    const pattern=new RegExp('^'+change.key+'\\s*=[^\\n]*$','m');
    top=top.match(pattern)?top.replace(pattern,change.next):change.next+'\n'+top;
  }
  return top+tail.replace(/\n*$/,'\n\n')+patch.block+'\n';
}
export function integrateConfig(original,{baseUrl,catalogPath,envKey,defaultModel,authHeader}){
  let text=original.replaceAll('\r\n','\n');
  if(text.includes(begin)||/^\[model_providers\.workbuddy_gateway\]/m.test(text))throw new Error('WorkBuddy configuration already exists');
  const header=text.search(/^\s*\[/m);let top=header<0?text:text.slice(0,header);const tail=header<0?'':text.slice(header);
  const changes=[];
  for(const[key,value]of Object.entries({model_provider:'workbuddy_gateway',model_catalog_json:catalogPath,...defaultModel?{model:defaultModel}:{}})){
    const pattern=new RegExp('^'+key+'\\s*=[^\\n]*$','m');const old=top.match(pattern)?.[0];const next=key+' = '+quote(value);
    top=old?top.replace(pattern,next):next+'\n'+top;changes.push({key,old,next});
  }
  const block=begin+'\n[model_providers.workbuddy_gateway]\nname = "ChatGPT + WorkBuddy"\nbase_url = '+quote(baseUrl)+'\nwire_api = "responses"\n'+(envKey?'env_key = '+quote(envKey)+'\nrequires_openai_auth = false':'requires_openai_auth = true')+(authHeader?'\nenv_http_headers = { '+quote(authHeader)+' = "WORKBUDDY_GATEWAY_TOKEN" }':'')+'\nsupports_websockets = false\nrequest_max_retries = 1\nstream_max_retries = 0\n'+end;
  text=top+tail; text=text.replace(/\n*$/,'\n\n')+block+'\n';
  return{text,patch:{version:1,changes,block,originalModelLine:original.replaceAll('\r\n','\n').match(/^model\s*=[^\n]*$/m)?.[0]}};
}
export function restoreConfig(current,patch){
  let text=current.replaceAll('\r\n','\n');
  if(!text.includes(patch.block))throw new Error('Managed provider configuration changed; restore requires review');
  text=text.replace(patch.block,'');
  const header=text.search(/^\s*\[/m);let top=header<0?text:text.slice(0,header);const tail=header<0?'':text.slice(header);
  for(const change of patch.changes){
    const pattern=new RegExp('^'+change.key+'\\s*=[^\\n]*$','m');const actual=top.match(pattern)?.[0];
    if(change.key==='model'&&actual!==change.next){if(!/^model\s*=\s*["']workbuddy-/m.test(actual??''))continue;}
    else if(actual!==change.next)throw new Error('Managed top-level configuration changed: '+change.key);
    top=change.old?top.replace(pattern,change.old):top.replace(new RegExp('^'+change.key+'\\s*=[^\\n]*\\n?','m'),'');
  }
  if(patch.originalModelLine&&/^model\s*=\s*["']workbuddy-/m.test(top))top=top.replace(/^model\s*=[^\n]*$/m,patch.originalModelLine);
  return(top+tail).replace(/\n*$/,'\n');
}
