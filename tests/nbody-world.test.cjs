'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync}=require('node:fs');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {Engine}=require('../server/engine.js');

test('seeded body motion is account scoped, survives restart and ignores satellite mass',t=>{
  const dir=mkdtempSync(join(tmpdir(),'orbital-nbody-world-')),filename=join(dir,'orbital.sqlite');
  let engine=new Engine({filename});
  t.after(()=>{engine.close();rmSync(dir,{recursive:true,force:true});});
  const a=engine.guest().user.id,b=engine.guest().user.id;
  const {worldId}=engine.registerWorld({seed:'body field',options:{layout:'spatial-v7',systems:2,blackHoles:1,stars:4}});
  engine.advanceTo(1000);
  const snapshot=user=>engine.active(user,worldId,3).server.bodyField;
  const start=snapshot(a);
  assert.equal(start.tick,0);
  assert.deepEqual(snapshot(b),start);
  const hole=start.bodies.find(body=>body.kind==='blackHole');
  const input={worldId,referenceBodyId:hole.id,name:'probe',position:{x:2000,y:0,z:0},dimension:3,pitchDeg:0,
    speed:5,directionDeg:90,dynamicsVersion:engine.modelInfo(worldId).model.dynamics.version};
  const small=engine.launch(a,{...input,massKg:1,idempotencyKey:'small-probe'});
  const big=engine.launch(a,{...input,massKg:1e30,idempotencyKey:'large-probe'});
  engine.advanceTo(1720);
  const before=snapshot(a);
  assert.equal(before.tick,720);
  assert.deepEqual(before,snapshot(b));
  assert.notDeepEqual(before.bodies,start.bodies);
  assert.deepEqual(engine.get(a,small.id).state,engine.get(a,big.id).state);
  const track=engine.bodyTrajectory(a,worldId,hole.id).points;
  assert.ok(track.length>=2);
  assert.equal(track[0].tick,0);
  engine.setSpatialPaused(a,worldId,true);
  engine.advanceTo(1960);
  assert.deepEqual(snapshot(a),before);
  assert.equal(snapshot(b).tick,960);
  engine.close();engine=new Engine({filename});
  assert.deepEqual(snapshot(a),before);
  assert.deepEqual(engine.bodyTrajectory(a,worldId,hole.id).points,track);
  engine.switchMap(a,{fromWorldId:worldId,toWorldId:null,switchId:'19c8f104-e40b-4263-8989-d172779627eb'});
  assert.equal(snapshot(a).tick,0);
  assert.equal(snapshot(b).tick,960);
});

test('a celestial collision leaves both original tracks and starts a new track for the merged body',t=>{
  const engine=new Engine({filename:':memory:'});
  t.after(()=>engine.close());
  const user=engine.guest().user.id,worldId='a'.repeat(64);
  const body=(id,x,vx)=>({id,kind:'star',name:id,color:'#abcdef',radius:10,massSolar:.3,orbit:null,
    initial:{x,y:0,z:0,vx,vy:0,vz:0}});
  const world={version:'seeded-systems-v1',seed:'impact',radius:90000,layout:'spatial-v7',motion:'nbody-v1',systems:[
    {id:'s',type:'procedural',x:0,y:0,z:0,extent:150,bodies:[body('a',-100,400),body('b',100,-400)]}
  ]};
  engine.db.prepare('INSERT INTO worlds VALUES (?,?)').run(worldId,JSON.stringify(world));
  engine.active(user,worldId,3);
  engine.advanceTo(300);
  const state=engine.active(user,worldId,3).server.bodyField;
  assert.deepEqual(state.bodies.map(body=>body.id),['merged-1']);
  assert.equal(state.bodies[0].mass,.6);
  const a=engine.bodyTrajectory(user,worldId,'a'),b=engine.bodyTrajectory(user,worldId,'b');
  const merged=engine.bodyTrajectory(user,worldId,'merged-1');
  assert.equal(a.body.endTick,b.body.endTick);
  assert.equal(a.points.at(-1).tick,merged.points[0].tick);
  assert.equal(merged.body.birthTick,merged.points[0].tick);
  assert.ok(Math.abs(a.points.at(-1).x-b.points.at(-1).x-(-20))<1e-8);
  assert.deepEqual(engine.bodyFrame(user,worldId,0).bodies.map(body=>body.id),['a','b']);
  assert.deepEqual(engine.bodyFrame(user,worldId,merged.body.birthTick+1).bodies.map(body=>body.id),['merged-1']);
});

test('simulation speed advances bodies and satellites together without changing the path or other accounts',t=>{
  const dir=mkdtempSync(join(tmpdir(),'orbital-nbody-speed-')),filename=join(dir,'orbital.sqlite');
  let engine=new Engine({filename});
  t.after(()=>{engine.close();rmSync(dir,{recursive:true,force:true});});
  const a=engine.guest().user.id,b=engine.guest().user.id;
  const {worldId}=engine.registerWorld({seed:'simulation speed',options:{layout:'spatial-v8',systems:2,stars:6,blackHoles:0}});
  const clock=user=>engine.active(user,worldId,3).server;
  const body=clock(a).bodyField.bodies[0];
  clock(b);
  const input={worldId,referenceBodyId:body.id,name:'probe',position:{x:2400,y:0,z:0},dimension:3,pitchDeg:0,
    speed:5,directionDeg:90,massKg:1000,dynamicsVersion:'seeded-nbody-v1',idempotencyKey:'timed-probe'};
  const fast=engine.launch(a,input),slow=engine.launch(b,input);
  assert.throws(()=>engine.setSpatialRate(a,worldId,3),{status:422});
  assert.equal(engine.setSpatialRate(a,worldId,8).server.tick,0);
  engine.advanceTo(60);
  assert.equal(clock(a).tick,480);
  assert.equal(clock(a).bodyField.tick,480);
  assert.equal(engine.get(a,fast.id).state.fieldTick,480);
  assert.equal(clock(b).tick,60);
  assert.equal(engine.get(b,slow.id).state.fieldTick,60);
  const saved=engine.get(a,fast.id).state;
  engine.setSpatialPaused(a,worldId,true);
  assert.equal(engine.setSpatialRate(a,worldId,4).server.tick,480);
  engine.advanceTo(480);
  assert.deepEqual(engine.get(b,slow.id).state,saved);
  assert.deepEqual(clock(a).bodyField,clock(b).bodyField);
  engine.close();engine=new Engine({filename});
  assert.equal(clock(a).simulationRate,4);
  assert.equal(clock(a).paused,true);
  engine.setSpatialPaused(a,worldId,false);
  engine.advanceTo(540);
  assert.equal(clock(a).tick,720);
  assert.equal(clock(a).bodyField.tick,720);
  assert.equal(engine.get(a,fast.id).state.fieldTick,720);
  assert.equal(clock(b).tick,540);
});
