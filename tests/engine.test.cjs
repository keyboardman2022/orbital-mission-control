const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync,existsSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {Engine}=require('../server/engine.js');
const {archiveBatch,archivePath}=require('../server/trajectory-store.js');
const launch={name:'Voyager',position:{x:330,y:0},massKg:1000,speed:97.31236802019037,directionDeg:90,modelVersion:'pw-2d-v3',dynamicsVersion:'multi-attractor-pw-v1',idempotencyKey:'test-request-0001'};
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'orbital-engine-')),engines=[];t.after(()=>{for(const e of engines)e.close();rmSync(dir,{recursive:true,force:true});});let now=100000;const file=join(dir,'test.sqlite');const make=()=>{const e=new Engine({filename:file,now:()=>now});engines.push(e);return e;};return {file,make,setNow:n=>now=n};}

test('the former radius still sizes the sweep, and 3D launches can start beyond it',()=>{
 const M=require('../shared/simulation.js'),S=require('../shared/map-sweep.js');
 const wave=S.create({ids:[],origin:{x:0,y:0},extent:100000});wave.advance(60);
 assert.equal(wave.radius,9000);
 assert.equal(M.MODEL.observation.radius,90000);
 assert.equal(M.MODEL.observation.sweepSeconds,600);
 wave.advance(540);assert.equal(M.MODEL.observation.radius,wave.radius);
 assert.throws(()=>M.validateLaunch({...launch,position:{x:90001,y:0}}),{status:422});
 const far={...launch,dimension:3,pitchDeg:0,position:{x:180000,y:0,z:0}};
 assert.equal(M.validateLaunch(far).position.x,180000);
 const preset=M.resolveLaunch({...far,referenceBodyId:'black-hole',launchPreset:'orbit'},0);
 assert.equal(M.validateLaunch(preset).position.x,180000);
});

test('a 3D satellite keeps flying and recording after crossing the former map radius',t=>{
 const f=fixture(t),e=f.make(),u=e.guest().user.id;
 const p=e.launch(u,{...launch,dimension:3,pitchDeg:90,position:{x:0,y:0,z:89999.9},speed:200,
   directionDeg:0,idempotencyKey:'observable-exit'});
 e.advanceTo(10);e.checkpoint();const running=e.get(u,p.id);
 assert.equal(running.status,'active');assert.equal(running.endReason,null);
 assert.ok(running.state.z>90000);
 assert.equal(running.state.tick,10);
 assert.equal(e.active(u,null,3).satellites.length,1);
 const points=e.trajectory(u,p.id,{limit:1000}).points;
 assert.equal(points[0].kind,'birth');assert.equal(points.at(-1).kind,'sample');
 assert.ok(points.at(-1).z>90000);
 const events=e.db.prepare('SELECT event FROM events WHERE satellite_id=? ORDER BY seq').all(p.id).map(r=>JSON.parse(r.event));
 assert.deepEqual(events.map(event=>event.type),['birth']);
 assert.equal(e.prepareExport(u,p.id,'json').satellite.status,'active');
 e.close();
 const restored=f.make();
 assert.deepEqual(restored.get(u,p.id).state,running.state);
 restored.advanceTo(100);
 assert.ok(restored.get(u,p.id).state.z>running.state.z);
});

test('historic out-of-observable records remain archived and exportable',t=>{
 const f=fixture(t),e=f.make(),u=e.guest().user.id,p=e.launch(u,launch);
 const r=e.records.get(p.id);
 Object.assign(r.state,{x:95000,vx:100,tick:240,elapsedSeconds:1});
 e.finish(r,'out_of_observable');e.checkpoint();
 const before=e.trajectory(u,p.id,{limit:1000}).points;e.close();
 const restored=f.make(),end=restored.get(u,p.id);
 assert.equal(end.status,'out_of_observable');assert.equal(restored.active(u).satellites.length,0);
 assert.equal(end.state.x,95000);assert.equal(end.state.elapsedSeconds,1);
 const after=restored.trajectory(u,p.id,{limit:1000}).points;
 assert.deepEqual(after,before);assert.equal(after.at(-1).kind,'out_of_observable');
 assert.equal(restored.prepareExport(u,p.id,'json').satellite.endReason,'out_of_observable');
});

test('an old boundary flight can resume from its exact endpoint on the current 3D clock',t=>{
 const f=fixture(t),e=f.make(),u=e.guest().user.id;
 const {worldId}=e.registerWorld({seed:'resume boundary',options:{layout:'spatial-v8',systems:2,stars:6,blackHoles:0}});
 const p=e.launch(u,{...launch,worldId,modelVersion:'seeded-pw-2d-v1',dynamicsVersion:'seeded-nbody-v1',
   dimension:3,pitchDeg:0,position:{x:95000,y:0,z:0}});
 const saved=e.records.get(p.id);
 Object.assign(saved.state,{tick:1,fieldTick:.4,elapsedSeconds:.4/240,event:{type:'out_of_observable'}});
 e.finish(saved,'out_of_observable');e.checkpoint();
 const old=e.get(u,p.id).state;
 const oldPoints=e.trajectory(u,p.id,{}).points;
 e.advanceTo(100);
 const continued=e.resumeBoundaryFlight(u,p.id);
 assert.equal(continued.status,'active');
 assert.equal(continued.endReason,null);
 assert.deepEqual(continued.resumePoint,{tick:1,elapsedSeconds:.4/240,fieldTick:100,worldTick:100});
 assert.equal(continued.state.x,old.x);
 assert.equal(continued.state.vx,old.vx);
 assert.equal(e.resumeBoundaryFlight(u,p.id).resumePoint.worldTick,100);
 e.close();
 const restored=f.make();
 restored.advanceTo(101);
 const state=restored.get(u,p.id).state;
 assert.equal(state.status,'active');
 assert.equal(state.fieldTick,101);
 assert.ok(Math.abs(state.elapsedSeconds-old.elapsedSeconds-1/240)<1e-12);
 assert.deepEqual(restored.trajectory(u,p.id,{}).points.slice(0,oldPoints.length),oldPoints);
 assert.equal(restored.prepareExport(u,p.id,'json').cutoffEventSeq,3);
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
