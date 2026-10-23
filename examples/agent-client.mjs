/** Invoke with BROKER_ADMIN_TOKEN and BROKER_URL set. Creates an isolated short task. */
const base=process.env.BROKER_URL||'http://127.0.0.1:8765';
const admin=process.env.BROKER_ADMIN_TOKEN;
if(!admin)throw new Error('Set BROKER_ADMIN_TOKEN');
async function call(path,token,method='GET',body){
  const r=await fetch(`${base}${path}`,{method,headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const json=await r.json();if(!r.ok)throw new Error(`HTTP ${r.status}: ${JSON.stringify(json)}`);return json;
}
const task=await call('/v1/tasks',admin,'POST',{mode:'auto',leaseSeconds:120});
try {
  console.log('Allocated',task.id,'on',task.browserId);
  await call(`/v1/tasks/${task.id}/navigate`,task.token,'POST',{url:'https://example.com/'});
  const snapshot=await call(`/v1/tasks/${task.id}/snapshot`,task.token);
  console.log('Page title:',snapshot.title);
  console.log('Events:',(await call(`/v1/tasks/${task.id}/events`,task.token)).events.length);
} finally {await call(`/v1/tasks/${task.id}`,task.token,'DELETE').catch(()=>{});}
