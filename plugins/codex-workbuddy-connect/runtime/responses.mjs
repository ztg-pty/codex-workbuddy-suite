import { createHash, randomUUID } from 'node:crypto';

function invalid(message) {
  const error = new Error(message);
  error.code = 'unsupported_request';
  error.status = 400;
  return error;
}
function requiredString(value, label) {
  if (typeof value !== 'string' || !value) throw invalid(`${label} must be a non-empty string`);
  return value;
}
function contentParts(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw invalid('Message content must be a string or array');
  const parts = content.map(part => {
    if (['input_text', 'output_text', 'text'].includes(part.type)) {
      if (typeof part.text !== 'string') throw invalid('Text content must be a string');
      return { type: 'text', text: part.text };
    }
    if (part.type === 'input_image' && typeof part.image_url === 'string') {
      return { type: 'image_url', image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) } };
    }
    throw invalid(`Unsupported input content: ${part.type}`);
  });
  return parts.every(part => part.type === 'text') ? parts.map(part => part.text).join('') : parts;
}
function upstreamToolName(name, namespace) {
  const candidate = namespace ? `${namespace}__${name}` : name;
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(candidate)) return candidate;
  return `${candidate.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}_${createHash('sha256').update(candidate).digest('hex').slice(0, 20)}`;
}
function flattenTools(tools) {
  if (!Array.isArray(tools)) throw invalid('tools must be an array');
  const flat = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') throw invalid('tools items must be objects');
    if (tool.type === 'namespace') {
      requiredString(tool.name, 'Namespace name');
      if (!Array.isArray(tool.tools)) throw invalid('Namespace tools must be an array');
      for (const member of tool.tools) {
        if (!['function', 'custom'].includes(member?.type)) throw invalid(`Unsupported namespace tool type: ${member?.type}`);
        requiredString(member.name, 'Tool name');
        flat.push({ ...member, namespace: tool.name, upstreamName: upstreamToolName(member.name, tool.name) });
      }
    } else {
      requiredString(tool.name ?? (tool.type === 'function' || tool.type === 'custom' ? undefined : tool.type), 'Tool name');
      flat.push({ ...tool, upstreamName: upstreamToolName(tool.name ?? tool.type, tool.namespace) });
    }
  }
  const names = new Set();
  for (const tool of flat) {
    if (names.has(tool.upstreamName)) throw invalid(`Duplicate tool name: ${tool.upstreamName}`);
    names.add(tool.upstreamName);
  }
  return flat;
}
function resolveToolName(name, namespace, tools) {
  const matching = tools.filter(tool => namespace ? tool.namespace === namespace && tool.name === name
    : tool.upstreamName === name || (tool.namespace ? `${tool.namespace}.${tool.name}` : tool.name) === name);
  if (matching.length === 1) return matching[0].upstreamName;
  if (matching.length > 1) throw invalid(`Ambiguous tool name: ${name}`);
  const byBareName = !namespace && tools.filter(tool => tool.name === name);
  if (byBareName?.length === 1) return byBareName[0].upstreamName;
  if (byBareName?.length > 1) throw invalid(`Tool namespace is required for ambiguous name: ${name}`);
  return upstreamToolName(name, namespace);
}
function mapTool(tool) {
  if (!['function', 'custom'].includes(tool.type)) throw invalid(`Unsupported tool type: ${tool.type}; only client-executed function and custom tools are supported`);
  const name = requiredString(tool.upstreamName ?? tool.name, 'Tool name');
  if (tool.type === 'custom' && tool.format && !['text', 'grammar'].includes(tool.format.type)) throw invalid(`Unsupported custom tool format: ${tool.format.type}`);
  const definition = { name, ...(tool.description ? { description: tool.description } : {}) };
  if (tool.type === 'function') {
    definition.parameters = tool.parameters ?? { type: 'object', properties: {} };
    if (tool.strict !== undefined) definition.strict = tool.strict;
  } else {
    definition.description = `${tool.description ?? ''}\nReturn the complete tool input as the input string. Do not omit, summarize, or alter its contents.${tool.format?.type === 'grammar' ? `\nRequired ${tool.format.syntax} grammar:\n${tool.format.definition}` : ''}`.trim();
    definition.parameters = { type: 'object', properties: { input: { type: 'string', description: 'The exact freeform tool input, including all newlines and punctuation.' } }, required: ['input'], additionalProperties: false };
  }
  return { type: 'function', function: definition };
}

