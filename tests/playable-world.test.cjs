const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtempSync,rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {startServer} = require('../server/index.js');
const {createRuntime} = require('../shared/simulation.js');
const {generateWorld,bodyPositions} = require('../shared/world-generator.js');

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
  const options = {systems:3,blackHoles:0,stars:6,planets:5};
  const {data:map} = await request('/api/worlds',{seed:'云图',options},201);
  const {worldId,world} = map;
  assert.equal(world.systems.length, 3);
  assert.ok(world.systems.every(system => system.type === 'binary'));
  assert.equal(world.systems.flatMap(system => system.bodies).filter(body => body.kind === 'planet').length, 5);
  assert.equal((await request('/api/worlds',{seed:'云图',options},201)).data.worldId, worldId);
  await request('/api/worlds',{seed:'云图',options:{...options,stars:7}},422);

  const guest = await request('/api/session/guest',{});
  auth = {cookie:guest.response.headers.get('set-cookie').split(';')[0],'x-csrf-token':guest.data.csrfToken};
  const query = '?worldId=' + worldId;
  const {data:configuration} = await request('/api/model' + query);
  const input = {name:'test',position:{x:330,y:0},massKg:1000,speed:25,directionDeg:90,idempotencyKey:'shared-launch-key'};
  const seeded = {...input,worldId,modelVersion:configuration.model.version,dynamicsVersion:configuration.model.dynamics.version};
  const {data:{satellite}} = await request('/api/satellites',seeded,201);
  assert.equal(satellite.worldId, worldId);
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
});
