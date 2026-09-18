const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {startServer}=require('../server/index.js');
const initial={name:'测试卫星',position:{x:330,y:0},massKg:1000,speed:97.3,directionDeg:90,modelVersion:'pw-2d-v1',idempotencyKey:'api-launch-00001'};
test('HTTP launch, ownership, CSRF, persistence, pagination, recovery and exports',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'orbital-api-'));let app=await startServer({port:0,dataDir:dir});
 t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
 async function request(path,{cookie,csrfToken,method='GET',body,origin}={}){
   const res=await fetch(app.url+path,{method,headers:{...(cookie?{cookie}:{}),...(csrfToken?{'X-CSRF-Token':csrfToken}:{}),...(body?{'Content-Type':'application/json'}:{}),...(origin?{Origin:origin}:{})},body:body?JSON.stringify(body):undefined});
   return {res,data:res.headers.get('content-type')?.includes('json')?await res.json():await res.text()};
 }
 const ga=await request('/api/session/guest',{method:'POST',body:{}}),a={cookie:ga.res.headers.get('set-cookie').split(';')[0],csrfToken:ga.data.csrfToken};
 assert.equal(ga.res.status,200);assert.ok(ga.data.recoveryKey);
 const gb=await request('/api/session/guest',{method:'POST',body:{}}),b={cookie:gb.res.headers.get('set-cookie').split(';')[0],csrfToken:gb.data.csrfToken};
 assert.equal((await request('/api/satellites',{...a,csrfToken:undefined,method:'POST',body:initial})).res.status,403);
 assert.equal((await request('/api/satellites',{...a,method:'POST',body:initial,origin:'https://untrusted.example'})).res.status,403);
 const created=await request('/api/satellites',{...a,method:'POST',body:initial});assert.equal(created.res.status,201);const id=created.data.satellite.id;
 assert.equal((await request('/api/satellites',{...a,method:'POST',body:initial})).data.satellite.id,id);
 assert.equal((await request('/api/satellites/'+id,b)).res.status,404);
 assert.equal((await request('/server/engine.js')).res.status,404);assert.equal((await request('/data/orbital.sqlite')).res.status,404);
 await new Promise(resolve=>setTimeout(resolve,1200));
 const before=(await request('/api/satellites/'+id,a)).data.satellite;
 assert.ok(before.state.tick>0,'runs without a browser connection');
 const history=(await request('/api/satellites/'+id+'/trajectory?limit=1',a)).data;assert.equal(history.points[0].kind,'birth');assert.ok(history.nextCursor);
 await app.close();app=await startServer({port:0,dataDir:dir});
 const after=(await request('/api/satellites/'+id,a)).data.satellite;assert.ok(after.state.tick>=before.state.tick);
 const ended=(await request('/api/satellites/'+id+'/terminate',{...a,method:'POST',body:{}})).data.satellite;assert.equal(ended.status,'terminated');
 for(const format of ['json','csv']){
  const r=await request('/api/satellites/'+id+'/exports',{...a,method:'POST',body:{format}});assert.equal(r.res.status,202);const eid=r.data.export.id;
  let info;for(let i=0;i<50;i++){info=(await request('/api/exports/'+eid,a)).data.export;if(info.status!=='pending')break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal(info.status,'ready',info.message);assert.ok(info.checksum);
  assert.equal((await request('/api/exports/'+eid+'/download',b)).res.status,404);
  const download=await request('/api/exports/'+eid+'/download',a);assert.equal(download.res.status,200);
  if(format==='json'){assert.equal(download.data.satellite.id,id);assert.equal(download.data.points[0].kind,'birth');assert.equal(download.data.points.at(-1).kind,'terminated');}
  else {assert.match(download.data,/elapsed_sim_seconds/);assert.match(download.data,/terminated/);}
 }
 const recovered=await request('/api/session/recover',{...b,method:'POST',body:{recoveryKey:ga.data.recoveryKey}});assert.equal(recovered.data.user.id,ga.data.user.id);
 const ownerOne=(await request('/api/satellites',{...a,method:'POST',body:{...initial,idempotencyKey:'sweep-owner-one'}})).data.satellite;
 const otherSession=await request('/api/session/guest',{method:'POST',body:{}}),otherAuth={cookie:otherSession.res.headers.get('set-cookie').split(';')[0],csrfToken:otherSession.data.csrfToken};
 const otherOne=(await request('/api/satellites',{...otherAuth,method:'POST',body:{...initial,idempotencyKey:'sweep-other-one'}})).data.satellite;
 assert.deepEqual((await request('/api/satellites/active',a)).data.satellites.map(s=>s.id),[ownerOne.id]);
 assert.equal((await request('/api/satellites/terminate-many',{...a,csrfToken:undefined,method:'POST',body:{ids:[ownerOne.id]}})).res.status,403);
 assert.equal((await request('/api/satellites/terminate-many',{...a,method:'POST',body:{ids:[ownerOne.id,otherOne.id]}})).res.status,404);
 assert.equal((await request('/api/satellites/'+ownerOne.id,a)).data.satellite.status,'active');
 const cleared=await request('/api/satellites/terminate-many',{...a,method:'POST',body:{ids:[ownerOne.id]}});assert.equal(cleared.res.status,200);assert.equal(cleared.data.satellites[0].status,'terminated');
 assert.equal((await request('/api/satellites/'+otherOne.id,otherAuth)).data.satellite.status,'active');
});
