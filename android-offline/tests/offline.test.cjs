const assert = require('node:assert/strict');
const {mkdtempSync, readFileSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {randomBytes} = require('node:crypto');
const {test} = require('node:test');

test('private mobile runtime runs a seeded launch and preserves it across restart', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'orbital-android-'));
  const readyFile = join(dataDir, 'ready.json');
  const token = randomBytes(32).toString('hex');
  let app;
  t.after(async () => {
    await app?.close();
    rmSync(dataDir, {recursive: true, force: true});
  });

  const {startOffline} = require('../offline.cjs');
  app = await startOffline({dataDir, readyFile, token});
  const {url} = JSON.parse(readFileSync(readyFile, 'utf8'));
  assert.equal(url, app.url);
  assert.equal(new URL(url).hostname, '127.0.0.1');
  assert.equal((await fetch(url + '/map-3d.html')).status, 403);
  assert.equal((await fetch(url + '/api/model', {
    headers: {cookie: 'orbital_device=' + 'a'.repeat(64)},
  })).status, 403);

  let cookie = 'orbital_device=' + token;
  let csrf;
  async function request(path, {data, status = 200} = {}) {
    const headers = {cookie};
    if (csrf) headers['x-csrf-token'] = csrf;
    if (data !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(app.url + path, {
      headers,
      method: data === undefined ? 'GET' : 'POST',
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    if (response.status !== status) assert.fail(path + ': ' + await response.text());
    return response;
  }

  const mission = await request('/map-3d.html');
  assert.match(await mission.text(), /MISSION CONTROL/);
  const guest = await request('/api/session/guest', {data: {}});
  cookie += '; ' + guest.headers.get('set-cookie').split(';')[0];
  csrf = (await guest.json()).csrfToken;
  const world = await request('/api/worlds', {
    data: {seed: '断网星图', options: {systems: 2, blackHoles: 0, stars: 4}},
    status: 201,
  });
  const {worldId} = await world.json();
  const query = '?worldId=' + worldId;
  const configuration = await request('/api/model' + query);
  const {model} = await configuration.json();
  const launch = await request('/api/satellites', {status: 201, data: {
    worldId, modelVersion: model.version, dynamicsVersion: model.dynamics.version,
    name: '离线试飞', dimension: 3, position: {x: 300, y: 0, z: 0}, massKg: 1000, speed: 20, directionDeg: 90, pitchDeg: 0,
    idempotencyKey: 'offline-flight-test',
  }});
  const {satellite} = await launch.json();
  await app.close();
  app = await startOffline({dataDir, readyFile, token});
  const list = await request('/api/satellites' + query);
  assert.deepEqual((await list.json()).satellites.map(item => item.id), [satellite.id]);
  const trajectory = await request('/api/satellites/' + satellite.id + '/trajectory');
  assert.ok((await trajectory.json()).points.length > 0);
  const exportRequest = await request('/api/satellites/' + satellite.id + '/exports', {
    status: 202, data: {format: 'csv'},
  });
  let job = (await exportRequest.json()).export;
  for (let i = 0; i < 100 && job.status === 'pending'; i++) {
    await new Promise(resolve => setTimeout(resolve, 30));
    job = (await (await request('/api/exports/' + job.id)).json()).export;
  }
  assert.equal(job.status, 'ready');
  const download = await request(job.downloadUrl);
  assert.match(download.headers.get('content-disposition'), /attachment.*\.csv/);
  assert.match(await download.text(), /metadata_json/);
});
