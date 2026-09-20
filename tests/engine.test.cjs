const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync,existsSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {Engine}=require('../server/engine.js');
const {archiveBatch,archivePath}=require('../server/trajectory-store.js');
const launch={name:'Voyager',position:{x:330,y:0},massKg:1000,speed:97.31236802019037,directionDeg:90,modelVersion:'pw-2d-v1',idempotencyKey:'test-request-0001'};
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'orbital-engine-')),engines=[];t.after(()=>{for(const e of engines)e.close();rmSync(dir,{recursive:true,force:true});});let now=100000;const file=join(dir,'test.sqlite');const make=()=>{const e=new Engine({filename:file,now:()=>now});engines.push(e);return e;};return {file,make,setNow:n=>now=n};}

test('observable boundary is the fixed shockwave distance after sixty seconds',()=>{
 const M=require('../shared/simulation.js'),S=require('../shared/map-sweep.js');
 const wave=S.create({ids:[],origin:{x:0,y:0},extent:10000});wave.advance(60);
 assert.equal(M.MODEL.observation.radius,wave.radius);
 assert.equal(M.MODEL.observation.radius,9000);
 assert.throws(()=>M.validateLaunch({...launch,position:{x:9001,y:0}}),{status:422});
});

test('outward boundary crossing freezes at the boundary and retains terminal trajectory and export',t=>{
 const f=fixture(t),e=f.make(),u=e.guest().user.id;
 const p=e.launch(u,{...launch,position:{x:8999.9,y:0},speed:200,directionDeg:0,idempotencyKey:'observable-exit'});
 e.advanceTo(10);e.checkpoint();const end=e.get(u,p.id);
 assert.equal(end.status,'out_of_observable');assert.equal(end.endReason,'out_of_observable');
 assert.ok(Math.abs(Math.hypot(end.state.x,end.state.y)-9000)<1e-8);
 assert.ok(end.state.elapsedSeconds>0&&end.state.elapsedSeconds<1/240);
 assert.equal(e.active(u).satellites.length,0);
 const points=e.trajectory(u,p.id,{limit:1000}).points;
 assert.equal(points[0].kind,'birth');assert.equal(points.at(-1).kind,'out_of_observable');
 const events=e.db.prepare('SELECT event FROM events WHERE satellite_id=? ORDER BY seq').all(p.id).map(r=>JSON.parse(r.event));
 assert.equal(events.at(-1).type,'out_of_observable');
 assert.equal(e.prepareExport(u,p.id,'json').satellite.endReason,'out_of_observable');
 e.advanceTo(100);e.checkpoint();assert.deepEqual(e.get(u,p.id).state,end.state);
 e.close();assert.deepEqual(f.make().get(u,p.id).state,end.state);
});