/** Stateless Responses -> Chat Completions. Tools execute in the calling client. */
export function toChatRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Responses body must be an object');
  requiredString(body.model, 'model');
  for (const field of ['previous_response_id', 'conversation', 'prompt', 'context_management']) {
    if (body[field] != null) throw invalid(`${field} is unsupported by the stateless gateway; send full input history`);
  }
  if (body.background === true) throw invalid('background responses are unsupported');
  if (body.store === true) throw invalid('store:true is unsupported; the stateless gateway does not retain responses');
  const toolDefinitions = flattenTools(body.tools ?? []);
  const tools = toolDefinitions.map(mapTool);
  const messages = [];
  if (body.instructions != null) messages.push({ role: 'system', content: contentParts(body.instructions) });
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : (body.input ?? []);
  if (!Array.isArray(input)) throw invalid('input must be a string or array');
  const calls = new Map();
  const outputs = new Set();
  function assistant() {
    if (messages.at(-1)?.role === 'assistant') return messages.at(-1);
    const message = { role: 'assistant', content: null };
    messages.push(message);
    return message;
  }
  for (const item of input) {
    if (!item || typeof item !== 'object') throw invalid('input items must be objects');
    // Compaction markers are a client-side session artifact with no upstream
    // payload; skipping them keeps long sessions from failing conversion.
    if (item.type === 'compaction') continue;
    if (item.type === 'reasoning') {
      // Opaque model-specific ciphertext cannot cross providers. Keep every
      // readable summary and every visible message/tool item in the same chat.
      const text = (item.summary ?? []).map(part => part.text ?? '').join('');
      if (text) assistant().reasoning_content = text;
      continue;
    }
    // Multi-agent collaboration messages carry readable text only; forward
    // that text as assistant context instead of rejecting the item.
    if (item.type === 'agent_message') {
      const text = (item.content ?? []).map(part => part?.type === 'input_text' ? (part.text ?? '') : '').join('');
      if (text) messages.push({ role: 'assistant', content: text });
      continue;
    }
    if (['function_call', 'custom_tool_call'].includes(item.type)) {
      const id = requiredString(item.call_id, 'Tool call_id');
      if (calls.has(id)) throw invalid(`Duplicate tool call_id: ${id}`);
      const name = resolveToolName(requiredString(item.name, 'Tool call name'), item.namespace, toolDefinitions);
      let args = item.arguments;
      if (item.type === 'custom_tool_call') {
        if (typeof item.input !== 'string') throw invalid('custom_tool_call input must be a string');
        args = JSON.stringify({ input: item.input });
      }
      if (typeof args !== 'string') throw invalid('function_call arguments must be a JSON string');
      calls.set(id, item.type);
      (assistant().tool_calls ??= []).push({ id, type: 'function', function: { name, arguments: args } });
      continue;
    }
    if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) {
      const id = requiredString(item.call_id, 'Tool output call_id');
      if (!calls.has(id) || outputs.has(id)) throw invalid(`Unmatched or duplicate tool output call_id: ${id}`);
      if (item.type !== `${calls.get(id)}_output`) throw invalid(`Mismatched tool output type for call_id: ${id}`);
      outputs.add(id);
      messages.push({ role: 'tool', tool_call_id: id, content: contentParts(item.output) });
      continue;
    }
    if (item.type == null || item.type === 'message') {
      const role = item.role === 'developer' ? 'system' : item.role;
      if (!['user', 'assistant', 'system'].includes(role)) throw invalid(`Unsupported message role: ${item.role}`);
      const content = contentParts(item.content);
      if (role === 'assistant' && messages.at(-1)?.role === 'assistant' && messages.at(-1).content === null) assistant().content = content;
      else messages.push({ role, content });
      continue;
    }
    throw invalid(`Unsupported input item: ${item.type}`);
  }
  const request = { model: body.model, messages, stream: true, stream_options: { include_usage: true } };
  if (tools.length) request.tools = tools;
  for (const field of ['temperature', 'top_p', 'parallel_tool_calls', 'seed', 'user']) if (body[field] !== undefined) request[field] = body[field];
  if (body.max_output_tokens !== undefined) request.max_tokens = body.max_output_tokens;
  if (body.reasoning?.effort != null) request.reasoning_effort = body.reasoning.effort;
  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice;
    if (typeof choice === 'string') request.tool_choice = choice;
    else if (['function', 'custom'].includes(choice?.type)) request.tool_choice = { type: 'function', function: { name: resolveToolName(requiredString(choice.name, 'tool_choice name'), choice.namespace, toolDefinitions) } };
    else throw invalid(`Unsupported tool_choice: ${choice?.type}`);
  }
  if (body.text?.format && body.text.format.type !== 'text') {
    const format = body.text.format;
    if (format.type === 'json_object') request.response_format = { type: 'json_object' };
    else if (format.type === 'json_schema') request.response_format = { type: 'json_schema', json_schema: { name: format.name, schema: format.schema, ...(format.strict !== undefined ? { strict: format.strict } : {}) } };
    else throw invalid(`Unsupported text format: ${format.type}`);
  }
  return request;
}

