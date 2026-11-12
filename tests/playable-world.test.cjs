const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtempSync,rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {startServer} = require('../server/index.js');
const {createRuntime} = require('../shared/simulation.js');
const {generateWorld,bodyPositions} = require('../shared/world-generator.js');

test('physics advances while a periodic save waits for disk access, and pause waits for durability', async t=>{
  const dir=mkdtempSync(join(tmpdir(),'orbital-async-checkpoint-'));
  const app=await startServer({port:0,dataDir:dir});
  const blocker=new DatabaseSync(join(dir,'orbital.sqlite'));
  blocker.exec('PRAGMA busy_timeout=3000');
  t.after(async()=>{
    if(blocker.isTransaction)blocker.exec('ROLLBACK');
    blocker.close();
    await app.close();
    rmSync(dir,{recursive:true,force:true});
  });
  const headers={'content-type':'application/json'};
  async function request(path,body){
    const res=await fetch(app.url+path,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});
    if(!res.ok)assert.fail(await res.text());
    return res;
  }
  const guest=await request('/api/session/guest',{});
  headers.cookie=guest.headers.get('set-cookie').split(';')[0];
  headers['x-csrf-token']=(await guest.json()).csrfToken;
  const {worldId}=await (await request('/api/worlds',{seed:'concurrent checkpoint',options:{systems:2,stars:6,blackHoles:0}})).json();
  const query='?worldId='+worldId;
  const list=()=>request('/api/satellites'+query).then(res=>res.json());
  await list();
  blocker.exec('BEGIN IMMEDIATE');
  let first;
  for(let i=0;i<40;i++){
    const current=(await list()).server;
    if(current.storage.checkpointQueuedTick>current.storage.checkpointSavedTick){first=current;break;}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(first,'a periodic save reached the storage thread');
  const pause=request('/api/simulation/pause'+query,{paused:true}).then(res=>res.json());
  let paused=false;
  pause.then(()=>{paused=true;},()=>{});
  await new Promise(resolve=>setTimeout(resolve,130));
  const moving=(await list()).server;
  assert.ok(moving.bodyField.tick>first.bodyField.tick);
  assert.equal(moving.storage.checkpointSavedTick,first.storage.checkpointSavedTick);
  assert.equal(paused,false);
  blocker.exec('COMMIT');
  const {server:frozen}=await pause;
  const saved=JSON.parse(blocker.prepare('SELECT state FROM body_fields WHERE world_id=?').get(worldId).state);
  assert.equal(frozen.paused,true);
  assert.equal(saved.tick,frozen.bodyField.tick);
  assert.deepEqual(saved.bodies,frozen.bodyField.bodies);
});

test('seeded dynamics resolve collisions at the generated body location', () => {
  const world = generateWorld('binary launch', {systems: 2, blackHoles: 0});
  const runtime = createRuntime(world);
  const launch = {name:'test', position:{x:0,y:0}, massKg:1000, speed:0, directionDeg:0, dynamicsVersion:runtime.MODEL.dynamics.version};
  const origin = runtime.createState(launch);
  runtime.step(origin);
  assert.equal(origin.status, 'active');
  assert.ok(Math.hypot(origin.vx, origin.vy) > 0, 'distant generated stars exert gravity at the map origin');
  const [star] = bodyPositions(world.systems[0], 20);
  const impact = runtime.createState({...launch, position:{x:star.x,y:star.y}}, {fieldTick:4800});
  runtime.step(impact);
  assert.equal(impact.status, 'captured');
  assert.equal(impact.event.bodyId, star.id);
  assert.equal(impact.event.bodyX, star.x);
  assert.equal(impact.event.bodyY, star.y);
});

