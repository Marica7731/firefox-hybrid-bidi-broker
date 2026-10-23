import { randomBytes, timingSafeEqual } from 'node:crypto';
import { BidiClient, BidiError } from './bidi.mjs';

export const secret = () => randomBytes(32).toString('base64url');
export function equalSecrets(a,b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x,y);
}
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
class Mutex {
  constructor() { this.tail = Promise.resolve(); }
  async run(fn) {
    let release;
    const prev = this.tail;
    this.tail = new Promise(resolve => { release = resolve; });
    await prev;
    try { return await fn(); } finally { release(); }
  }
}
const safeText = (x,max=200) => typeof x === 'string' ? x.slice(0,max) : '';
const urlSafe = raw => {
  const u = new URL(raw);
  if (!['http:','https:'].includes(u.protocol)) throw new HttpError(400,'Only http/https navigation allowed');
  return u.toString();
};
const taskPublic = t => ({id:t.id,mode:t.mode,browserId:t.browserId,context:t.context,userContext:t.userContext,
  expiresAt:new Date(t.expiresAt).toISOString(),state:t.state});

export class BrowserBroker {
  constructor(config, {clientFactory = (url) => new BidiClient(url), now=()=>Date.now()} = {}) {
    this.config=config; this.now=now;
    this.clients = new Map(); this.tasks = new Map(); this.contextTasks=new Map();
    this.nodes = config.browsers.map(b=>({...b, state:'starting', input:new Mutex(), allocations:0, client:clientFactory(b.wsUrl)}));
    for(const n of this.nodes) {
      n.client.onEvent(evt=>this.routeEvent(n,evt));
      n.client.onDisconnect?.(()=>{n.state='unavailable';});
    }
    this.allocMutex = new Mutex();
  }
  async start() {
    // A failed browser does not prevent the broker from serving other pools.
    await Promise.all(this.nodes.map(async n=> {
      try { await n.client.connect(); n.state='ready'; }
      catch { n.state='unavailable'; }
    }));
    this.timer = setInterval(()=>this.reap().catch(()=>{}), 15000);
    this.timer.unref?.();
  }
  stats() { return this.nodes.map(n=>({id:n.id,mode:n.mode,capacity:n.capacity,allocations:n.allocations,state:n.state})); }
  pick(mode='auto') {
    if(!['auto','shared','dedicated'].includes(mode)) throw new HttpError(400,'mode must be auto/shared/dedicated');
    const ready=this.nodes.filter(n=>n.state==='ready' && n.allocations<n.capacity && (mode==='auto'||n.mode===mode));
    // auto: prefer a shared slot to lower process usage; callers can require dedicated.
    ready.sort((a,b)=>(mode==='auto'?Number(a.mode!=='shared')-Number(b.mode!=='shared'):0)||a.allocations-b.allocations);
    return ready[0] || null;
  }
  async create({mode='auto',leaseSeconds}={}) {
    return this.allocMutex.run(async()=> {
      const n=this.pick(mode);
      if(!n) throw new HttpError(503,'No browser capacity for requested mode');
      const ttl=this.ttl(leaseSeconds);
      // Never create tasks in the default user context.
      const created=await n.client.send('browser.createUserContext',{});
      let context;
      try {
        const result=await n.client.send('browsingContext.create',{type:'tab',background:true,userContext:created.userContext});
        context=result.context;
      } catch(err) { await n.client.send('browser.removeUserContext',{userContext:created.userContext}).catch(()=>{}); throw err; }
      const id=randomBytes(12).toString('hex'), token=secret();
      const task={id,token,browserId:n.id,mode:n.mode,node:n,context,userContext:created.userContext,
        createdAt:this.now(),expiresAt:this.now()+ttl*1000,events:[],state:'active',op:new Mutex()};
      n.allocations++;this.tasks.set(id,task);this.contextTasks.set(`${n.id}:${context}`,id);
      return {...taskPublic(task),token};
    });
  }
  ttl(seconds) {
    const value = seconds === undefined ? this.config.leaseSeconds : seconds;
    if(!Number.isInteger(value)||value<30||value>this.config.leaseMaxSeconds) throw new HttpError(400,'Invalid leaseSeconds');
    return value;
  }
  get(id,token) {
    const t=this.tasks.get(id);
    if (!t || !equalSecrets(t.token,token)) throw new HttpError(403,'Unknown task or invalid token');
    if(t.state!=='active'||this.now()>=t.expiresAt) throw new HttpError(410,'Task is no longer active');
    if(t.node.state!=='ready') throw new HttpError(503,'Browser unavailable');
    return t;
  }
  renew(t,{leaseSeconds}={}) {t.expiresAt=this.now()+this.ttl(leaseSeconds)*1000;return taskPublic(t);}
  async destroy(t) {
    if(t.state!=='active') return;
    t.state='closing';
    // wait for any ongoing action before removing contexts
    await t.op.run(async()=> {
      this.contextTasks.delete(`${t.browserId}:${t.context}`);
      await t.node.client.send('browser.removeUserContext',{userContext:t.userContext}).catch(()=>{});
      t.node.allocations=Math.max(0,t.node.allocations-1);
      t.state='closed'; this.tasks.delete(t.id);
    });
  }
  async reap() {
    const expired=[...this.tasks.values()].filter(t=>this.now()>=t.expiresAt || t.node.state==='unavailable');
    await Promise.all(expired.map(t=>this.destroy(t)));
    for (const n of this.nodes.filter(n=>n.state==='unavailable' && n.allocations===0)) {
      try { await n.client.connect(); n.state='ready'; } catch { /* retry next interval */ }
    }
  }
  async close() {clearInterval(this.timer);await Promise.all([...this.tasks.values()].map(t=>this.destroy(t)));this.nodes.forEach(n=>n.client.close());}
  routeEvent(node,event) {
    const p=event.params || {};
    let key=p.context;
    // Not all sub-frame events identify a top-level browsing context. Unattributed data is dropped.
    const id=this.contextTasks.get(`${node.id}:${key}`);
    if(!id) return;
    const t=this.tasks.get(id);if(!t || t.state!=='active') return;
    // Never store cookies, authorization headers, request bodies, query strings or other secrets in logs.
    let record;
    if(event.method.startsWith('network.')) record={type:event.method,at:this.now(),method:p.request?.method,
      origin: (()=>{try{return new URL(p.request?.url || p.response?.url).origin;}catch{return '';}})(),
      status:p.response?.status,requestId:p.request?.request};
    else if(event.method==='log.entryAdded') record={type:event.method,at:this.now(),level:p.level,kind:p.type};
    else record={type:event.method,at:this.now()};
    t.events.push(record);
    if(t.events.length>this.config.eventLimit)t.events.splice(0,t.events.length-this.config.eventLimit);
  }
  events(t,{clear=false}={}){const events=[...t.events];if(clear)t.events=[];return events;}
  async navigate(t,body) {
    const url=urlSafe(body.url);
    // Navigation can change focus and is therefore part of the per-instance input lock.
    return t.op.run(()=>t.node.input.run(()=>t.node.client.send('browsingContext.navigate',{
      context:t.context,url,wait:'complete'
    })));
  }
  async screenshot(t,{format='jpeg',quality=0.7,origin='viewport'}={}) {
    if(!['jpeg','png'].includes(format)||!['viewport','document'].includes(origin))throw new HttpError(400,'Invalid screenshot options');
    if(typeof quality!=='number'||quality<0.1||quality>1)throw new HttpError(400,'Invalid quality');
    const params={context:t.context,origin};if(format==='jpeg')params.format={type:'image/jpeg',quality};
    const result=await t.node.client.send('browsingContext.captureScreenshot',params);
    return {mimeType:format==='jpeg'?'image/jpeg':'image/png',base64:result.data};
  }
  async snapshot(t) {
    const expression=`JSON.stringify({title:document.title,url:location.href,text:(document.body?.innerText||'').slice(0,12000),elements:[...document.querySelectorAll('button,a,input,select,textarea,[role="button"]')].slice(0,180).map((e,i)=>({index:i,tag:e.tagName,role:e.getAttribute('role'),text:(e.innerText||e.getAttribute('aria-label')||'').slice(0,140),id:e.id,disabled:!!e.disabled}))})`;
    const result=await t.node.client.send('script.evaluate',{expression,target:{context:t.context},awaitPromise:false});
    if(result.type==='exception')throw new HttpError(502,'Page script exception');
    const value=result.result?.value;
    if(typeof value!=='string')throw new HttpError(502,'Unexpected snapshot result');
    return JSON.parse(value);
  }
  async click(t,{selector}={}) {
    if(typeof selector!=='string'||!selector||selector.length>600)throw new HttpError(400,'selector is required');
    return t.op.run(()=>t.node.input.run(async()=> {
      // Selector data is JSON encoded. Never use page DOM click() or synthetic dispatchEvent().
      await t.node.client.send('browsingContext.activate',{context:t.context});
      const exp=`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return JSON.stringify({error:'not_found'});e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),width:r.width,height:r.height})})()`;
      const result=await t.node.client.send('script.evaluate',{expression:exp,target:{context:t.context},awaitPromise:false});
      if(result.type==='exception')throw new HttpError(400,'Invalid selector');
      const rect=JSON.parse(result.result?.value||'{}');
      if(rect.error||!rect.width||!rect.height)throw new HttpError(404,'Element not found or not visible');
      await t.node.client.send('input.performActions',{context:t.context,actions:[{id:'mouse',type:'pointer',parameters:{pointerType:'mouse'},actions:[
        {type:'pointerMove',origin:'viewport',x:rect.x,y:rect.y,duration:0},{type:'pointerDown',button:0},{type:'pointerUp',button:0}
      ]}]});
      return {clicked:true,selector};
    }));
  }
  async type(t,{text}={}) {
    if(typeof text!=='string'||text.length>3000)throw new HttpError(400,'text required (max 3000 chars)');
    return t.op.run(()=>t.node.input.run(async()=> {
      await t.node.client.send('browsingContext.activate',{context:t.context});
      const actions=[...text].flatMap(c=>[{type:'keyDown',value:c},{type:'keyUp',value:c}]);
      await t.node.client.send('input.performActions',{context:t.context,actions:[{type:'key',id:'keyboard',actions}]});
      return {typed:text.length};
    }));
  }
  async scroll(t,{deltaY=450,deltaX=0}={}) {
    if(!Number.isInteger(deltaX)||!Number.isInteger(deltaY)||Math.abs(deltaX)>5000||Math.abs(deltaY)>5000)throw new HttpError(400,'Invalid scroll');
    return t.op.run(()=>t.node.input.run(async()=> {
      await t.node.client.send('browsingContext.activate',{context:t.context});
      await t.node.client.send('input.performActions',{context:t.context,actions:[{id:'wheel',type:'wheel',actions:[{type:'scroll',x:0,y:0,deltaX,deltaY,origin:'viewport'}]}]});
      return {scrolled:true};
    }));
  }
  async setCookies(t,{cookies}={}) {
    if(!Array.isArray(cookies)||cookies.length===0||cookies.length>100)throw new HttpError(400,'1–100 cookies required');
    const permitted=['name','value','domain','path','httpOnly','secure','sameSite','expiry'];
    return t.op.run(async()=> {
      let set=0;
      for(const incoming of cookies) {
        if(!incoming || typeof incoming!=='object'||Array.isArray(incoming))throw new HttpError(400,'Invalid cookie');
        if(Object.keys(incoming).some(k=>!permitted.includes(k))||typeof incoming.value!=='string'||typeof incoming.name!=='string'||typeof incoming.domain!=='string')throw new HttpError(400,'Invalid cookie fields');
        const cookie={...incoming,value:{type:'string',value:incoming.value}};
        await t.node.client.send('storage.setCookie',{cookie,partition:{type:'storageKey',userContext:t.userContext}});
        set++;
      }
      return {set}; // Never return cookie values
    });
  }
}
