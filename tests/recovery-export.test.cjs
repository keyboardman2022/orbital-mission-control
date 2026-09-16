const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync,readFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {Worker}=require('node:worker_threads');
const {Engine}=require('../server/engine.js');
const {createBackup}=require('../server/backup.js');
const M=require('../shared/simulation.js');
const input={name:'-1+1',position:{x:330,y:0},massKg:1000,speed:M.circularSpeed(330),directionDeg:90,idempotencyKey:'consistent-launch'};
function setup(t){const dir=mkdtempSync(join(tmpdir(),'orbital-recovery-')),engines=[];let now=100000;const filename=join(dir,'orbital.sqlite');const make=(path=filename)=>{const e=new Engine({filename:path,now:()=>now});engines.push(e);return e;};t.after(()=>{engines.forEach(e=>e.close());rmSync(dir,{recursive:true,force:true});});return {dir,filename,make,setTime:n=>now=n};}
test('crash rolls back only uncommitted progress then deterministically catches up',t=>{
 const f=setup(t);let e=f.make();const u=e.guest().user.id,p=e.launch(u,input);e.advanceTo(240);e.checkpoint();e.advanceTo(480);
 e.db.close();e.closed=true;f.setTime(104000);e=f.make();assert.equal(e.get(u,p.id).state.tick,240);e.advanceTo(e.targetTick());e.checkpoint();
 const expected=M.createState(M.validateLaunch(input),{continuousTracking:true});for(let i=0;i<960;i++)M.step(expected);
 assert.deepEqual(e.get(u,p.id).state,expected);const points=e.trajectory(u,p.id,{limit:5000}).points;assert.equal(new Set(points.map(p=>p.seq)).size,points.length);
});
test('rollback detection survives repeated erroneous restarts',t=>{
 const f=setup(t);let e=f.make();e.close();f.setTime(97000);e=f.make();assert.equal(e.health().status,'clock_error');e.close();
 e=f.make();assert.equal(e.health().status,'clock_error');e.close();f.setTime(100000);e=f.make();assert.equal(e.health().status,'running');
});
test('export cutoff excludes later same-tick termination and CSV protects text cells',async t=>{
 const f=setup(t),e=f.make(),u=e.guest().user.id,p=e.launch(u,input);e.advanceTo(120);
 const json=e.prepareExport(u,p.id,'json'),csv=e.prepareExport(u,p.id,'csv');e.terminate(u,p.id);
 for(const record of [json,csv]){
  const target=join(f.dir,record.id+'.'+record.format),worker=new Worker(join(__dirname,'../server/export-worker.js'),{workerData:{filename:f.filename,target,record}});
  const result=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});await new Promise(resolve=>worker.once('exit',resolve));
  assert.equal(result.status,'ready');const text=readFileSync(target,'utf8');
  if(record.format==='json'){const data=JSON.parse(text);assert.equal(data.satellite.status,'active');assert.ok(data.points.every(p=>p.kind!=='terminated'));assert.ok(data.integration.method);
   for(const p of data.points){assert.equal(p.speed,Math.hypot(p.vx,p.vy));assert.ok(Number.isFinite(p.speedKmS));}assert.equal(data.calibration.centralMassSolar,10);}
  else {assert.match(text,/"'-1\+1"/);assert.match(text,/speed_km_s/);assert.match(text,/physical_speed_valid/);}
 }
});
test('online consistent backup can restore satellite state and archive',async t=>{
 const f=setup(t),e=f.make(),u=e.guest().user.id,p=e.launch(u,input);e.advanceTo(480);e.checkpoint();
 const path=await createBackup({source:f.filename,destination:join(f.dir,'backup.sqlite')});const restored=f.make(path);
 assert.deepEqual(restored.get(u,p.id),e.get(u,p.id));assert.deepEqual(restored.trajectory(u,p.id,{}),e.trajectory(u,p.id,{}));
});
test('active admission limit is explicit and does not erase existing satellites',t=>{
 const f=setup(t),e=f.make();e.maxActive=1;const u=e.guest().user.id,p=e.launch(u,input);
 assert.throws(()=>e.launch(u,{...input,idempotencyKey:'new-over-capacity'}),{status:503});e.advanceTo(50);assert.equal(e.get(u,p.id).state.tick,50);
 e.terminate(u,p.id);assert.ok(e.launch(u,{...input,idempotencyKey:'new-over-capacity'}).id);
});
