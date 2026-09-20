'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync,readFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {Worker}=require('node:worker_threads');
const Budget=require('../server/trajectory-budget.js');
const {Engine}=require('../server/engine.js');
const {archiveBatch}=require('../server/trajectory-store.js');
const M=require('../shared/simulation.js');

const launch={name:'预算验证',position:{x:330,y:0},massKg:1000,speed:M.circularSpeed(330),directionDeg:90,idempotencyKey:'budget-launch-0001'};

function fixture(t,{trajectoryMaxPoints=3}={}){
  const dir=mkdtempSync(join(tmpdir(),'orbital-budget-')),filename=join(dir,'orbital.sqlite'),engines=[];
  let now=100000,user;
  const make=()=>{const engine=new Engine({filename,now:()=>now,trajectoryMaxPoints});engines.push(engine);return engine;};
  const engine=make();user=engine.guest().user.id;const satellite=engine.launch(user,launch);
  t.after(()=>{for(const engine of engines)engine.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,filename,engine,user,satellite,make,setNow:value=>{now=value;}};
}

test('production trajectory policy represents one hundred MiB',()=>{
  assert.equal(Budget.POLICY.limitBytes,104857600);
  assert.equal(Budget.POLICY.estimatedBytesPerPoint,256);
  assert.equal(Budget.POLICY.maxPoints,409600);
  assert.throws(()=>Budget.createPolicy(0),/positive safe integer/);
});

test('legacy history already beyond the limit remains readable but cannot grow',()=>{
  const record={seq:4,lastSample:{seq:4,tick:40,elapsedSeconds:4},state:{tick:50,elapsedSeconds:5}};
  Budget.ensure(record,Budget.createPolicy(3));const coverage=Budget.coverage(record);
  assert.equal(coverage.status,'capped');assert.equal(coverage.lastSeq,4);
  assert.equal(coverage.endTick,40);assert.equal(coverage.estimatedBytes,1024);
  assert.equal(Budget.admit(record,{tick:60,elapsedSeconds:6}),false);
});

test('a multi-point sampler flush caps exactly at the third retained point',t=>{
  const f=fixture(t,{trajectoryMaxPoints:3}),e=f.engine;
  e.advanceTo(960);e.checkpoint();
  const capped=e.get(f.user,f.satellite.id),before=e.trajectory(f.user,f.satellite.id,{limit:100}).points;
  assert.equal(capped.trajectoryCoverage.status,'capped');
  assert.equal(capped.trajectoryCoverage.lastSeq,3);
  assert.equal(before.length,3);
  e.advanceTo(1920);e.checkpoint();
  assert.equal(e.trajectory(f.user,f.satellite.id,{limit:100}).points.length,3);
  assert.ok(e.get(f.user,f.satellite.id).state.tick>capped.state.tick);
  assert.deepEqual(e.trajectory(f.user,f.satellite.id,{limit:100}).points,before);
});

test('terminal state and restart do not append after trajectory cap',t=>{
  const f=fixture(t,{trajectoryMaxPoints:2});let e=f.engine;
  e.advanceTo(480);e.checkpoint();const endpoint=e.get(f.user,f.satellite.id).trajectoryCoverage;
  e.terminate(f.user,f.satellite.id);e.close();e=f.make();
  assert.equal(e.get(f.user,f.satellite.id).status,'terminated');
  assert.deepEqual(e.get(f.user,f.satellite.id).trajectoryCoverage,endpoint);
  assert.equal(e.trajectory(f.user,f.satellite.id,{limit:100}).points.length,2);
});

test('legacy sequence at the limit becomes capped without recounting hot points',t=>{
  const f=fixture(t,{trajectoryMaxPoints:3}),e=f.engine,id=f.satellite.id;e.close();
  const db=new DatabaseSync(f.filename),row=db.prepare('SELECT record FROM satellites WHERE id=?').get(id),record=JSON.parse(row.record);
  delete record.trajectoryBudget;record.seq=3;record.lastSample={...record.lastSample,seq:3};db.prepare('UPDATE satellites SET record=? WHERE id=?').run(JSON.stringify(record),id);db.close();
  const restored=f.make(),before=restored.db.prepare('SELECT count(*) n FROM points WHERE satellite_id=?').get(id).n;
  assert.equal(restored.get(f.user,id).trajectoryCoverage.status,'capped');
  restored.advanceTo(600);restored.checkpoint();
  assert.equal(restored.db.prepare('SELECT count(*) n FROM points WHERE satellite_id=?').get(id).n,before);
});

test('archiving all hot points does not restore capped capacity',t=>{
  const f=fixture(t,{trajectoryMaxPoints:4}),e=f.engine;e.advanceTo(960);e.checkpoint();
  const id=f.satellite.id,coverage=e.get(f.user,id).trajectoryCoverage;
  assert.equal(coverage.status,'capped');
  while(archiveBatch(e.db,f.filename,{cutoffWorldTick:100000,maxPoints:100})){}
  assert.equal(e.db.prepare('SELECT count(*) n FROM points WHERE satellite_id=?').get(id).n,0);
  e.close();const restored=f.make();restored.advanceTo(1920);restored.checkpoint();
  assert.equal(restored.get(f.user,id).trajectoryCoverage.lastSeq,4);
  assert.equal(restored.trajectory(f.user,id,{limit:100}).points.length,4);
});

async function exportJob(f,record){
  const target=join(f.dir,record.id+'.'+record.format),worker=new Worker(join(__dirname,'../server/export-worker.js'),{workerData:{filename:f.filename,target,record}});
  const exit=new Promise(resolve=>worker.once('exit',resolve));
  const result=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});await exit;
  assert.equal(result.status,'ready',result.message);return readFileSync(target,'utf8');
}

test('capped query and exports stop at coverage while current state continues',async t=>{
  const f=fixture(t,{trajectoryMaxPoints:2}),e=f.engine,id=f.satellite.id;
  e.advanceTo(480);e.checkpoint();const capped=e.get(f.user,id).trajectoryCoverage;
  e.advanceTo(960);e.checkpoint();assert.ok(e.get(f.user,id).state.tick>capped.endTick);
  const history=e.trajectory(f.user,id,{fromTick:0,toTick:Number.MAX_SAFE_INTEGER,limit:100});
  assert.equal(history.cutoffTick,capped.endTick);assert.deepEqual(history.trajectoryCoverage,capped);
  assert.equal(history.points.at(-1).seq,capped.lastSeq);
  const beyond=e.trajectory(f.user,id,{fromTick:capped.endTick+100,limit:100});
  assert.equal(beyond.cutoffTick,capped.endTick);assert.equal(beyond.points.at(-1).seq,capped.lastSeq);
  assert.equal(Object.hasOwn(e.get(f.user,id),'trajectoryBudget'),false);
  const jsonRecord=e.prepareExport(f.user,id,'json');
  assert.equal(jsonRecord.cutoffTick,capped.endTick);assert.equal(jsonRecord.cutoffSeq,capped.lastSeq);
  assert.equal(jsonRecord.trajectoryCoverage.truncated,true);
  const json=JSON.parse(await exportJob(f,jsonRecord));
  assert.deepEqual(json.trajectoryCoverage,capped);assert.equal(json.points.at(-1).seq,capped.lastSeq);
  assert.ok(json.satellite.state.tick>json.trajectoryCoverage.endTick);assert.match(json.description,/存储上限/);
  const csvRecord=e.prepareExport(f.user,id,'csv'),csv=await exportJob(f,csvRecord);
  assert.match(csv,/trajectoryCoverage/);assert.match(csv,/truncated/);
});
