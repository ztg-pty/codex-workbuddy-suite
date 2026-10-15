const prefixes={cn:'workbuddy-cn/',intl:'workbuddy-intl/'};
const labels={cn:'国内版 WorkBuddy',intl:'国际版 WorkBuddy'};
const effortDescriptions={low:'较少推理',medium:'标准推理',high:'深入推理',xhigh:'更深入推理',max:'供应商最高推理档位'};
export function mergeCatalog(official,cn=[],intl=[]) {
  if(!Array.isArray(official?.models)) throw new Error('A model catalog container is required');
  const models=structuredClone(official.models.filter(model=>!model.slug?.startsWith('workbuddy-')));
  for(const [region,entries] of [['cn',cn],['intl',intl]]) {
    const seen=new Set();
    for(const item of entries) {
      const id=String(item.id??item.slug??'');
      if(!id||seen.has(id))continue; seen.add(id);
      // Minimal ModelInfo shape already exercised against the installed kernel.
      // Official private orchestration fields are not WorkBuddy capabilities.
      const model={default_reasoning_level:'low',supported_reasoning_levels:[],shell_type:'unified_exec',visibility:'list',supported_in_api:true,priority:0,availability_nux:null,upgrade:null,base_instructions:'Use supplied tools to complete the user task.',supports_reasoning_summaries:false,support_verbosity:false,default_verbosity:null,apply_patch_tool_type:'freeform',web_search_tool_type:'text',truncation_policy:{mode:'tokens',limit:10000},supports_parallel_tool_calls:true,context_window:32768,auto_compact_token_limit:null,effective_context_window_percent:90,experimental_supported_tools:[],input_modalities:['text'],supports_search_tool:false,supports_image_detail_original:false,model_messages:null};
      model.slug=prefixes[region]+id;
      model.display_name=labels[region]+' · '+String(item.name??item.display_name??id);
      model.description='WorkBuddy '+region+' — '+String(item.name??id);
      model.upgrade=null; model.visibility='list'; model.priority=models.length;
      model.context_window=item.contextWindow??item.context_window??32768;
      const declaredWindows=Array.isArray(item.supportedContextWindows)?item.supportedContextWindows.filter(value=>Number.isSafeInteger(value)&&value>0):[];
      model.context_window=Math.max(model.context_window,...declaredWindows);
      model.effective_context_window_percent=90;
      model.supports_reasoning_summaries=false;
      model.supports_parallel_tool_calls=true;
      model.supported_in_api=true;
      model.input_modalities=item.supportsImages?['text','image']:['text'];
      const reasoning=item.reasoning??{};
      const supportsReasoning=item.supportsReasoning===true||reasoning.supported===true;
      const efforts=supportsReasoning?[...new Set((reasoning.supportedEfforts??[]).filter(value=>Object.hasOwn(effortDescriptions,value)))]:[];
      const declaredDefault=Object.hasOwn(effortDescriptions,reasoning.defaultEffort)?reasoning.defaultEffort:undefined;
      // The kernel requires a default string even when no effort choices exist.
      // That internal fallback is never forwarded for undeclared capability sets.
      model.default_reasoning_level=efforts.length?(efforts.includes(declaredDefault)?declaredDefault:efforts[0]):supportsReasoning?(declaredDefault??'low'):'low';
      model.supported_reasoning_levels=efforts.map(effort=>({effort,description:effortDescriptions[effort]}));
      model.use_responses_lite=false;
      model.supports_search_tool=false;
      model.experimental_supported_tools=[];
      model.service_tiers=[]; model.additional_speed_tiers=[];
      model.availability_nux=null;
      model.model_messages=null;
      model.base_instructions='You are a coding assistant running in Codex. Follow the user and project instructions and use the tools supplied by the client.';
      model.support_verbosity=false;
      model.default_verbosity=null;
      model.supports_reasoning_effort_updates=efforts.length>1;
      model.max_context_window=model.context_window;
      delete model.tool_mode;
      model._workbuddy={region,model:id,metadata:item};
      models.push(model);
    }
  }
  if(!models.length)throw new Error('No available models; sign in to a WorkBuddy client first');
  return {...structuredClone(official),models};
}
export function modelRoute(catalog,id) {
  const model=catalog.models.find(x=>(x.slug??x.id)===id);
  if(!model)return null;
  return model._workbuddy?{region:model._workbuddy.region,model:model._workbuddy.model}:{region:'official',model:id};
}
export function publicCatalog(catalog) {
  return {...catalog,models:catalog.models.map(({_workbuddy,...model})=>model)};
}