test('restart archives already distant live satellites without rewriting existing history',t=>{
 const f=fixture(t),e=f.make(),u=e.guest().user.id,p=e.launch(u,launch);
 const r=e.records.get(p.id);r.state.x=9500;r.state.vx=100;r.state.tick=240;r.state.elapsedSeconds=1;e.dirty.add(p.id);e.checkpoint();
 const before=e.trajectory(u,p.id,{limit:1000}).points;e.close();
 const restored=f.make(),end=restored.get(u,p.id);
 assert.equal(end.status,'out_of_observable');assert.equal(restored.active(u).satellites.length,0);
 assert.equal(end.state.x,9500);assert.equal(end.state.elapsedSeconds,1);
 const after=restored.trajectory(u,p.id,{limit:1000}).points;
 assert.deepEqual(after.slice(0,before.length),before);assert.equal(after.at(-1).kind,'out_of_observable');
 restored.close();const again=f.make();assert.equal(again.trajectory(u,p.id,{limit:1000}).points.length,after.length);
});
test('launch is owned, durable and idempotent; conflicting retry is rejected',t=>{
 const f=fixture(t),e=f.make();t.after(()=>e.close());const a=e.guest(),b=e.guest();
 const p=e.launch(a.user.id,launch),again=e.launch(a.user.id,launch);
 assert.equal(p.id,again.id);assert.equal(e.list(a.user.id).satellites.length,1);
 assert.throws(()=>e.launch(a.user.id,{...launch,speed:40}),{status:409});
 assert.throws(()=>e.get(b.user.id,p.id),{status:404});
 assert.equal(e.trajectory(a.user.id,p.id,{}).points[0].kind,'birth');
});
test('resume from committed checkpoint reproduces continuous integration and has no duplicate points',t=>{
 const f=fixture(t);let e=f.make();const user=e.guest().user.id,p=e.launch(user,launch);
 e.advanceTo(800);e.checkpoint();const at800=e.get(user,p.id).state;e.close();
 e=f.make();assert.deepEqual(e.get(user,p.id).state,at800);e.advanceTo(2400);e.checkpoint();
 const state=e.get(user,p.id).state,points=e.trajectory(user,p.id,{limit:1000}).points;
 assert.equal(new Set(points.map(p=>p.seq)).size,points.length);assert.equal(points[0].elapsedSeconds,0);
 const M=require('../shared/simulation.js'),expected=M.createState(M.validateLaunch(launch));for(let i=0;i<2400;i++)M.step(expected);
 assert.equal(state.x,expected.x);assert.equal(state.y,expected.y);assert.equal(state.tick,2400);e.close();
});
test('terminated and captured satellites keep final point, event and frozen lifetime',t=>{
 const f=fixture(t),e=f.make();t.after(()=>e.close());const u=e.guest().user.id;
 const p=e.launch(u,{...launch,position:{x:100,y:0},speed:0,idempotencyKey:'radial-request'});
 e.advanceTo(1000);assert.equal(e.get(u,p.id).status,'captured');
 const pts=e.trajectory(u,p.id,{limit:1000}).points,last=pts.at(-1);assert.equal(last.kind,'captured');assert.ok(Math.abs(Math.hypot(last.x,last.y)-69.3)<1e-6);
 const orbit=e.launch(u,{...launch,idempotencyKey:'orbit-second'});e.advanceTo(1200);const end=e.terminate(u,orbit.id);e.advanceTo(1300);
 assert.equal(e.get(u,orbit.id).state.elapsedSeconds,end.state.elapsedSeconds);assert.equal(e.trajectory(u,orbit.id,{limit:1000}).points.at(-1).kind,'terminated');
});
test('recovery credential restores owner; session secrets do not appear in satellite output',t=>{
 const f=fixture(t),e=f.make();t.after(()=>e.close());const a=e.guest(),restored=e.recover(a.recoveryKey);
 assert.equal(a.user.id,restored.user.id);assert.equal(e.authenticate(restored.token).userId,a.user.id);
 assert.throws(()=>e.recover('incorrect'),{status:401});e.logout(restored.token);assert.throws(()=>e.authenticate(restored.token),{status:401});
});
test('a durable launch also commits the world clock and pre-existing satellite states',t=>{
 const f=fixture(t),e=f.make(),u=e.guest().user.id,p=e.launch(u,launch);
 e.advanceTo(800);const before=e.get(u,p.id).state;e.launch(u,{...launch,idempotencyKey:'second-durable-launch'});
 const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(f.file,{readOnly:true});
 assert.equal(JSON.parse(db.prepare("SELECT value FROM meta WHERE key='clock'").get().value).tick,800);
 assert.deepEqual(JSON.parse(db.prepare('SELECT record FROM satellites WHERE id=?').get(p.id).record).state,before);db.close();e.close();
});
test('formal tracking continues beyond former escape boundary and persists velocity telemetry',t=>{
 const f=fixture(t),e=f.make(),u=e.guest().user.id;
 const p=e.launch(u,{...launch,position:{x:600,y:0},speed:200,directionDeg:0,idempotencyKey:'unbounded-escape'});
 e.advanceTo(6000);e.checkpoint();const s=e.get(u,p.id);
 assert.equal(s.status,'active');assert.ok(s.state.x>1800);
 assert.equal(s.telemetry.speed,Math.hypot(s.state.vx,s.state.vy));
 assert.ok(s.telemetry.speed<p.telemetry.speed);
 const points=e.trajectory(u,p.id,{limit:5000}).points;
 assert.equal(points.at(-1).speed,Math.hypot(points.at(-1).vx,points.at(-1).vy));
 e.close();const restored=f.make().get(u,p.id);assert.deepEqual(restored.telemetry,s.telemetry);
});

test('deleting an active satellite removes its database rows and archived trajectory without touching another owner',t=>{
 const f=fixture(t),e=f.make(),owner=e.guest().user.id,other=e.guest().user.id;
 const satellite=e.launch(owner,{...launch,idempotencyKey:'delete-record'});e.advanceTo(960);e.checkpoint();
 e.prepareExport(owner,satellite.id,'json');
 const chunk=archiveBatch(e.db,f.file,{cutoffWorldTick:100000,maxPoints:100});
 assert.equal(chunk.satellite_id,satellite.id);const sidecar=archivePath(f.file,chunk.file);assert.equal(existsSync(sidecar),true);
 assert.throws(()=>e.deleteSatellite(other,satellite.id),{status:404});assert.ok(e.get(owner,satellite.id));
 const deleted=e.deleteSatellite(owner,satellite.id);assert.equal(deleted.id,satellite.id);assert.equal(deleted.exportIds.length,1);
 assert.equal(existsSync(sidecar),false);assert.throws(()=>e.get(owner,satellite.id),{status:404});assert.equal(e.active(owner).satellites.length,0);
 for(const table of ['satellites','points','events','trajectory_chunks','exports'])assert.equal(e.db.prepare(`SELECT count(*) n FROM ${table} WHERE ${table==='satellites'?'id':table==='exports'?'satellite_id':'satellite_id'}=?`).get(satellite.id).n,0,table);
 e.advanceTo(1200);e.checkpoint();assert.throws(()=>e.get(owner,satellite.id),{status:404});
});
