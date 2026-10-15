import test from 'node:test';
import assert from 'node:assert/strict';
import { toChatRequest, toResponseEvents } from '../src/responses.mjs';

const tool = { type: 'function', name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } };
const custom = { type: 'custom', name: 'apply_patch', description: 'Apply a patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: /[\\s\\S]+/' } };
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
function bytesSse(parts, byteLength = 1) {
  const bytes = new TextEncoder().encode(parts.map(p => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\r\n\r\n`).join(''));
  return new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += byteLength) controller.enqueue(bytes.slice(i, i + byteLength)); controller.close(); } });
}
async function collect(parts, options = {}) {
  return Array.fromAsync(toResponseEvents(bytesSse(parts), { model: 'test-model', responseId: 'resp_test', ...options }));
}

test('WorkBuddy empty finish reasons and empty legacy placeholders are nonterminal fields', async()=>{
  const events=await collect([
    chunk({role:'assistant',content:'',function_call:null,tool_calls:[]},''),
    chunk({content:'WB_OK',function_call:null,tool_calls:[]},''),
    chunk({content:'',function_call:{name:'',arguments:''},tool_calls:[]},'stop'),
    '[DONE]'
  ]);
  assert.equal(events.at(-1).event,'response.completed');
  assert.equal(events.at(-1).data.response.output.find(x=>x.type==='message').content[0].text,'WB_OK');
});

test('maps instructions, images, function and custom tools without losing multi-round history', () => {
  const patch = '*** Begin Patch\n+中文 😀\n*** End Patch';
  const request = toChatRequest({ model: 'm', stream: true, instructions: 'Be precise', tools: [tool, custom], input: [
    { role: 'developer', content: 'Rules' },
    { role: 'user', content: [{ type: 'input_text', text: 'Look' }, { type: 'input_image', image_url: 'data:image/png;base64,AA==', detail: 'high' }] },
    { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a"}' },
    { type: 'function_call', call_id: 'c2', name: 'read_file', arguments: '{"path":"b"}' },
    { type: 'function_call_output', call_id: 'c2', output: 'B' },
    { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'A' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixing' }] },
    { type: 'custom_tool_call', call_id: 'p1', name: 'apply_patch', input: patch },
    { type: 'custom_tool_call_output', call_id: 'p1', output: 'OK' },
    { role: 'user', content: 'Continue' }
  ], reasoning: { effort: 'high' }, max_output_tokens: 200 });
  assert.equal(request.model, 'm');
  assert.equal(request.stream, true);
  assert.deepEqual(request.stream_options, { include_usage: true });
  assert.deepEqual(request.messages.slice(0, 2), [{ role: 'system', content: 'Be precise' }, { role: 'system', content: 'Rules' }]);
  assert.equal(request.messages[2].content[1].image_url.url, 'data:image/png;base64,AA==');
  assert.deepEqual(request.messages[3].tool_calls.map(t => t.id), ['c1', 'c2']);
  assert.equal(request.messages[4].tool_call_id, 'c2');
  assert.equal(request.messages[5].content, 'A');
  assert.equal(JSON.parse(request.messages[6].tool_calls[0].function.arguments).input, patch);
  assert.equal(request.messages[6].content, 'Fixing');
  assert.equal(request.messages[7].tool_call_id, 'p1');
  assert.equal(request.reasoning_effort, 'high');
  assert.equal(request.max_tokens, 200);
  assert.equal(request.tools[1].function.parameters.properties.input.type, 'string');
});

test('rejects unsupported builtin tools and unmatched tool outputs explicitly', () => {
  assert.throws(() => toChatRequest({ model: 'm', input: 'hi', tools: [{ type: 'web_search' }] }), /unsupported.*web_search/i);
  assert.throws(() => toChatRequest({ model: 'm', input: [{ type: 'function_call_output', call_id: 'missing', output: 'oops' }] }), /missing|unmatched/i);
  assert.throws(() => toChatRequest({ model: 'm', input: 'hi', previous_response_id: 'old' }), /previous_response_id/i);
});

test('streams unicode text with complete lifecycle and usage before successful completion', async () => {
  const events = await collect([chunk({ content: '你' }), chunk({ content: '好😀' }, 'stop'), { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } } }, '[DONE]']);
  assert.deepEqual(events.slice(0, 2).map(e => e.event), ['response.created', 'response.in_progress']);
  assert.equal(events.filter(e => e.event === 'response.output_text.delta').map(e => e.data.delta).join(''), '你好😀');
  assert.equal(events.at(-1).event, 'response.completed');
  assert.equal(events.at(-1).data.response.output[0].content[0].text, '你好😀');
  assert.equal(events.at(-1).data.response.usage.input_tokens, 5);
  assert.equal(events.at(-1).data.response.usage.output_tokens_details.reasoning_tokens, 1);
  assert.deepEqual(events.map(e => e.data.sequence_number), events.map((_, i) => i));
  for (const event of events) assert.equal(event.data.type, event.event);
});

test('interleaves parallel tool argument deltas and text, reconstructs split tool names', async () => {
  const events = await collect([
    chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_' } }, { index: 1, id: 'c2', function: { name: 'read_file', arguments: '{"path":' } }] }),
    chunk({ content: 'Working', tool_calls: [{ index: 0, function: { name: 'file', arguments: '{"path":"a' } }, { index: 1, function: { arguments: '"b"}' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"}' } }] }, 'tool_calls'), '[DONE]'
  ], { tools: [tool] });
  const output = events.at(-1).data.response.output;
  const calls = output.filter(i => i.type === 'function_call');
  assert.deepEqual(calls.map(i => [i.call_id, i.name, i.arguments]), [['c1', 'read_file', '{"path":"a"}'], ['c2', 'read_file', '{"path":"b"}']]);
  assert.equal(output.find(i => i.type === 'message').content[0].text, 'Working');
  assert.equal(events.filter(e => e.event === 'response.function_call_arguments.done').length, 2);
  assert.ok(events.some(e => e.event === 'response.function_call_arguments.delta'));
  const added = events.filter(e => e.event === 'response.output_item.added');
  assert.ok(added.every(e => e.data.item.type !== 'function_call' || e.data.item.name === 'read_file'));
});

test('custom patch wrapper streams decoded escaped input and restores custom call identity', async () => {
  const patch = '*** Begin Patch\n*** Add File: 中文.txt\n+"hi" 😀\n*** End Patch';
  const args = JSON.stringify({ input: patch });
  const pieces = [];
  for (let i = 0; i < args.length; i += 3) pieces.push(chunk({ tool_calls: [{ index: 0, ...(i === 0 ? { id: 'patch_call', function: { name: 'apply_patch', arguments: args.slice(i, i + 3) } } : { function: { arguments: args.slice(i, i + 3) } }) }] }));
  pieces.push(chunk({}, 'tool_calls'), '[DONE]');
  const events = await collect(pieces, { tools: [custom] });
  assert.equal(events.filter(e => e.event === 'response.custom_tool_call_input.delta').map(e => e.data.delta).join(''), patch);
  assert.equal(events.at(-1).data.response.output[0].type, 'custom_tool_call');
  assert.equal(events.at(-1).data.response.output[0].input, patch);
  assert.equal(events.at(-1).data.response.output[0].call_id, 'patch_call');
  assert.ok(events.filter(e => e.event === 'response.custom_tool_call_input.delta').length > 2);
});

test('propagates reasoning content as a reasoning item and keeps final text separate', async () => {
  const events = await collect([chunk({ reasoning_content: '考虑' }), chunk({ reasoning_content: '一下' }), chunk({ content: '答案' }, 'stop'), '[DONE]']);
  assert.equal(events.filter(e => e.event === 'response.reasoning_summary_text.delta').map(e => e.data.delta).join(''), '考虑一下');
  const output = events.at(-1).data.response.output;
  assert.equal(output[0].type, 'reasoning');
  assert.equal(output[0].summary[0].text, '考虑一下');
  assert.equal(output[1].content[0].text, '答案');
});

test('does not claim completion for upstream errors, truncated streams, or invalid custom JSON', async () => {
  for (const [parts, options] of [
    [[chunk({ content: 'partial' }), { error: { code: 'quota', message: 'No quota' } }], {}],
    [[chunk({ content: 'partial' })], {}],
    [[chunk({ tool_calls: [{ index: 0, id: 'p', function: { name: 'apply_patch', arguments: '{"input":' } }] }, 'tool_calls'), '[DONE]'], { tools: [custom] }]
  ]) {
    const events = await collect(parts, options);
    assert.equal(events.at(-1).event, 'response.failed');
    assert.ok(!events.some(e => e.event === 'response.completed'));
    assert.ok(events.at(-1).data.response.error.message);
  }
});

test('length finish is incomplete instead of completed', async () => {
  const events = await collect([chunk({ content: 'cut' }, 'length'), '[DONE]']);
  assert.equal(events.at(-1).event, 'response.incomplete');
  assert.equal(events.at(-1).data.response.incomplete_details.reason, 'max_output_tokens');
});

test('yields text before upstream closes (does not buffer whole response)', async () => {
  let controller;
  const body = new ReadableStream({ start(c) { controller = c; } });
  const iterator = toResponseEvents(body, { model: 'm', responseId: 'resp_live' });
  assert.equal((await iterator.next()).value.event, 'response.created');
  assert.equal((await iterator.next()).value.event, 'response.in_progress');
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk({ content: 'live' }))}\n\n`));
  const events = [];
  for (let i = 0; i < 3; i++) events.push((await iterator.next()).value);
  assert.equal(events.at(-1).event, 'response.output_text.delta');
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`));
  controller.close();
  await Array.fromAsync({ [Symbol.asyncIterator]: () => iterator });
});

test('handles id arriving after the tool name and preserves exact raw JSON arguments', async () => {
  const args = '{ "path" : "中文" }';
  const events = await collect([
    chunk({ tool_calls: [{ index: 0, function: { name: 'read_file', arguments: args.slice(0, 6) } }] }),
    chunk({ tool_calls: [{ index: 0, id: 'late_id', function: { arguments: args.slice(6) } }] }, 'tool_calls'), '[DONE]'
  ], { tools: [tool] });
  assert.equal(events.at(-1).event, 'response.completed');
  assert.equal(events.at(-1).data.response.output[0].call_id, 'late_id');
  assert.equal(events.at(-1).data.response.output[0].arguments, args);
});

test('does not expose unregistered tool calls, duplicate call ids, or malformed function JSON as success', async () => {
  for (const calls of [
    [{ index: 0, id: 'a', function: { name: 'not_registered', arguments: '{}' } }],
    [{ index: 0, id: 'same', function: { name: 'read_file', arguments: '{}' } }, { index: 1, id: 'same', function: { name: 'read_file', arguments: '{}' } }],
    [{ index: 0, id: 'bad', function: { name: 'read_file', arguments: '{' } }]
  ]) {
    const events = await collect([chunk({ tool_calls: calls }, 'tool_calls'), '[DONE]'], { tools: [tool] });
    assert.equal(events.at(-1).event, 'response.failed');
    assert.ok(!events.some(e => e.event === 'response.completed'));
  }
});

test('rejects unsupported request persistence and unknown custom formats', () => {
  assert.throws(() => toChatRequest({ model: 'm', input: 'hi', store: true }), /store/i);
  assert.throws(() => toChatRequest({ model: 'm', input: 'hi', tools: [{ type: 'custom', name: 'x', format: { type: 'magic' } }] }), /format/i);
});

test('rejects ambiguous tool declarations and malformed arrays with a request error', () => {
  assert.throws(() => toChatRequest({ model: 'm', input: 'hi', tools: [tool, { ...custom, name: tool.name }] }), /duplicate/i);
  assert.throws(() => toChatRequest({ model: 'm', input: 'hi', tools: 'bad' }), error => error.status === 400 && /tools/i.test(error.message));
});

test('refusal is represented as output_refusal with its lifecycle instead of a transport failure', async () => {
  const events = await collect([chunk({ refusal: 'Cannot ' }), chunk({ refusal: 'help' }, 'stop'), '[DONE]']);
  assert.equal(events.at(-1).event, 'response.completed');
  assert.deepEqual(events.at(-1).data.response.output[0].content[0], { type: 'refusal', refusal: 'Cannot help' });
  assert.equal(events.filter(e => e.event === 'response.refusal.delta').map(e => e.data.delta).join(''), 'Cannot help');
  assert.equal(events.filter(e => e.event === 'response.refusal.done').length, 1);
});

test('switches mixed official encrypted reasoning history without losing readable messages, summaries or tool history', () => {
  const request = toChatRequest({ model: 'm', tools: [tool], input: [
    { role: 'user', content: '保留问题' },
    { type: 'reasoning', encrypted_content: 'opaque-only', summary: [] },
    { type: 'reasoning', encrypted_content: 'opaque-with-summary', summary: [{ type: 'summary_text', text: '可读推理摘要' }] },
    { role: 'assistant', content: [{ type: 'output_text', text: '保留答复' }] },
    { type: 'function_call', call_id: 'prior_call', name: 'read_file', arguments: '{ "path":"a" }' },
    { type: 'function_call_output', call_id: 'prior_call', output: '保留工具结果' },
    { role: 'user', content: '现在使用WorkBuddy继续' }
  ] });
  assert.equal(request.messages.length, 4);
  assert.equal(request.messages[0].content, '保留问题');
  assert.equal(request.messages[1].content, '保留答复');
  assert.equal(request.messages[1].reasoning_content, '可读推理摘要');
  assert.equal(request.messages[1].tool_calls[0].id, 'prior_call');
  assert.equal(request.messages[1].tool_calls[0].function.arguments, '{ "path":"a" }');
  assert.equal(request.messages[2].content, '保留工具结果');
  assert.equal(request.messages[3].content, '现在使用WorkBuddy继续');
  assert.ok(!JSON.stringify(request).includes('opaque'));
});

test('flattens namespace tools and restores function/custom identities in streamed calls', async () => {
  const namespace = { type: 'namespace', name: 'functions', description: 'Client tools', tools: [tool, custom] };
  const request = toChatRequest({ model: 'm', tools: [namespace], input: [
    { type: 'function_call', namespace: 'functions', name: 'read_file', call_id: 'old', arguments: '{}' },
    { type: 'function_call_output', call_id: 'old', output: 'ok' },
    { role: 'user', content: 'go' }
  ] });
  assert.deepEqual(request.tools.map(t => t.function.name), ['functions__read_file', 'functions__apply_patch']);
  assert.equal(request.messages[0].tool_calls[0].function.name, 'functions__read_file');
  const events = await collect([chunk({ tool_calls: [
    { index: 0, id: 'f', function: { name: 'functions__read_file', arguments: '{"path":"a"}' } },
    { index: 1, id: 'p', function: { name: 'functions__apply_patch', arguments: '{"input":"*** Begin Patch\\n*** End Patch"}' } }
  ] }, 'tool_calls'), '[DONE]'], { tools: [namespace] });
  assert.equal(events.at(-1).event, 'response.completed');
  assert.deepEqual(events.at(-1).data.response.output.map(i => [i.type, i.namespace, i.name]), [
    ['function_call', 'functions', 'read_file'], ['custom_tool_call', 'functions', 'apply_patch']
  ]);
});
