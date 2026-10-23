/** End-to-end benchmark: requires running broker + Firefox. Public localhost fixture only. */
import http from 'node:http';
import {performance} from 'node:perf_hooks';
const base=process.env.BROKER_URL||'http://127.0.0.1:8765';
const admin=process.env.BROKER_ADMIN_TOKEN;
const n=Number(process.argv[2]||4), mode=process.argv[3]||'auto';
if(!admin||!Number.isInteger(n)||n<1||n>16||!['auto','dedicated','shared'].includes(mode))
  throw new Error('BROKER_ADMIN_TOKEN required; usage: node scripts/benchmark.mjs [1..16] [auto|shared|dedicated]');
const fixture=http.createServer((req,res)=>{
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
  res.end('<!doctype html><title>BiDi Test Fixture</title><button id="go" onclick="this.textContent=\'clicked\'">click me</button>');
});
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
const target=`http://127.0.0.1:${fixture.address().port}/`;
async function call(path,token,method='GET',body){
  const start=performance.now();
  const res=await fetch(base+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const json=await res.json(); if(!res.ok)throw new Error(`${method} ${path}: ${res.status} ${json.error}`);
  return {json,ms:Math.round((performance.now()-start)*10)/10};
}
const tasks=[];
try {
  for(let i=0;i<n;i++) tasks.push((await call('/v1/tasks',admin,'POST',{mode,leaseSeconds:300})).json);
  const started=performance.now();
  const result=await Promise.allSettled(tasks.map(async t=>{
    const durations={};
    durations.navigate=(await call(`/v1/tasks/${t.id}/navigate`,t.token,'POST',{url:target})).ms;
    durations.click=(await call(`/v1/tasks/${t.id}/click`,t.token,'POST',{selector:'#go'})).ms;
    const snap=await call(`/v1/tasks/${t.id}/snapshot`,t.token);durations.snapshot=snap.ms;
    if(!snap.json.text.includes('clicked'))throw new Error('Trusted click did not modify page');
    const shot=await call(`/v1/tasks/${t.id}/screenshot`,t.token);durations.screenshot=shot.ms;
    if(!shot.json.base64)throw new Error('Empty screenshot');
    return {id:t.id,browserId:t.browserId,mode:t.mode,durations};
  }));
  const pass=result.filter(x=>x.status==='fulfilled').map(x=>x.value),errors=result.filter(x=>x.status==='rejected').map(x=>String(x.reason));
  const sorted=pass.flatMap(v=>Object.values(v.durations)).sort((a,b)=>a-b);
  const p95=sorted.length?sorted[Math.ceil(sorted.length*.95)-1]:null;
  console.log(JSON.stringify({agentCount:n,mode,passed:pass.length,failed:errors.length,wallMs:Math.round(performance.now()-started),p95ActionMs:p95,results:pass,errors},null,2));
  if(errors.length)process.exitCode=1;
}finally{
  await Promise.all(tasks.map(t=>call(`/v1/tasks/${t.id}`,t.token,'DELETE').catch(()=>{})));
  await new Promise(r=>fixture.close(r));
}
