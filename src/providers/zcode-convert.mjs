// OpenAI-shaped chat request -> Anthropic Messages request, and Anthropic
// stream/single responses -> OpenAI chat-completions chunks.
//
// Rules verified against jjjane233/workbuddy-3in1 internal/server/convert_zcode.go:
//   - system/developer text is lifted to the top-level `system` field;
//   - role "tool" becomes a user message carrying a tool_result block, keeping
//     tool_use_id so multi-round tool chains stay linked;
//   - assistant tool_calls become tool_use content blocks;
//   - tools/tool_choice must be converted: OpenAI's {type:function,function:{...}}
//     is rejected upstream with 400;
//   - max_tokens defaults to 8192 because Anthropic requires it;
//   - messages must be non-empty, so a placeholder user turn is added;
//   - the reasoning level goes in output_config.effort. Putting it in
//     thinking.type yields 400 code 1210, and thinking.type only accepts
//     enabled/disabled.

const EFFORT_MAP={
  off:'none',disabled:'none',none:'none',
  minimal:'low',light:'low',low:'low',
  medium:'medium',mid:'medium',
  high:'high',
  xhigh:'xhigh',extra_high:'xhigh',max:'xhigh',ultra:'xhigh',
};
export function mapEffort(level){
  if(typeof level!=='string')return undefined;
  return EFFORT_MAP[level.trim().toLowerCase()];
}

function textOf(content){
  if(typeof content==='string')return content;
  if(!Array.isArray(content))return '';
  return content.map(part=>{
    if(typeof part==='string')return part;
    if(part?.type==='text'||part?.type==='input_text'||part?.type==='output_text')return part.text??'';
    return '';
  }).join('');
}
function blocksOf(content){
  if(typeof content==='string')return content?[{type:'text',text:content}]:[];
  if(!Array.isArray(content))return [];
  return content.flatMap(part=>{
    if(typeof part==='string')return part?[{type:'text',text:part}]:[];
    if(part?.type==='text'||part?.type==='input_text'||part?.type==='output_text')return part.text?[{type:'text',text:part.text}]:[];
    if(part?.type==='image_url'||part?.type==='input_image'){
      const url=part.image_url?.url??part.image_url??part.image_url;
      const match=typeof url==='string'?/^data:([^;]+);base64,(.*)$/u.exec(url):null;
      if(match)return [{type:'image',source:{type:'base64',media_type:match[1],data:match[2]}}];
      if(typeof url==='string')return [{type:'image',source:{type:'url',url}}];
      return [];
    }
    return [];
  });
}

export function toAnthropicRequest(body,{model,defaultMaxTokens=8192}={}){
  const messages=[];const systemParts=[];
  for(const message of body.messages??[]){
    if(!message||typeof message!=='object')continue;
    if(message.role==='system'||message.role==='developer'){
      const text=textOf(message.content);if(text)systemParts.push(text);continue;
    }
    if(message.role==='tool'){
      const id=message.tool_call_id||`toolu_${messages.length}`;
      messages.push({role:'user',content:[{type:'tool_result',tool_use_id:id,content:textOf(message.content)}]});
      continue;
    }
    if(message.role==='assistant'){
      const blocks=[];
      const text=textOf(message.content);
      if(text)blocks.push({type:'text',text});
      for(const call of message.tool_calls??[]){
        const name=call?.function?.name;if(!name)continue;
        let input={};
        const raw=typeof call.function.arguments==='string'?call.function.arguments.trim():'';
        if(raw){try{input=JSON.parse(raw);}catch{input={};}}
        blocks.push({type:'tool_use',id:call.id||`toolu_${messages.length}_${blocks.length}`,name,input});
      }
      if(blocks.length)messages.push({role:'assistant',content:blocks});
      continue;
    }
    const blocks=blocksOf(message.content);
    messages.push({role:'user',content:blocks.length?blocks:[{type:'text',text:''}]});
  }
  if(!messages.length)messages.push({role:'user',content:[{type:'text',text:''}]});

  const request={model,messages,max_tokens:Number.isFinite(body.max_tokens)&&body.max_tokens>0?body.max_tokens:defaultMaxTokens,stream:body.stream!==false};
  if(systemParts.length)request.system=systemParts.join('\n');
  for(const field of ['temperature','top_p'])if(body[field]!==undefined)request[field]=body[field];
  if(body.stop!==undefined)request.stop_sequences=Array.isArray(body.stop)?body.stop:[body.stop];

  const choice=body.tool_choice;
  const choiceNone=choice==='none'||(choice&&typeof choice==='object'&&choice.type==='none');
  const tools=(body.tools??[]).filter(tool=>tool?.type==='function'&&tool.function?.name);
  if(tools.length&&!choiceNone){
    request.tools=tools.map(tool=>({
      name:tool.function.name,
      description:tool.function.description??'',
      input_schema:tool.function.parameters??{type:'object',properties:{}},
    }));
    const converted=toolChoiceToAnthropic(choice);
    if(converted)request.tool_choice=converted;
  }

  const effort=mapEffort(body.reasoning_effort??body.reasoning?.effort);
  if(effort)request.output_config={effort};
  return request;
}

