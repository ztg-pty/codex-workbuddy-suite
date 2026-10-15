import test from 'node:test';
import assert from 'node:assert/strict';
import {createQueue,QueueFullError,QueueTimeoutError,QueueAbortedError,withRetry,isRetryableBeforeStream,isThrottleCode} from '../src/queue.mjs';

test('an unlimited queue runs tasks concurrently and never rejects as full',async()=>{
  const queue=createQueue({provider:'workbuddy',limit:Infinity,maxWaiting:1});
  let peak=0,active=0;
  const task=()=>queue.run(async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,20));active--;});
  await Promise.all(Array.from({length:8},task));
  assert.equal(peak,8,'unlimited queue must not serialise work');
  assert.equal(queue.stats().waiting,0);
});

test('a limited queue holds work to the limit and serves waiters in order',async()=>{
  const queue=createQueue({provider:'zcode',limit:2,maxWaiting:10});
  let active=0;const peak=[];const order=[];
  const tasks=Array.from({length:6},(_,index)=>queue.run(async()=>{
    active++;peak.push(active);order.push(index);
    await new Promise(r=>setTimeout(r,15));
    active--;
  }));
  await Promise.all(tasks);
  assert.ok(Math.max(...peak)<=2,'ZCode must not exceed its concurrency limit');
  assert.deepEqual(order,[0,1,2,3,4,5],'waiters are served in arrival order');
});

test('a full bounded queue rejects with a typed error instead of growing forever',async()=>{
  const queue=createQueue({provider:'zcode',limit:1,maxWaiting:1});
  const release=new Promise(()=>{});
  const held=queue.run(()=>release);
  const waiting=queue.run(()=>release);
  await assert.rejects(()=>queue.run(async()=>{}),error=>error instanceof QueueFullError&&error.code==='queue-full');
  void held;void waiting;
});

test('a waiting request honours its queue timeout',async()=>{
  const queue=createQueue({provider:'zcode',limit:1,maxWaiting:4,waitTimeoutMs:30});
  const release=new Promise(()=>{});
  const held=queue.run(()=>release);
  await assert.rejects(()=>queue.run(async()=>{}),error=>error instanceof QueueTimeoutError);
  void held;
});

test('aborting a queued request removes it rather than running it later',async()=>{
  const queue=createQueue({provider:'zcode',limit:1,maxWaiting:4});
  const release=new Promise(()=>{});
  const held=queue.run(()=>release);
  const controller=new AbortController();
  const queued=queue.run(async()=>{throw new Error('should not run');},{signal:controller.signal});
  controller.abort();
  await assert.rejects(()=>queued,error=>error instanceof QueueAbortedError);
  assert.equal(queue.stats().waiting,0,'an aborted waiter is removed from the queue');
  void held;
});

test('throttling is retried with backoff so the caller never sees it',async()=>{
  let attempts=0;const delays=[];
  const result=await withRetry(async()=>{
    attempts++;
    if(attempts<3)throw Object.assign(new Error('rate'),{code:'upstream-rate'});
    return 'ok';
  },{retries:5,baseDelayMs:1,maxDelayMs:2,isRetryable:isRetryableBeforeStream,onRetry:({delayMs})=>delays.push(delayMs)});
  assert.equal(result,'ok');
  assert.equal(attempts,3);
  assert.equal(delays.length,2);
});

test('a non-retryable failure is surfaced immediately',async()=>{
  let attempts=0;
  await assert.rejects(()=>withRetry(async()=>{attempts++;throw Object.assign(new Error('auth'),{code:'upstream-auth'});},{
    retries:5,baseDelayMs:1,isRetryable:isRetryableBeforeStream
  }),/auth/);
  assert.equal(attempts,1);
});

test('a response that already started streaming is never retried',()=>{
  assert.equal(isRetryableBeforeStream({code:'upstream-rate'}),true);
  assert.equal(isRetryableBeforeStream({code:'upstream-rate'},{streamStarted:true}),false);
  assert.equal(isRetryableBeforeStream({code:'upstream-auth'}),false);
  assert.equal(isThrottleCode('upstream-rate'),true);
  // Credit exhaustion is a settled answer, not a throttle: retrying it only
  // wastes time and still fails.
  assert.equal(isThrottleCode('upstream-credit'),false);
  assert.equal(isRetryableBeforeStream({code:'upstream-credit'}),false);
});

test('retry stops when the client aborts',async()=>{
  const controller=new AbortController();
  let attempts=0;
  const pending=withRetry(async()=>{attempts++;throw Object.assign(new Error('rate'),{code:'upstream-rate'});},{
    retries:10,baseDelayMs:50,isRetryable:isRetryableBeforeStream,signal:controller.signal
  });
  setTimeout(()=>controller.abort(),10);
  await assert.rejects(()=>pending);
  assert.ok(attempts<10,'aborting ends the retry loop');
});
