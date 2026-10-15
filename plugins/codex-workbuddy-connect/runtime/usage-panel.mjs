import {randomBytes} from 'node:crypto';
import {usageHtml} from './usage-page.mjs';

export function createUsagePanel({readUsage,now=Date.now}){
  const tickets=new Map(),sessions=new Map();
  const send=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
  return async(req,res,url,{managementKeyValid=false}={})=>{
    if(url.pathname!=='/usage'&&!url.pathname.startsWith('/usage/'))return false;
    const origin='http://'+req.headers.host;
    if(req.headers.origin&&req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site'){send(res,403,{error:'origin-rejected'});return true;}
    for(const [key,expires]of tickets)if(expires<=now())tickets.delete(key);
    for(const [key,expires]of sessions)if(expires<=now())sessions.delete(key);
    if(url.pathname==='/usage/session'&&req.method==='POST'){
      if(!managementKeyValid){send(res,401,{error:'local-auth-required'});return true;}
      if(tickets.size>=32)tickets.delete(tickets.keys().next().value);
      const ticket=randomBytes(24).toString('hex');tickets.set(ticket,now()+30000);
      send(res,200,{path:'/usage/open?ticket='+ticket});return true;
    }
    if(url.pathname==='/usage/open'&&req.method==='GET'){
      const ticket=url.searchParams.get('ticket');if(!tickets.has(ticket)){send(res,401,{error:'ticket-expired'});return true;}
      tickets.delete(ticket);const session=randomBytes(32).toString('hex');
      if(sessions.size>=32)sessions.delete(sessions.keys().next().value);
      sessions.set(session,now()+86400000);
      res.writeHead(303,{'location':'/usage','set-cookie':'wb_usage='+session+'; HttpOnly; SameSite=Strict; Path=/usage; Max-Age=86400','cache-control':'no-store','referrer-policy':'no-referrer'});res.end();return true;
    }
    const session=(req.headers.cookie??'').split(';').map(value=>value.trim()).find(value=>value.startsWith('wb_usage='))?.slice(9);
    if(!sessions.has(session)){send(res,401,{error:'panel-session-required',message:'请从桌面的统一额度面板入口重新打开。'});return true;}
    if(req.method==='GET'&&url.pathname==='/usage/api'){send(res,200,await readUsage());return true;}
    if(req.method==='GET'&&url.pathname==='/usage'){
      const nonce=randomBytes(16).toString('base64');
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff',
        'content-security-policy':"default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"});
      res.end(usageHtml.replace('__SCRIPT_NONCE__',nonce));return true;
    }
    send(res,404,{error:'unknown-panel-endpoint'});return true;
  };
}
