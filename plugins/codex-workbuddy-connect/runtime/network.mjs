import { execFileSync } from 'node:child_process';
export function configureProcessProxy() {
  const loopback=['127.0.0.1','localhost','::1'];
  process.env.NO_PROXY=[...new Set([...(process.env.NO_PROXY??process.env.no_proxy??'').split(',').filter(Boolean),...loopback])].join(',');
  process.env.no_proxy=process.env.NO_PROXY;
  if(process.platform==='win32'&&!process.env.HTTPS_PROXY&&!process.env.HTTP_PROXY){
    try{
      const settings=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',"Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' | Select-Object ProxyEnable,ProxyServer | ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true,timeout:5000}));
      if(settings.ProxyEnable&&settings.ProxyServer){
        const entry=settings.ProxyServer.split(';').find(s=>s.startsWith('http='))??settings.ProxyServer.split(';')[0];
        const address=entry.replace(/^(https?|socks)=/,'');
        if(/^(?:https?:\/\/)?[A-Za-z0-9.\-\[\]:]+$/.test(address)){
          const proxy=address.startsWith('http')?address:'http://'+address;
          process.env.HTTP_PROXY=proxy;process.env.HTTPS_PROXY=proxy;
        }
      }
    }catch{}
  }
  return{proxyConfigured:!!(process.env.HTTPS_PROXY||process.env.HTTP_PROXY),loopbackBypass:true};
}
