const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {Engine}=require('../server/engine.js');
const M=require('../shared/simulation.js');
const U=require('../shared/units.js');
const launch={name:'far circle',position:{x:600,y:0},massKg:1000,speed:M.circularSpeed(600),directionDeg:90,modelVersion:M.MODEL.version,idempotencyKey:'optimized-orbit'};
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'orbital-optimized-')),file=join(dir,'orbital.sqlite'),engines=[];t.after(()=>{for(const e of engines)e.close();rmSync(dir,{recursive:true,force:true});});return {file,make(options={}){const e=new Engine({filename:file,now:()=>100000,velocityRelativeTolerance:0,...options});engines.push(e);return e;}};}
function checkReplay(raw,points,relative=0){let i=0;for(const p of raw){while(i+1<points.length&&points[i+1].elapsedSeconds<=p.elapsedSeconds)i++;const a=points[i],b=points[Math.min(i+1,points.length-1)],f=b.elapsedSeconds===a.elapsedSeconds?0:(p.elapsedSeconds-a.elapsedSeconds)/(b.elapsedSeconds-a.elapsedSeconds);assert.ok(Math.hypot(p.x-a.x-(b.x-a.x)*f,p.y-a.y-(b.y-a.y)*f)*U.SCALE.kmPerUnit<=.100000001);assert.ok(Math.hypot(p.vx-a.vx-(b.vx-a.vx)*f,p.vy-a.vy-(b.vy-a.vy)*f)*U.SCALE.kmSPerUnit<=Math.max(.1,Math.hypot(p.vx,p.vy)*U.SCALE.kmSPerUnit*relative)+1e-8);}}
test('far orbit retains bounded-error samples without changing any integration state',t=>{
 const f=fixture(t),e=f.make(),user=e.guest().user.id,p=e.launch(user,launch),expected=M.createState(M.validateLaunch(launch),{continuousTracking:true}),raw=[M.snapshot(expected)];
 for(let i=0;i<2400;i++){M.step(expected);raw.push(M.snapshot(expected));}e.advanceTo(2400);e.checkpoint();
 assert.deepEqual(e.get(user,p.id).state,expected);const points=e.trajectory(user,p.id,{limit:5000}).points;
 assert.ok(points.length<1200,`expected reduction from 2401 raw states; received ${points.length}`);assert.equal(points.at(-1).tick,2400);checkReplay(raw,points);
 assert.equal(e.get(user,p.id).sampling.version,'time-linear-error-v1');assert.equal(e.health().storage.rawSteps,2400);assert.ok(e.health().storage.checkpointMs>=0);
});
test('partial block checkpoint survives crash and export cutoff does not omit buffered trajectory',t=>{
 const f=fixture(t);let e=f.make(),user=e.guest().user.id,p=e.launch(user,launch);e.advanceTo(317);e.checkpoint();const before=e.get(user,p.id).state;
 // Abrupt database close intentionally bypasses Engine.close/checkpoint.
 e.advanceTo(351);e.db.close();e.closed=true;e=f.make();assert.deepEqual(e.get(user,p.id).state,before);
 e.advanceTo(389);const job=e.prepareExport(user,p.id,'json');const points=e.trajectory(user,p.id,{limit:5000,cutoffSeq:job.cutoffSeq}).points;
 assert.equal(points.at(-1).tick,389);assert.equal(points.at(-1).kind,'cutoff');assert.equal(job.cutoffSeq,points.at(-1).seq);
 assert.equal(new Set(points.map(p=>p.seq)).size,points.length);assert.equal(e.get(user,p.id).state.tick,389);
});
test('capture and same-tick termination preserve ordered lifecycle records',t=>{
 const f=fixture(t),e=f.make(),user=e.guest().user.id,p=e.launch(user,{...launch,position:{x:100,y:0},speed:0,idempotencyKey:'optimized-capture'});e.advanceTo(1000);const r=e.get(user,p.id),points=e.trajectory(user,p.id,{limit:5000}).points;
 assert.equal(r.status,'captured');assert.equal(points.at(-1).kind,'captured');assert.equal(points.at(-1).elapsedSeconds,r.state.elapsedSeconds);
 const q=e.launch(user,{...launch,idempotencyKey:'same-tick-end'});e.terminate(user,q.id);const end=e.trajectory(user,q.id,{limit:5000}).points;
 assert.deepEqual(end.map(p=>p.kind),['birth','terminated']);assert.equal(end[0].tick,end[1].tick);
});
test('time-window queries pin sequence cutoff and include neighboring interpolation points',t=>{
 const f=fixture(t),e=f.make(),user=e.guest().user.id,p=e.launch(user,launch);e.advanceTo(1000);e.checkpoint();
 const page=e.trajectory(user,p.id,{fromTick:321,toTick:679,boundaries:'1',limit:5000});assert.ok(page.points[0].tick<=321);assert.ok(page.points.at(-1).tick>=679);assert.ok(page.cutoffSeq);
 e.advanceTo(1500);const frozen=e.trajectory(user,p.id,{cutoffSeq:page.cutoffSeq,limit:5000});assert.ok(frozen.points.every(p=>p.seq<=page.cutoffSeq));
});
test('legacy records append a disclosed transition and retain every original historical row',t=>{
 const f=fixture(t);let e=f.make(),user=e.guest().user.id,p=e.launch(user,launch);e.advanceTo(317);e.checkpoint();const original=e.db.prepare('SELECT * FROM points WHERE satellite_id=? ORDER BY seq').all(p.id);
 const stored=JSON.parse(e.db.prepare('SELECT record FROM satellites WHERE id=?').get(p.id).record);delete stored.sampling;e.db.prepare('UPDATE satellites SET record=? WHERE id=?').run(JSON.stringify(stored),p.id);e.db.close();e.closed=true;
 e=f.make();assert.equal(e.get(user,p.id).sampling.legacyThroughSeq,stored.seq);assert.deepEqual(e.db.prepare('SELECT * FROM points WHERE satellite_id=? AND seq<=? ORDER BY seq').all(p.id,stored.seq),original);
 e.advanceTo(600);e.checkpoint();assert.equal(e.get(user,p.id).state.tick,600);assert.equal(e.trajectory(user,p.id,{limit:5000}).points.at(-1).tick,600);
});
test('balanced velocity policy reduces inner writes and remains pinned across configuration changes',t=>{
 const f=fixture(t);let e=f.make({velocityRelativeTolerance:.001}),user=e.guest().user.id;
 const input={...launch,position:{x:220,y:0},speed:M.circularSpeed(220),idempotencyKey:'balanced-pinned'};
 const p=e.launch(user,input);assert.equal(p.sampling.velocityRelativeTolerance,.001);
 const state=M.createState(M.validateLaunch(input),{continuousTracking:true}),raw=[M.snapshot(state)];for(let i=0;i<480;i++){M.step(state);raw.push(M.snapshot(state));}e.advanceTo(480);e.checkpoint();
 const points=e.trajectory(user,p.id,{limit:5000}).points;assert.ok(points.length<100);checkReplay(raw,points,.001);assert.deepEqual(e.get(user,p.id).state,state);
 e.close();e=f.make({velocityRelativeTolerance:0});assert.equal(e.get(user,p.id).sampling.velocityRelativeTolerance,.001);e.advanceTo(720);e.checkpoint();
 const strict=e.launch(user,{...input,idempotencyKey:'strict-pinned'});assert.equal(strict.sampling.velocityRelativeTolerance,0);e.advanceTo(960);assert.ok(e.trajectory(user,strict.id,{limit:5000}).points.length>=240);
});