test('a playable map persists with its configuration and isolates satellite lists and sweeps', async t => {
  const dir = mkdtempSync(join(tmpdir(),'orbital-playable-'));
  let app = await startServer({port:0,dataDir:dir});
  t.after(async () => { await app.close(); rmSync(dir,{recursive:true,force:true}); });
  let auth = {};
  async function request(path, body, status = 200) {
    const response = await fetch(app.url + path, body === undefined ? {headers:auth} : {
      method:'POST', headers:{...auth,'content-type':'application/json'}, body:JSON.stringify(body)
    });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return {response,data};
  }
  const options = {systems:2,blackHoles:0,stars:8};
  const {data:map} = await request('/api/worlds',{seed:'云图',options},201);
  const {worldId,world} = map;
  assert.ok(world.systems.every(system=>system.type==='procedural'));
  assert.equal(world.systems.reduce((sum,system)=>sum+system.bodies.length,0),8);
  assert.equal(world.layout, 'spatial-v8');
  assert.ok(world.systems.every(system => system.bodies.every(body => body.kind === 'star')));
  assert.equal((await request('/api/worlds',{seed:'云图',options},201)).data.worldId, worldId);
  const {data:legacy} = await request('/api/worlds',{seed:'云图',options:{...options,stars:4,layout:'spatial-v4'}},201);
  assert.notEqual(legacy.worldId,worldId);
  await request('/api/worlds',{seed:'云图',options:{...options,stars:17}},422);

  const guest = await request('/api/session/guest',{});
  auth = {cookie:guest.response.headers.get('set-cookie').split(';')[0],'x-csrf-token':guest.data.csrfToken};
  const query = '?worldId=' + worldId;
  const {data:configuration} = await request('/api/model' + query);
  const {data:bodyList} = await request('/api/satellites' + query);
  const bodyId=bodyList.server.bodyField.bodies[0].id;
  const {data:bodyTrack}=await request('/api/worlds/body-trajectory'+query+'&bodyId='+bodyId);
  assert.equal(bodyTrack.points[0].tick,0);
  const detail='/api/worlds/body-trajectory'+query+'&bodyId='+bodyId+'&fromTick=0';
  assert.deepEqual((await request(detail+'&toTick=0')).data.points,[bodyTrack.points[0]]);
  await request(detail,undefined,422);
  const {data:bodyFrame}=await request('/api/worlds/body-frame'+query+'&tick=0');
  assert.ok(bodyFrame.bodies.some(body=>body.id===bodyId));
  const input = {name:'test',dimension:3,position:{x:330,y:0,z:0},pitchDeg:0,massKg:1000,speed:25,directionDeg:90,idempotencyKey:'shared-launch-key'};
  const seeded = {...input,worldId,modelVersion:configuration.model.version,dynamicsVersion:configuration.model.dynamics.version};
  const {data:{satellite}} = await request('/api/satellites',seeded,201);
  assert.equal(satellite.worldId, worldId);
  const legacyQuery = '?worldId=' + legacy.worldId;
  const {data:{model:legacyModel}} = await request('/api/model'+legacyQuery);
  const {data:{satellite:legacyFlight}} = await request('/api/satellites',{
    ...seeded,worldId:legacy.worldId,modelVersion:legacyModel.version,dynamicsVersion:legacyModel.dynamics.version,
    idempotencyKey:'legacy-map-launch-key'
  },201);
  const {data:classic} = await request('/api/model');
  const classicInput = {...input,modelVersion:classic.model.version,dynamicsVersion:classic.model.dynamics.version};
  await request('/api/satellites',classicInput,409);
  const {data:{satellite:classicSatellite}} = await request('/api/satellites',{...classicInput,idempotencyKey:'classic-launch-key'},201);
  assert.deepEqual((await request('/api/satellites')).data.satellites.map(item=>item.id), [classicSatellite.id]);
  assert.deepEqual((await request('/api/satellites' + query)).data.satellites.map(item=>item.id), [satellite.id]);
  assert.deepEqual((await request('/api/satellites/active' + query)).data.satellites.map(item=>item.id), [satellite.id]);
  await request('/api/satellites/terminate-many',{worldId,ids:[satellite.id,classicSatellite.id]},404);
  assert.equal((await request('/api/satellites/' + satellite.id)).data.satellite.status, 'active');

  await app.close();
  app = await startServer({port:0,dataDir:dir});
  assert.deepEqual((await request('/api/model' + query)).data.world, world);
  assert.equal((await request('/api/satellites' + query)).data.satellites[0].id, satellite.id);
  assert.deepEqual((await request('/api/model'+legacyQuery)).data.world,legacy.world);
  const {data:legacyTrail} = await request('/api/satellites/'+legacyFlight.id+'/trajectory');
  assert.equal(legacyTrail.points[0].kind,'birth');
  assert.equal(legacyTrail.points[0].z,legacyFlight.initial.position.z);
  const {data:paused}=await request('/api/simulation/pause'+query,{paused:true});
  const {data:faster}=await request('/api/simulation/rate'+query,{rate:4});
  assert.equal(faster.server.simulationRate,4);
  assert.equal(faster.server.tick,paused.server.tick);
  assert.equal(faster.server.paused,true);
  await request('/api/simulation/rate'+query,{rate:3},422);
});
