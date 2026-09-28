const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const M=require('../shared/simulation.js');
const {Engine}=require('../server/engine.js');

const launch=(extra={})=>({
  name:'星际探针',position:{x:600,y:0},massKg:1000,speed:0,directionDeg:0,
  dynamicsVersion:M.MODEL.dynamics.version,...extra
});

test('four prescribed stars keep their circular black-hole orbits on the shared world clock',()=>{
  assert.equal(M.MODEL.stars.length,4);
  const start=M.stellarBodiesAtTick(0);
  for(const star of start){
    assert.ok(Math.abs(Math.hypot(star.x,star.y)-star.orbitRadius)<1e-10);
    const quarter=M.stellarBodiesAtTick(star.periodTicks/4).find(candidate=>candidate.id===star.id);
    assert.ok(Math.abs(quarter.x+star.y)<1e-8);
    assert.ok(Math.abs(quarter.y-star.x)<1e-8);
  }
});

test('multi-attractor acceleration adds stellar gravity without moving the prescribed stars',()=>{
  const before=M.stellarBodiesAtTick(0);
  const blackHole=M.acceleration(600,0,M.MODEL.mu);
  const combined=M.fieldAcceleration(600,0,0,M.MODEL.mu,M.MODEL.dynamics.version);
  assert.ok(Math.hypot(combined.x-blackHole.x,combined.y-blackHole.y)>1e-3);
  assert.deepEqual(M.stellarBodiesAtTick(0),before);
  const legacy=M.fieldAcceleration(600,0,0,M.MODEL.mu,'two-body-pw-v1');
  assert.deepEqual(legacy,blackHole);
});

test('crossing a moving stellar surface captures the satellite and identifies the impacted star',()=>{
  const star=M.stellarBodiesAtTick(0)[0];
  const state=M.createState(launch({
    position:{x:star.x-star.collisionRadius-1,y:star.y},speed:1000,directionDeg:0
  }),{continuousTracking:true,fieldTick:0});
  M.step(state);
  assert.equal(state.status,'captured');
  assert.equal(state.event.bodyType,'star');
  assert.equal(state.event.bodyId,star.id);
  assert.equal(state.event.bodyName,star.name);
  assert.ok(state.event.substepFraction>0&&state.event.substepFraction<1);
  assert.ok(Math.abs(Math.hypot(state.x-state.event.bodyX,state.y-state.event.bodyY)-star.collisionRadius)<1e-7);
  assert.equal(state.fieldTick,state.event.fieldTick);
});

test('legacy two-body satellites pass through stellar locations unchanged by the new field',()=>{
  const star=M.stellarBodiesAtTick(0)[0];
  const state=M.createState({...launch({
    position:{x:star.x-star.collisionRadius-1,y:star.y},speed:1000,directionDeg:0
  }),dynamicsVersion:'two-body-pw-v1'},{continuousTracking:true,fieldTick:0});
  M.step(state);
  assert.equal(state.status,'active');
  assert.equal(state.fieldTick,undefined);
});

test('engine persists the stellar world phase and resumes it exactly after restart',t=>{
  const file=join(mkdtempSync(join(tmpdir(),'orbital-stars-')),'test.sqlite');
  let now=100000;
  let engine=new Engine({filename:file,now:()=>now});
  t.after(()=>engine.close());
  const user=engine.guest().user.id;
  const satellite=engine.launch(user,{...launch({speed:70,directionDeg:90}),idempotencyKey:'stellar-clock-launch'});
  assert.equal(satellite.state.fieldTick,satellite.birthTick);
  engine.advanceTo(engine.tick+600);engine.checkpoint();
  const saved=engine.get(user,satellite.id);
  engine.close();
  engine=new Engine({filename:file,now:()=>now});
  assert.deepEqual(engine.get(user,satellite.id).state,saved.state);
  engine.advanceTo(engine.tick+1);
  assert.equal(engine.get(user,satellite.id).state.fieldTick,saved.state.fieldTick+1);
});

test('engine rejects legacy force laws for newly created satellites',t=>{
  const file=join(mkdtempSync(join(tmpdir(),'orbital-stars-current-')),'test.sqlite');
  const engine=new Engine({filename:file,now:()=>100000});t.after(()=>engine.close());
  const user=engine.guest().user.id;
  assert.throws(()=>engine.launch(user,{...launch(),dynamicsVersion:'two-body-pw-v1',idempotencyKey:'legacy-new-launch'}),error=>error.status===409);
  const missing=launch();delete missing.dynamicsVersion;
  assert.throws(()=>engine.launch(user,{...missing,idempotencyKey:'missing-version-launch'}),error=>error.status===409);
});
