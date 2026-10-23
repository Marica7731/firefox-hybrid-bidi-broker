import test from 'node:test';
import assert from 'node:assert/strict';
import { BidiClient } from '../src/bidi.mjs';

class FakeWS extends EventTarget {
  constructor(){super();this.readyState=1;this.commands=[];queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
  send(data){const cmd=JSON.parse(data);this.commands.push(cmd);
    queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'success',id:cmd.id,result:cmd.method==='session.new'?{sessionId:'mock'}:{}})})));
  }
  close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
}

test('native BiDi connector uses session.new and single subscription',async()=>{
  const ws=new FakeWS();const client=new BidiClient('ws://127.0.0.1:9000/session',{wsFactory:()=>ws});
  await client.connect();assert.deepEqual(ws.commands.map(x=>x.method),['session.new','session.subscribe']);
  let seen='';client.onEvent(m=>{seen=m.method;});
  client.handleMessage(JSON.stringify({type:'event',method:'network.responseCompleted',params:{context:'abc'}}));
  assert.equal(seen,'network.responseCompleted');client.close();
});
test('rejects non-local debugging websocket',()=>{
  assert.throws(()=>new BidiClient('ws://192.0.2.1:9000/session'));
});
