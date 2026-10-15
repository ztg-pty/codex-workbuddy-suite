// TTL + change-detection wrapper around an async catalog producer.
//
// Concurrent callers share one in-flight refresh. A refresh that yields the
// same fingerprint skips the persistence callback, so a steady-state gateway
// stops rewriting catalog.json on every read.
export function createCatalogCache({compute,persist=async()=>{},fingerprint=models=>JSON.stringify(models.map(model=>[model.slug,model.context_window,model.display_name])),ttlMs=60000,now=Date.now}={}){
  let expiresAt=0,inflight,lastFingerprint,lastValue;
  const refresh=async({force=false}={})=>{
    if(!force&&expiresAt&&now()<expiresAt&&lastValue!==undefined)return {value:lastValue,cached:true};
    if(inflight)return inflight;
    inflight=(async()=>{
      const value=await compute();
      const current=fingerprint(value.models??[]);
      if(current!==lastFingerprint){lastFingerprint=current;await persist(value);}
      lastValue=value;expiresAt=now()+ttlMs;
      return {value,cached:false};
    })().finally(()=>{inflight=undefined;});
    return inflight;
  };
  return {
    refresh,
    invalidate(){expiresAt=0;},
    get fingerprint(){return lastFingerprint;},
  };
}
