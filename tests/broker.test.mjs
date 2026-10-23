import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserBroker, HttpError } from '../src/broker.mjs';
import { serve } from '../src/server.mjs';
import { validate } from '../src/config.mjs';

const cfg={listen:'127.0.0.1',port:8765,leaseSeconds:120,leaseMaxSeconds:3600,eventLimit:5,
  browsers:[{id:'one',wsUrl:'ws://127.0.0.1:9222/session',mode:'dedicated',capacity:1},
    {id:'two',wsUrl:'ws://127.0.0.1:9223/session',mode:'dedicated',capacity:1},
    {id:'compact',wsUrl:'ws://127.0.0.1:9224/session',mode:'shared',capacity:4}]};
class FakeClient {
  constructor(url){this.url=url;this.methods=[];this.seq=0;this.handlers=[];this.connected=false;this.delay=0;this.active=0;this.maxActive=0;}
  onEvent(fn){this.handlers.push(fn);}
  async connect(){this.connected=true;}
  async send(method,params){
    this.methods.push({method,params});
    if(method==='browser.createUserContext')return {userContext:`uc-${++this.seq}`};
    if(method==='browsingContext.create')return {context:`ctx-${this.seq}`};
    if(method==='browsingContext.captureScreenshot')return {data:'AAA'};
    if(method==='script.evaluate')return {type:'success',result:{type:'string',value:JSON.stringify({x:10,y:10,width:20,height:20})}};
    if(method==='input.performActions'){this.active++;this.maxActive=Math.max(this.maxActive,this.active);await new Promise(r=>setTimeout(r,20));this.active--;}
    return {};
  }
  emit(evt){this.handlers.forEach(f=>f(evt));}
  close(){this.connected=false;}
}
const fixture=async()=>{let now=1000;const nodes=new Map();const broker=new BrowserBroker(cfg,{clientFactory:url=>{const client=new FakeClient(url);nodes.set(url,client);return client;},now:()=>now});await broker.start();return {broker,nodes,setNow:n=>now=n};};

test('config checks mode/capacity and loopback',()=> {validate(cfg);assert.throws(()=>validate({...cfg,listen:'0.0.0.0'}));});
test('dedicated instances can allocate independent tasks',async()=>{
 const {broker}=await fixture();const a=await broker.create({mode:'dedicated'}),b=await broker.create({mode:'dedicated'});
 assert.notEqual(a.browserId,b.browserId);await assert.rejects(()=>broker.create({mode:'dedicated'}),{status:503});await broker.close();
});
test('shared user contexts isolate each task and tokens',async()=>{
 const {broker}=await fixture();const a=await broker.create({mode:'shared'}),b=await broker.create({mode:'shared'});
 assert.equal(a.browserId,b.browserId);assert.notEqual(a.userContext,b.userContext);assert.notEqual(a.token,b.token);
 assert.throws(()=>broker.get(a.id,b.token),{status:403});await broker.close();
});
test('input serialized within instance and concurrent across instances',async()=>{
 const {broker,nodes}=await fixture();const a=await broker.create({mode:'shared'}),b=await broker.create({mode:'shared'});
 await Promise.all([broker.click(broker.get(a.id,a.token),{selector:'button'}),broker.click(broker.get(b.id,b.token),{selector:'button'})]);
 assert.equal(nodes.get('ws://127.0.0.1:9224/session').maxActive,1);
 const c=await broker.create({mode:'dedicated'}),d=await broker.create({mode:'dedicated'});
 await Promise.all([broker.click(broker.get(c.id,c.token),{selector:'button'}),broker.click(broker.get(d.id,d.token),{selector:'button'})]);
 assert.equal(nodes.get('ws://127.0.0.1:9222/session').maxActive,1);
 assert.equal(nodes.get('ws://127.0.0.1:9223/session').maxActive,1);await broker.close();
});
test('cookie injection uses userContext and never returns credentials',async()=>{
 const {broker,nodes}=await fixture();const t=await broker.create({mode:'shared'});
 const result=await broker.setCookies(broker.get(t.id,t.token),{cookies:[{name:'example',value:'not-for-logs',domain:'example.com'}]});
 assert.deepEqual(result,{set:1});const arg=nodes.get('ws://127.0.0.1:9224/session').methods.find(x=>x.method==='storage.setCookie').params;
 assert.equal(arg.partition.userContext,t.userContext); assert.equal(arg.cookie.value.value,'not-for-logs');await broker.close();
});
test('events are task scoped and only contain sanitized origin',async()=>{
 const {broker,nodes}=await fixture();const a=await broker.create({mode:'shared'}),b=await broker.create({mode:'shared'});
 nodes.get('ws://127.0.0.1:9224/session').emit({type:'event',method:'network.beforeRequestSent',params:{context:a.context,request:{method:'GET',url:'https://example.org/path?token=sensitive',headers:[{name:'Cookie',value:'secret'}]}}});
 assert.equal(broker.events(broker.get(a.id,a.token)).length,1);assert.equal(broker.events(broker.get(b.id,b.token)).length,0);
 assert.equal(broker.events(broker.get(a.id,a.token))[0].origin,'https://example.org');await broker.close();
});
test('lease expires and capacity is recovered',async()=>{
 const {broker,setNow}=await fixture();const a=await broker.create({mode:'shared',leaseSeconds:60});setNow(61001);await broker.reap();
 assert.equal(broker.stats().find(x=>x.id==='compact').allocations,0);assert.throws(()=>broker.get(a.id,a.token),{status:403});await broker.close();
});
test('HTTP admin and task token separation',async()=>{
 const {broker}=await fixture();const server=serve(broker,'a'.repeat(32));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const forbidden=await fetch(base+'/v1/browsers');assert.equal(forbidden.status,403);
 const created=await fetch(base+'/v1/tasks',{method:'POST',headers:{authorization:`Bearer ${'a'.repeat(32)}`,'content-type':'application/json'},body:JSON.stringify({mode:'shared'})});
 assert.equal(created.status,201);const task=await created.json();
 const r=await fetch(base+`/v1/tasks/${task.id}`,{headers:{authorization:`Bearer ${task.token}`}});assert.equal(r.status,200);
 const denied=await fetch(base+`/v1/tasks/${task.id}`,{headers:{authorization:`Bearer ${'a'.repeat(32)}`}});assert.equal(denied.status,403);
 await new Promise(r=>server.close(r));await broker.close();
});
