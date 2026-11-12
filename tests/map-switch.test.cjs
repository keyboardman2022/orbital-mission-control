'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {existsSync,mkdirSync,mkdtempSync,rmSync,rmdirSync,unlinkSync,writeFileSync}=require('node:fs');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {randomUUID}=require('node:crypto');
const {Engine}=require('../server/engine.js');
const {DatabaseSync}=require('node:sqlite');
const {startServer}=require('../server/index.js');

test('switching maps removes only the prior map’s records for the current account and can be retried',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'orbital-map-switch-'));
  let app;
  t.after(async()=>{await app?.close();rmSync(dataDir,{recursive:true,force:true});});
  const engine=new Engine({filename:join(dataDir,'orbital.sqlite')});
  const owner=engine.guest(),other=engine.guest();
  const options={layout:'spatial-v5'};
  const source=engine.registerWorld({seed:'source',options}).worldId;
  const destination=engine.registerWorld({seed:'destination',options}).worldId;
  const input={name:'probe',dimension:3,position:{x:1200,y:0,z:10},speed:15,directionDeg:90,pitchDeg:0,massKg:1000};
  const launchInput=(worldId,idempotencyKey)=>({...input,worldId,idempotencyKey,
    dynamicsVersion:engine.worldInfo(worldId).runtime.MODEL.dynamics.version});
  const original=engine.launch(owner.user.id,launchInput(source,'original-flight'));
  const live=engine.launch(owner.user.id,launchInput(source,'running-flight'));
  const unrelated=engine.launch(owner.user.id,launchInput(destination,'kept-flight'));
  const shared=engine.launch(other.user.id,launchInput(source,'shared-flight'));
  const classic=engine.launch(owner.user.id,launchInput(null,'classic-flight'));
  const retryInput=launchInput(source,'new-flight-after-switch');
  engine.terminate(owner.user.id,original.id);
  engine.setSpatialPaused(owner.user.id,source,true);
  const out=engine.prepareExport(owner.user.id,original.id,'csv');
  const keep=engine.prepareExport(other.user.id,shared.id,'csv');
  const archives=join(dataDir,'trajectories'),exports=join(dataDir,'exports');
  mkdirSync(archives);mkdirSync(exports);
  for(const [flight,file] of [[original,'ab.json.gz'],[shared,'cd.json.gz']]){
    engine.db.prepare('INSERT INTO trajectory_chunks VALUES (?,3,3,1,1,1,?,?)').run(flight.id,file,'fixture');
    writeFileSync(join(archives,file),'fixture');
  }
  for(const job of [out,keep])writeFileSync(join(exports,job.id+'.csv'),'fixture');
  engine.close();
  app=await startServer({port:0,dataDir});

  function request(path,body,account=owner,csrf=account.csrfToken){
    return fetch(app.url+path,{method:body===undefined?'GET':'POST',headers:{
      cookie:'orbital_session='+account.token,'content-type':'application/json','x-csrf-token':csrf
    },body:body===undefined?undefined:JSON.stringify(body)});
  }
  const switchTo={fromWorldId:source,toWorldId:destination,switchId:randomUUID()};
  const change=(values=switchTo,csrf)=>request('/api/worlds/switch',values,owner,csrf);
  assert.equal((await request('/api/session')).status,200);
  assert.equal((await change(switchTo,'invalid')).status,403);
  assert.equal((await change({...switchTo,toWorldId:'0'.repeat(64)})).status,404);
  assert.equal((await change({...switchTo,toWorldId:source})).status,200);
  assert.equal((await request('/api/satellites/'+original.id)).status,200);

  const archiveFile=join(archives,'ab.json.gz');
  unlinkSync(archiveFile);
  mkdirSync(archiveFile); // Simulate an archive file that cannot be unlinked.
  assert.equal((await change()).status,503);
  rmdirSync(archiveFile);
  writeFileSync(archiveFile,'fixture');
  await app.close();app=await startServer({port:0,dataDir});
  const resumed=await change();
  assert.equal(resumed.status,200);
  assert.deepEqual(await resumed.json(),{deleted:2});
  for(const flight of [original,live])assert.equal((await request('/api/satellites/'+flight.id)).status,404);
  for(const flight of [unrelated,classic])assert.equal((await request('/api/satellites/'+flight.id)).status,200);
  assert.equal((await request('/api/satellites/'+shared.id,undefined,other)).status,200);
  assert.equal((await request('/api/model?worldId='+source)).status,200);
  assert.equal((await request('/api/exports/'+out.id)).status,404);
  assert.equal(existsSync(join(archives,'ab.json.gz')),false);
  assert.equal(existsSync(join(exports,out.id+'.csv')),false);
  assert.equal(existsSync(join(archives,'cd.json.gz')),true);
  assert.equal(existsSync(join(exports,keep.id+'.csv')),true);
  const after=await (await request('/api/satellites?worldId='+source)).json();
  assert.equal(after.server.paused,false);
  assert.deepEqual(after.satellites,[]);

  const newFlight=(await (await request('/api/satellites',retryInput)).json()).satellite;
  assert.ok(newFlight?.id);
  await app.close();app=await startServer({port:0,dataDir});
  assert.equal((await change()).status,200);
  assert.equal((await request('/api/satellites/'+newFlight.id)).status,200);
  assert.equal((await change({...switchTo,toWorldId:null})).status,409);
  assert.equal((await change({fromWorldId:null,toWorldId:destination,switchId:randomUUID()})).status,200);
  assert.equal((await request('/api/satellites/'+classic.id)).status,404);
});

