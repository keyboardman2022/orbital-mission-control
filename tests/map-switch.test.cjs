'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {existsSync,mkdirSync,mkdtempSync,rmSync,rmdirSync,unlinkSync,writeFileSync}=require('node:fs');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {randomUUID}=require('node:crypto');
const {Engine}=require('../server/engine.js');
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
