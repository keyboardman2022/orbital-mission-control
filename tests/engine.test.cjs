const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {Engine}=require('../server/engine.js');
const launch={name:'Voyager',position:{x:330,y:0},massKg:1000,speed:97.31236802019037,directionDeg:90,modelVersion:'pw-2d-v1',idempotencyKey:'test-request-0001'};
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'orbital-engine-')),engines=[];t.after(()=>{for(const e of engines)e.close();rmSync(dir,{recursive:true,force:true});});let now=100000;const file=join(dir,'test.sqlite');const make=()=>{const e=new Engine({filename:file,now:()=>now});engines.push(e);return e;};return {file,make,setNow:n=>now=n};}
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
 e.advanceTo(12000);e.checkpoint();const s=e.get(u,p.id);
 assert.equal(s.status,'active');assert.ok(s.state.x>1800);
 assert.equal(s.telemetry.speed,Math.hypot(s.state.vx,s.state.vy));
 assert.ok(s.telemetry.speed<p.telemetry.speed);
 const points=e.trajectory(u,p.id,{limit:5000}).points;
 assert.equal(points.at(-1).speed,Math.hypot(points.at(-1).vx,points.at(-1).vy));
 e.close();const restored=f.make().get(u,p.id);assert.deepEqual(restored.telemetry,s.telemetry);
});