export function toolChoiceToAnthropic(choice){
  if(choice===undefined||choice===null)return undefined;
  if(typeof choice==='string'){
    if(choice==='auto')return {type:'auto'};
    if(choice==='required'||choice==='any')return {type:'any'};
    if(choice==='none')return undefined;
    return undefined;
  }
  if(typeof choice!=='object')return undefined;
  if(choice.type==='function'){const name=choice.function?.name??choice.name;return name?{type:'tool',name}:undefined;}
  if(choice.type==='auto')return {type:'auto'};
  if(choice.type==='required'||choice.type==='any')return {type:'any'};
  return undefined;
}

// ---- Anthropic response -> OpenAI chat-completions -------------------------

function usageOf(usage){
  if(!usage||typeof usage!=='object')return undefined;
  const prompt=Number(usage.input_tokens??0)+Number(usage.cache_read_input_tokens??0)+Number(usage.cache_creation_input_tokens??0);
  const completion=Number(usage.output_tokens??0);
  return {prompt_tokens:prompt,completion_tokens:completion,total_tokens:prompt+completion};
}

// Translate one Anthropic SSE event into zero or more OpenAI chunks.
// Tools, text and thinking are emitted as distinct deltas so the Codex adapter
// can rebuild tool calls across frames.
export function anthropicEventToOpenAI(event,state){
  const type=event?.type;
  if(type==='message_start'){
    state.usage=usageOf(event.message?.usage)??state.usage;
    return [];
  }
  if(type==='content_block_start'){
    const block=event.content_block??{};
    state.blocks[event.index]=block;
    if(block.type==='tool_use'){
      const slot=state.tools.get(event.index)??{id:block.id,name:block.name,args:''};
      slot.id=block.id??slot.id;slot.name=block.name??slot.name;state.tools.set(event.index,slot);
      if(!state.toolOrder.includes(event.index))state.toolOrder.push(event.index);
      return [{choice:{delta:{tool_calls:[{index:state.toolOrder.indexOf(event.index),id:slot.id,type:'function',function:{name:slot.name,arguments:''}}]}}}];
    }
    return [];
  }
  if(type==='content_block_delta'){
    const delta=event.delta??{};
    if(delta.type==='text_delta'&&delta.text)return [{choice:{delta:{content:delta.text}}}];
    if(delta.type==='thinking_delta'&&delta.thinking)return [{choice:{delta:{reasoning_content:delta.thinking}}}];
    if(delta.type==='input_json_delta'){
      const slot=state.tools.get(event.index);if(!slot)return [];
      slot.args+=delta.partial_json??'';
      return [{choice:{delta:{tool_calls:[{index:state.toolOrder.indexOf(event.index),function:{arguments:delta.partial_json??''}}]}}}];
    }
    return [];
  }
  if(type==='content_block_stop'){
    const block=state.blocks[event.index];
    if(block?.type==='tool_use'){
      const slot=state.tools.get(event.index);
      if(slot&&!slot.args&&block.input&&Object.keys(block.input).length)slot.args=JSON.stringify(block.input);
    }
    return [];
  }
  if(type==='message_delta'){
    if(event.usage)state.usage={...state.usage,...usageOf(event.usage)};
    if(event.delta?.stop_reason)state.stopReason=event.delta.stop_reason;
    return [];
  }
  if(type==='error'){
    return [{error:{message:event.error?.message??'zcode upstream error',type:event.error?.type??'upstream_error'}}];
  }
  return [];
}

export function anthropicStopReasonToOpenAI(reason){
  if(reason==='max_tokens')return 'length';
  if(reason==='tool_use')return 'tool_calls';
  if(reason==='end_turn'||reason==='stop_sequence')return 'stop';
  return 'stop';
}

export function newAnthropicState(){return {blocks:[],tools:new Map(),toolOrder:[],usage:undefined,stopReason:undefined};}
