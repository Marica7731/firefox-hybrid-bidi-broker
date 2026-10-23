import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadConfig(path=process.env.BROKER_CONFIG||'config.local.json') {
  const data=JSON.parse(readFileSync(resolve(path),'utf8'));
  validate(data);
  return data;
}
export function validate(c) {
  if(c.listen!=='127.0.0.1')throw new Error('Broker must listen on 127.0.0.1');
  if(!Number.isInteger(c.port)||c.port<1||c.port>65535)throw new Error('Invalid broker port');
  if(!Number.isInteger(c.leaseSeconds)||c.leaseSeconds<30)throw new Error('Invalid default lease');
  if(!Number.isInteger(c.leaseMaxSeconds)||c.leaseMaxSeconds<c.leaseSeconds)throw new Error('Invalid max lease');
  if(!Number.isInteger(c.eventLimit)||c.eventLimit<1||c.eventLimit>1000)throw new Error('Invalid eventLimit');
  if(!Array.isArray(c.browsers)||c.browsers.length<1)throw new Error('At least one Firefox entry is required');
  const ids=new Set(), urls=new Set();
  for(const b of c.browsers) {
    if(typeof b.id!=='string'||!b.id.match(/^[a-zA-Z0-9_-]{1,40}$/)||ids.has(b.id))throw new Error('Browser ID missing or duplicate');
    if(!['dedicated','shared'].includes(b.mode))throw new Error('Invalid browser mode');
    if(!/^ws:\/\/127\.0\.0\.1:\d+\/session$/.test(b.wsUrl)||urls.has(b.wsUrl))throw new Error('Browser WS URL must be unique and loopback');
    if(!Number.isInteger(b.capacity)||b.capacity<1||b.capacity>16||b.mode==='dedicated'&&b.capacity!==1)throw new Error('Invalid capacity');
    ids.add(b.id);urls.add(b.wsUrl);
  }
}
