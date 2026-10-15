// Per-provider admission queue.
//
// Behaviour the user asked for:
//   - official: unlimited, never queued;
//   - workbuddy: unlimited concurrency, but still funnels through the queue so
//     an upstream 429 can be retried with backoff instead of reaching the client;
//   - zcode: at most `limit` in flight, the rest wait in a bounded FIFO.
//
// A slot is released as soon as the task settles, and waiters are served in
// arrival order. When the bounded queue is full the caller gets a typed
// `queue-full` error so the gateway can answer 503 rather than piling up memory.

export class QueueFullError extends Error {
  constructor(provider){super(`queue-full: ${provider}`);this.name='QueueFullError';this.code='queue-full';this.provider=provider;}
}
export class QueueTimeoutError extends Error {
  constructor(provider){super(`queue-timeout: ${provider}`);this.name='QueueTimeoutError';this.code='queue-timeout';this.provider=provider;}
}
export class QueueAbortedError extends Error {
  constructor(provider){super(`queue-aborted: ${provider}`);this.name='QueueAbortedError';this.code='queue-aborted';this.provider=provider;}
}

export function createQueue({provider,limit=Infinity,maxWaiting=64,waitTimeoutMs=120000}={}){
  const waiting=[];
  let active=0;
  const unlimited=!Number.isFinite(limit);

  const stats=()=>({provider,limit:unlimited?null:limit,active,waiting:waiting.length});
  const drain=()=>{
    while(waiting.length&&(unlimited||active<limit)){
      const waiter=waiting.shift();
      if(waiter.aborted){waiter.reject(new QueueAbortedError(provider));continue;}
      if(waiter.timer)clearTimeout(waiter.timer);
      active++;
      waiter.resolve(()=>{ // release, idempotent
        if(waiter.released)return;waiter.released=true;active--;drain();
      });
    }
  };

  // Wrap one task: acquire a slot, run, always release.
  async function run(task,{signal}={}){
    const release=await acquire({signal});
    try{return await task();}
    finally{release();}
  }

  function acquire({signal}={}){
    return new Promise((resolve,reject)=>{
      if(signal?.aborted){reject(new QueueAbortedError(provider));return;}
      const waiter={resolve,reject,aborted:false,timer:undefined,released:false};
      const queued=!unlimited&&active>=limit;
      if(queued&&waiting.length>=maxWaiting){reject(new QueueFullError(provider));return;}
      if(Number.isFinite(waitTimeoutMs)&&waitTimeoutMs>0){
        waiter.timer=setTimeout(()=>{waiter.aborted=true;const index=waiting.indexOf(waiter);if(index>=0)waiting.splice(index,1);reject(new QueueTimeoutError(provider));},waitTimeoutMs);
        waiter.timer.unref?.();
      }
      if(signal){
        const onAbort=()=>{waiter.aborted=true;const index=waiting.indexOf(waiter);if(index>=0)waiting.splice(index,1);if(waiter.timer)clearTimeout(waiter.timer);reject(new QueueAbortedError(provider));};
        signal.addEventListener('abort',onAbort,{once:true});
        waiter.cleanup=()=>signal.removeEventListener('abort',onAbort);
      }
      const settle=waiter.resolve;
      waiter.resolve=release=>{if(waiter.timer)clearTimeout(waiter.timer);waiter.cleanup?.();settle(release);};
      waiting.push(waiter);
      drain();
    });
  }

  return {run,acquire,stats};
}

// Retry helper for upstream throttling. The user's requirement is that a
// blocked upstream must not surface as a client-facing 429, so retryable
// failures wait and try again until the budget is exhausted, then surface as a
// retryable upstream error the gateway can translate.
export async function withRetry(task,{
  retries=5,baseDelayMs=750,maxDelayMs=8000,isRetryable=()=>false,onRetry=()=>{},signal,now=Date.now}={}){
  let attempt=0;
  while(true){
    try{return await task();}
    catch(error){
      attempt++;
      if(attempt>retries||!isRetryable(error)||signal?.aborted)throw error;
      const backoff=Math.min(maxDelayMs,baseDelayMs*2**(attempt-1));
      const jitter=Math.floor(Math.random()*Math.max(1,Math.floor(backoff/4)));
      onRetry({attempt,delayMs:backoff+jitter,error});
      await delay(backoff+jitter,{signal});
    }
  }
  function delay(ms,{signal:abortSignal}={}){
    return new Promise((resolve,reject)=>{
      if(abortSignal?.aborted){reject(new QueueAbortedError('retry'));return;}
      const timer=setTimeout(()=>{abortSignal?.removeEventListener?.('abort',onAbort);resolve();},ms);
      const onAbort=()=>{clearTimeout(timer);reject(new QueueAbortedError('retry'));};
      abortSignal?.addEventListener?.('abort',onAbort,{once:true});
    });
  }
}

// Only a genuine rate limit is retried. Credit exhaustion is a settled answer:
// retrying it burns time and still fails, so it is surfaced immediately.
export function isThrottleCode(code){return code==='upstream-rate';}

// A throttled upstream can only be retried safely before any bytes were
// delivered. Once a stream has started, retrying would duplicate output, so the
// caller marks the response as started and retry stops applying.
export function isRetryableBeforeStream(error,{streamStarted=false}={}){
  if(streamStarted)return false;
  return isThrottleCode(error?.code);
}
