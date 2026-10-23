import http from 'node:http';
import { BrowserBroker, HttpError, equalSecrets } from './broker.mjs';
import { loadConfig } from './config.mjs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const payload = (req,max=1024*1024) => new Promise((resolve,reject)=> {
  let size=0,parts=[];
  req.on('data',chunk=> {size+=chunk.length;if(size>max){reject(new HttpError(413,'Body too large'));req.destroy();}else parts.push(chunk);});
  req.on('end',()=> {try {resolve(JSON.parse(Buffer.concat(parts).toString()||'{}'));}catch {reject(new HttpError(400,'Invalid JSON'));}});
  req.on('error',reject);
});
const reply=(res,status,body)=> {
  if(res.destroyed)return;
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(body));
};
export function serve(broker,adminToken) {
  if(typeof adminToken!=='string'||adminToken.length<24)throw new Error('Set BROKER_ADMIN_TOKEN (24+ characters)');
  const srv=http.createServer(async(req,res)=> {
    try {
      const path=new URL(req.url,'http://127.0.0.1').pathname;
      const parts=path.split('/').filter(Boolean);
      const bearer=/^Bearer (.+)$/.exec(req.headers.authorization||'')?.[1];
      if(parts[0]!=='v1')throw new HttpError(404,'Unknown endpoint');
      if(parts.length===2&&parts[1]==='browsers'&&req.method==='GET'){
        if(!equalSecrets(bearer,adminToken))throw new HttpError(403,'Forbidden');
        return reply(res,200,{browsers:broker.stats()});
      }
      if(parts.length===2&&parts[1]==='tasks'&&req.method==='POST'){
        if(!equalSecrets(bearer,adminToken))throw new HttpError(403,'Forbidden');
        return reply(res,201,await broker.create(await payload(req)));
      }
      if(parts[1]!=='tasks'||parts.length<3)throw new HttpError(404,'Unknown endpoint');
      const task=broker.get(parts[2],bearer);
      if(parts.length===3&&req.method==='GET')return reply(res,200,task ? {task:{id:task.id,browserId:task.browserId,mode:task.mode,state:task.state,expiresAt:new Date(task.expiresAt).toISOString()}}:{});
      if(parts.length===3&&req.method==='DELETE') {await broker.destroy(task);return reply(res,200,{closed:true});}
      if(parts.length!==4)throw new HttpError(404,'Unknown endpoint');
      const action=parts[3], method=req.method;
      const bodies=['renew','navigate','click','type','scroll','cookies'];
      if(bodies.includes(action)&&method==='POST') {
        const body=await payload(req);
        const result=action==='renew'?broker.renew(task,body):await ({
          navigate:()=>broker.navigate(task,body),click:()=>broker.click(task,body),
          type:()=>broker.type(task,body),scroll:()=>broker.scroll(task,body),cookies:()=>broker.setCookies(task,body)
        }[action]?.()||Promise.reject(new HttpError(404,'Unknown endpoint')));
        return reply(res,200,result);
      }
      if(action==='snapshot'&&method==='GET')return reply(res,200,await broker.snapshot(task));
      if(action==='screenshot'&&method==='GET'){
        const query=new URL(req.url,'http://127.0.0.1').searchParams;
        return reply(res,200,await broker.screenshot(task,{format:query.get('format')||'jpeg',origin:query.get('origin')||'viewport',quality:Number(query.get('quality')||0.7)}));
      }
      if(action==='events'&&method==='GET') {
        const query=new URL(req.url,'http://127.0.0.1').searchParams;
        return reply(res,200,{events:broker.events(task,{clear:query.get('clear')==='1'})});
      }
      throw new HttpError(404,'Unknown endpoint');
    } catch(err) {
      // Avoid leaking protocol stacktraces, cookie contents or internal paths to API clients.
      const status=err instanceof HttpError?err.status:err.code==='unavailable'?503:err.code==='timeout'?504:502;
      reply(res,status,{error:err instanceof HttpError?err.message:err.code==='timeout'?'Browser timed out':'Browser operation failed'});
    }
  });
  return srv;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const config=loadConfig();
  const broker=new BrowserBroker(config);
  await broker.start();
  const server=serve(broker,process.env.BROKER_ADMIN_TOKEN);
  server.listen(config.port,config.listen,()=>console.log(`Firefox hybrid broker listening on http://${config.listen}:${config.port}`));
  const shutdown=async()=> {server.close();await broker.close();process.exit(0);};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