// Decode SSE incrementally; TextDecoder preserves UTF-8 sequences split across bytes.
async function* upstreamFrames(body) {
  if (!body?.[Symbol.asyncIterator]) throw new Error('Upstream body is not readable');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', event = '', data = [];
  function line(value) {
    if (value === '') {
      const frame = data.length ? { event, data: data.join('\n') } : null;
      event = ''; data = [];
      return frame;
    }
    if (value.startsWith(':')) return null;
    const colon = value.indexOf(':');
    const key = colon < 0 ? value : value.slice(0, colon);
    let payload = colon < 0 ? '' : value.slice(colon + 1);
    if (payload.startsWith(' ')) payload = payload.slice(1);
    if (key === 'event') event = payload;
    if (key === 'data') data.push(payload);
    return null;
  }
  for await (const bytes of body) {
    buffer += typeof bytes === 'string' ? bytes : decoder.decode(bytes, { stream: true });
    for (;;) {
      const match = /\r\n|\r|\n/.exec(buffer);
      if (!match || (match[0] === '\r' && match.index === buffer.length - 1)) break;
      const frame = line(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
      if (frame) yield frame;
    }
  }
  buffer += decoder.decode();
  if (buffer) line(buffer);
  if (data.length) yield { event, data: data.join('\n') };
}

// Decode a wrapper's input string as it arrives, retaining incomplete escapes.
function customInputDelta(state) {
  if (state.cursor == null) {
    const prefix = /^\s*\{\s*"input"\s*:\s*"/.exec(state.arguments);
    if (!prefix) return '';
    state.cursor = prefix[0].length;
    state.decoded = '';
  }
  while (state.cursor < state.arguments.length && !state.stringEnded) {
    const char = state.arguments[state.cursor];
    if (char === '"') { state.stringEnded = true; break; }
    if (char !== '\\') { state.decoded += char; state.cursor++; continue; }
    const escape = state.arguments[state.cursor + 1];
    if (escape === undefined) break;
    if (escape === 'u') {
      if (state.cursor + 6 > state.arguments.length) break;
      const hex = state.arguments.slice(state.cursor + 2, state.cursor + 6);
      if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error('Invalid custom tool Unicode escape');
      state.decoded += String.fromCharCode(parseInt(hex, 16)); state.cursor += 6;
    } else {
      const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (!(escape in escapes)) throw new Error('Invalid custom tool string escape');
      state.decoded += escapes[escape]; state.cursor += 2;
    }
  }
  let available = state.decoded;
  if (!state.stringEnded && /[\uD800-\uDBFF]$/.test(available)) available = available.slice(0, -1);
  const delta = available.slice(state.emittedInput.length);
  state.emittedInput += delta;
  return delta;
}

/** Convert one Chat Completions SSE model turn into Responses SSE events. */
export async function* toResponseEvents(body, { model, responseId = `resp_${randomUUID().replaceAll('-', '')}`, tools = [] } = {}) {
  let sequence = 0;
  const output = [];
  const toolStates = new Map();
  const knownTools = new Map(flattenTools(tools).map(tool => [tool.upstreamName, tool]));
  let textItem, refusalItem, reasoningItem, finish, sawDone = false, usage = null;
  const response = { id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model, output, error: null, incomplete_details: null, usage: null, parallel_tool_calls: true };
  const emit = (event, fields = {}) => ({ event, data: { type: event, sequence_number: sequence++, ...structuredClone(fields) } });
  const newId = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
  function* startTool(state, force = false) {
    if (state.started) return;
    // Tool names can arrive in fragments. A declared full name and the first
    // arguments identify it; otherwise wait for finish rather than invent a name.
    if (!force && !(state.arguments && state.callId && knownTools.has(state.name))) return;
    if (!state.name || !state.callId) throw new Error('Upstream tool call is missing its name or id');
    if (knownTools.size && !knownTools.has(state.name)) {
      // WorkBuddy's upstream exposes the command tool as `exec` while Codex
      // declares `shell`; map it rather than breaking the stream.
      if (state.name === 'exec') state.name = 'shell';
      else throw new Error(`Upstream requested an unregistered tool: ${state.name}`);
    }
    if ([...toolStates.values()].some(other => other !== state && other.callId === state.callId)) throw new Error(`Duplicate upstream tool call id: ${state.callId}`);
    const custom = knownTools.get(state.name)?.type === 'custom';
    const definition = knownTools.get(state.name);
    const name = definition?.name ?? state.name;
    const namespace = definition?.namespace ? { namespace: definition.namespace } : {};
    state.item = custom
      ? { id: newId('ctc'), type: 'custom_tool_call', status: 'in_progress', call_id: state.callId, name, ...namespace, input: '' }
      : { id: newId('fc'), type: 'function_call', status: 'in_progress', call_id: state.callId, name, ...namespace, arguments: '' };
    output[state.outputIndex] = state.item;
    state.started = true;
    yield emit('response.output_item.added', { output_index: state.outputIndex, item: state.item });
  }
  function* argumentEvents(state) {
    if (!state.started) return;
    const custom = state.item.type === 'custom_tool_call';
    const delta = custom ? customInputDelta(state) : state.arguments.slice(state.emittedArguments.length);
    if (!delta) return;
    if (custom) state.item.input = state.emittedInput;
    else { state.emittedArguments += delta; state.item.arguments = state.emittedArguments; }
    yield emit(custom ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta', { item_id: state.item.id, output_index: state.outputIndex, delta });
  }
  yield emit('response.created', { response });
  yield emit('response.in_progress', { response });
  try {
    for await (const frame of upstreamFrames(body)) {
      if (frame.data === '[DONE]') { sawDone = true; break; }
      const payload = JSON.parse(frame.data);
      if (payload.error || frame.event === 'error') {
        const error = payload.error ?? payload;
        const failure = new Error(error.message ?? 'Upstream model error');
        failure.code = error.code;
        throw failure;
      }
      if (payload.usage) usage = {
        input_tokens: payload.usage.prompt_tokens ?? 0,
        input_tokens_details: { cached_tokens: payload.usage.prompt_tokens_details?.cached_tokens ?? 0 },
        output_tokens: payload.usage.completion_tokens ?? 0,
        output_tokens_details: { reasoning_tokens: payload.usage.completion_tokens_details?.reasoning_tokens ?? 0 },
        total_tokens: payload.usage.total_tokens ?? ((payload.usage.prompt_tokens ?? 0) + (payload.usage.completion_tokens ?? 0))
      };
      for (const choice of payload.choices ?? []) {
        if (choice.index !== undefined && choice.index !== 0) throw new Error('Multiple upstream completion choices are unsupported');
        const delta = choice.delta ?? {};
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (reasoning) {
          if (typeof reasoning !== 'string') throw new Error('Unsupported upstream reasoning payload');
          if (!reasoningItem) {
            reasoningItem = { id: newId('rs'), type: 'reasoning', status: 'in_progress', summary: [] };
            const outputIndex = output.push(reasoningItem) - 1;
            yield emit('response.output_item.added', { output_index: outputIndex, item: reasoningItem });
            reasoningItem.summary.push({ type: 'summary_text', text: '' });
            yield emit('response.reasoning_summary_part.added', { item_id: reasoningItem.id, output_index: outputIndex, summary_index: 0, part: reasoningItem.summary[0] });
          }
          reasoningItem.summary[0].text += reasoning;
          yield emit('response.reasoning_summary_text.delta', { item_id: reasoningItem.id, output_index: output.indexOf(reasoningItem), summary_index: 0, delta: reasoning });
        }
        if (delta.content) {
          if (typeof delta.content !== 'string') throw new Error('Unsupported upstream content payload');
          if (!textItem) {
            textItem = { id: newId('msg'), type: 'message', status: 'in_progress', role: 'assistant', content: [] };
            const outputIndex = output.push(textItem) - 1;
            yield emit('response.output_item.added', { output_index: outputIndex, item: textItem });
            textItem.content.push({ type: 'output_text', text: '', annotations: [] });
            yield emit('response.content_part.added', { item_id: textItem.id, output_index: outputIndex, content_index: 0, part: textItem.content[0] });
          }
          textItem.content[0].text += delta.content;
          yield emit('response.output_text.delta', { item_id: textItem.id, output_index: output.indexOf(textItem), content_index: 0, delta: delta.content, logprobs: [] });
        }
        if (delta.refusal) {
          if (typeof delta.refusal !== 'string') throw new Error('Unsupported upstream refusal payload');
          if (!refusalItem) {
            refusalItem = { id: newId('msg'), type: 'message', status: 'in_progress', role: 'assistant', content: [] };
            const outputIndex = output.push(refusalItem) - 1;
            yield emit('response.output_item.added', { output_index: outputIndex, item: refusalItem });
            refusalItem.content.push({ type: 'refusal', refusal: '' });
            yield emit('response.content_part.added', { item_id: refusalItem.id, output_index: outputIndex, content_index: 0, part: refusalItem.content[0] });
          }
          refusalItem.content[0].refusal += delta.refusal;
          yield emit('response.refusal.delta', { item_id: refusalItem.id, output_index: output.indexOf(refusalItem), content_index: 0, delta: delta.refusal });
        }
        if (delta.function_call && (delta.function_call.name || delta.function_call.arguments)) throw new Error('Legacy upstream function_call format is unsupported; use tool_calls');
        for (const call of delta.tool_calls ?? []) {
          if (!Number.isInteger(call.index) || call.index < 0) throw new Error('Upstream tool call is missing a valid index');
          let state = toolStates.get(call.index);
          if (!state) {
            state = { outputIndex: output.length, name: '', callId: '', arguments: '', emittedArguments: '', emittedInput: '', started: false };
            toolStates.set(call.index, state);
            output.push(null);
          }
          if (call.type && call.type !== 'function') throw new Error(`Unsupported upstream tool call type: ${call.type}`);
          if (call.id) {
            if (state.callId && state.callId !== call.id) throw new Error('Upstream changed a tool call id');
            state.callId = call.id;
          }
          if (call.function?.name) {
            if (state.started && call.function.name !== state.name) throw new Error('Upstream changed a tool name after arguments started');
            if (!state.started) state.name += call.function.name;
          }
          if (call.function?.arguments !== undefined) {
            if (typeof call.function.arguments !== 'string') throw new Error('Upstream tool arguments must be string deltas');
            state.arguments += call.function.arguments;
          }
          yield* startTool(state);
          yield* argumentEvents(state);
        }
        if (choice.finish_reason != null && choice.finish_reason !== '') {
          if (!['stop', 'tool_calls', 'length', 'content_filter', 'error'].includes(choice.finish_reason)) throw new Error(`Unsupported upstream finish_reason: ${choice.finish_reason}`);
          // Upstream reports a mid-generation failure (rate limit, model error)
          // as finish_reason "error". Mapping it to stop keeps the text already
          // produced and completes the stream instead of disconnecting.
          finish = choice.finish_reason === 'error' ? 'stop' : choice.finish_reason;
        }
      }
    }
    if (!finish || !sawDone) throw new Error('Upstream stream ended before a finish_reason and [DONE] marker');
    for (const state of toolStates.values()) {
      yield* startTool(state, true);
      yield* argumentEvents(state);
      if (state.item.type === 'custom_tool_call') {
        const parsed = JSON.parse(state.arguments);
        if (!parsed || typeof parsed.input !== 'string' || Object.keys(parsed).some(key => key !== 'input')) throw new Error('Custom tool arguments must contain exactly an input string');
        if (!parsed.input.startsWith(state.emittedInput)) throw new Error('Custom tool input delta does not match its completed input');
        const delta = parsed.input.slice(state.emittedInput.length);
        if (delta) yield emit('response.custom_tool_call_input.delta', { item_id: state.item.id, output_index: state.outputIndex, delta });
        state.item.input = parsed.input;
      } else JSON.parse(state.arguments);
    }
    const incomplete = ['length', 'content_filter'].includes(finish);
    for (let index = 0; index < output.length; index++) {
      const item = output[index];
      item.status = incomplete ? 'incomplete' : 'completed';
      if (item.type === 'message') {
        if (item.content[0].type === 'refusal') yield emit('response.refusal.done', { item_id: item.id, output_index: index, content_index: 0, refusal: item.content[0].refusal });
        else yield emit('response.output_text.done', { item_id: item.id, output_index: index, content_index: 0, text: item.content[0].text, logprobs: [] });
        yield emit('response.content_part.done', { item_id: item.id, output_index: index, content_index: 0, part: item.content[0] });
      } else if (item.type === 'reasoning') {
        yield emit('response.reasoning_summary_text.done', { item_id: item.id, output_index: index, summary_index: 0, text: item.summary[0].text });
        yield emit('response.reasoning_summary_part.done', { item_id: item.id, output_index: index, summary_index: 0, part: item.summary[0] });
      } else if (item.type === 'custom_tool_call') yield emit('response.custom_tool_call_input.done', { item_id: item.id, output_index: index, input: item.input });
      else yield emit('response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: item.arguments });
      yield emit('response.output_item.done', { output_index: index, item });
    }
    response.status = incomplete ? 'incomplete' : 'completed';
    response.usage = usage;
    if (incomplete) response.incomplete_details = { reason: finish === 'length' ? 'max_output_tokens' : 'content_filter' };
    yield emit(incomplete ? 'response.incomplete' : 'response.completed', { response });
  } catch (error) {
    response.status = 'failed';
    response.output = output.filter(Boolean);
    response.usage = usage;
    response.error = { code: error.code ?? 'upstream_stream_error', message: error.message ?? 'Upstream stream failed' };
    yield emit('response.failed', { response });
  }
}