test('map entry streams real deletion progress while a blocked writer leaves health responsive',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'orbital-map-progress-')),filename=join(dataDir,'orbital.sqlite');
  const engine=new Engine({filename});
  const guest=engine.guest();
  const options={layout:'spatial-v8',systems:2,stars:6,blackHoles:0};
  const fromWorldId=engine.registerWorld({seed:'many tracks',options}).worldId;
  const toWorldId=engine.registerWorld({seed:'new destination',options}).worldId;
  const field=engine.ensureBodyField(guest.user.id,fromWorldId);
  const id=field.currentBodies()[0].id;
  engine.db.prepare(`WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<20000)
    INSERT INTO body_tracks SELECT ?,?,?,i*480,0,0,0,0,0,0 FROM seq`).run(guest.user.id,fromWorldId,id);
  engine.close();
  const app=await startServer({port:0,dataDir});
  const blocker=new DatabaseSync(filename);
  t.after(async()=>{
    if(blocker.isTransaction)blocker.exec('ROLLBACK');
    blocker.close();
    await app.close();
    rmSync(dataDir,{recursive:true,force:true});
  });
  blocker.exec('PRAGMA busy_timeout=3000; BEGIN IMMEDIATE');
  const response=await fetch(app.url+'/api/worlds/switch',{
    method:'POST',headers:{cookie:'orbital_session='+guest.token,'x-csrf-token':guest.csrfToken,
      'content-type':'application/json',accept:'application/x-ndjson'},
    body:JSON.stringify({fromWorldId,toWorldId,switchId:randomUUID()})
  });
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type'),/application\/x-ndjson/);
  const reader=response.body.getReader(),decoder=new TextDecoder();
  let text=decoder.decode((await reader.read()).value,{stream:true});
  assert.match(text,/"stage":"waiting"/);
  const health=await fetch(app.url+'/health',{signal:AbortSignal.timeout(1500)});
  assert.equal((await health.json()).status,'running');
  blocker.exec('ROLLBACK');
  for(;;){
    const chunk=await reader.read();
    if(chunk.done)break;
    text+=decoder.decode(chunk.value,{stream:true});
  }
  text+=decoder.decode();
  const updates=text.trim().split('\n').map(line=>JSON.parse(line));
  const tracks=updates.filter(update=>update.stage==='tracks');
  assert.ok(tracks[0].total>=20000);
  assert.equal(tracks[0].removed,0);
  assert.equal(tracks.at(-1).removed,tracks[0].total);
  assert.ok(updates.some(update=>update.stage==='commit'));
  assert.equal(updates.at(-1).stage,'done');
  assert.equal(blocker.prepare('SELECT count(*) n FROM body_tracks WHERE world_id=?').get(fromWorldId).n,0);
});
