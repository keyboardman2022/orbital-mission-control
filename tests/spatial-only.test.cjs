'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync}=require('node:fs');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const {Engine}=require('../server/engine.js');
const {startServer}=require('../server/index.js');

test('server upgrade removes flat worlds, flights and their files while preserving spatial records and identity',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'orbital-spatial-only-'));
  const filename=join(dir,'orbital.sqlite');
  let app;
  t.after(async()=>{await app?.close();rmSync(dir,{recursive:true,force:true});});
  const engine=new Engine({filename});
  const {user,token}=engine.guest();
  const flatWorld=engine.registerWorld({seed:'flat world'}).worldId;
  const spatialWorld=engine.registerWorld({seed:'spatial world',options:{layout:'spatial-v1'}}).worldId;
  const input={name:'probe',position:{x:500,y:0},speed:10,directionDeg:90,massKg:1000};
  const flat=engine.launch(user.id,{...input,worldId:flatWorld,idempotencyKey:'flat-probe'});
  const spatial=engine.launch(user.id,{...input,worldId:spatialWorld,dimension:3,pitchDeg:0,
    position:{...input.position,z:10},idempotencyKey:'spatial-probe',
    dynamicsVersion:engine.worldInfo(spatialWorld).runtime.MODEL.dynamics.version});
  const archiveDir=join(dir,'trajectories'),exportDir=join(dir,'exports');
  mkdirSync(archiveDir);mkdirSync(exportDir);
  for(const [flight,file] of [[flat,'ab.json.gz'],[spatial,'cd.json.gz']]){
    engine.db.prepare('INSERT INTO trajectory_chunks VALUES (?,2,2,1,1,1,?,?)').run(flight.id,file,'fixture');
    writeFileSync(join(archiveDir,file),'fixture');
  }
  const flatExport=engine.prepareExport(user.id,flat.id,'json').id;
  const spatialExport=engine.prepareExport(user.id,spatial.id,'csv').id;
  writeFileSync(join(exportDir,flatExport+'.json.partial'),'flat export');
  writeFileSync(join(exportDir,spatialExport+'.csv'),'spatial export');
  engine.close();

  app=await startServer({port:0,dataDir:dir});
  const request=path=>fetch(app.url+path,{headers:{cookie:'orbital_session='+token}});
  assert.equal((await request('/api/model?worldId='+flatWorld)).status,404);
  assert.equal((await request('/api/model?worldId='+spatialWorld)).status,200);
  assert.equal((await request('/api/satellites/'+flat.id)).status,404);
  assert.equal((await request('/api/satellites/'+spatial.id)).status,200);
  assert.equal((await request('/api/exports/'+flatExport)).status,404);
  assert.equal((await request('/api/exports/'+spatialExport)).status,200);
  assert.equal(existsSync(join(archiveDir,'ab.json.gz')),false);
  assert.equal(existsSync(join(archiveDir,'cd.json.gz')),true);
  assert.equal(existsSync(join(exportDir,flatExport+'.json.partial')),false);
  assert.equal(existsSync(join(exportDir,spatialExport+'.csv')),true);
  const db=new DatabaseSync(filename,{readOnly:true});
  try{
    for(const table of ['points','events','trajectory_chunks','satellite_worlds','exports']){
      assert.equal(db.prepare('SELECT count(*) AS n FROM '+table+' WHERE satellite_id=?').get(flat.id).n,0);
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{db.close();}
});
