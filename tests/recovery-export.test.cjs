const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync,readFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {Worker}=require('node:worker_threads');
const {Engine}=require('../server/engine.js');
const {createBackup}=require('../server/backup.js');
const M=require('../shared/simulation.js');
const input={name:'-1+1',position:{x:330,y:0},massKg:1000,speed:M.circularSpeed(330),directionDeg:90,dynamicsVersion:M.MODEL.dynamics.version,idempotencyKey:'consistent-launch'};
function setup(t){const dir=mkdtempSync(join(tmpdir(),'orbital-recovery-')),engines=[];let now=100000;const filename=join(dir,'orbital.sqlite');const make=(path=filename)=>{const e=new Engine({filename:path,now:()=>now});engines.push(e);return e;};t.after(()=>{engines.forEach(e=>e.close());rmSync(dir,{recursive:true,force:true});});return {dir,filename,make,setTime:n=>now=n};}
test('restart preserves committed state without simulating downtime and then resumes live time',t=>{
 const f=setup(t);let e=f.make();const u=e.guest().user.id,p=e.launch(u,input);e.advanceTo(240);e.checkpoint();e.advanceTo(480);
 e.db.close();e.closed=true;f.setTime(100000+30*86400000);e=f.make();assert.equal(e.get(u,p.id).state.tick,240);
 assert.equal(e.health().status,'running');assert.equal(e.health().lagSeconds,0);assert.equal(e.tick,240);
 for(let i=0;i<10;i++)e.advanceRealtime(.1);e.checkpoint();
 const expected=M.createState(M.validateLaunch(input),{continuousTracking:true});for(let i=0;i<480;i++)M.step(expected);
 assert.deepEqual(e.get(u,p.id).state,expected);const points=e.trajectory(u,p.id,{limit:5000}).points;assert.equal(new Set(points.map(p=>p.seq)).size,points.length);
});

test('runtime clock ignores long suspension, retains fractional ticks and never carries unprocessed backlog',t=>{
 const f=setup(t),e=f.make(),u=e.guest().user.id;e.launch(u,input);
 for(let i=0;i<4;i++)e.advanceRealtime(1/960);assert.equal(e.tick,1);
 e.advanceRealtime(30*86400);assert.equal(e.tick,25,'a long suspension advances at most 0.1 simulated seconds');
 e.advanceRealtime(.025,{budgetMs:0});assert.equal(e.tick,25);
 e.advanceRealtime(.025);assert.equal(e.tick,31,'discarded work must not be replayed on the next interval');
 for(const seconds of[NaN,Infinity,-1])e.advanceRealtime(seconds);assert.equal(e.tick,31);
});

test('new launches run immediately even when wall time is far ahead of the saved simulation',t=>{
 const f=setup(t),e=f.make(),u=e.guest().user.id;
 f.setTime(100000+30*86400000);const p=e.launch(u,input);
 assert.equal(p.status,'active');assert.equal(p.state.status,'active');assert.equal(p.birthTick,0);
 assert.equal(e.trajectory(u,p.id,{}).points[0].kind,'birth');assert.equal(e.health().lagSeconds,0);
});

test('legacy queued satellites start at the restored tick exactly once without rewriting older trajectories',t=>{
 const f=setup(t);let e=f.make();const u=e.guest().user.id,old=e.launch(u,input);e.advanceTo(240);e.checkpoint();
 const oldState=e.get(u,old.id).state,oldPoints=e.trajectory(u,old.id,{}).points;
 const pending=e.launch(u,{...input,idempotencyKey:'legacy-queued-launch'});e.close();
 const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(f.filename);
 const raw=JSON.parse(db.prepare('SELECT record FROM satellites WHERE id=?').get(pending.id).record);
 raw.status='queued';raw.state.status='queued';raw.birthTick=null;raw.seq=0;raw.eventSeq=0;raw.lastSample=null;delete raw.trajectoryBudget;
 db.exec('BEGIN');db.prepare('DELETE FROM points WHERE satellite_id=?').run(pending.id);db.prepare('DELETE FROM events WHERE satellite_id=?').run(pending.id);db.prepare('UPDATE satellites SET record=? WHERE id=?').run(JSON.stringify(raw),pending.id);db.exec('COMMIT');db.close();
 f.setTime(100000+30*86400000);e=f.make();
 const born=e.get(u,pending.id);assert.equal(born.status,'active');assert.equal(born.birthTick,240);assert.equal(born.state.fieldTick,240);
 assert.deepEqual(e.get(u,old.id).state,oldState);assert.deepEqual(e.trajectory(u,old.id,{}).points,oldPoints);
 assert.equal(e.trajectory(u,pending.id,{}).points.length,1);assert.equal(e.trajectory(u,pending.id,{}).points[0].kind,'birth');
 e.close();e=f.make();assert.equal(e.trajectory(u,pending.id,{}).points.length,1);
 assert.equal(e.db.prepare('SELECT COUNT(*) AS n FROM events WHERE satellite_id=?').get(pending.id).n,1);
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
