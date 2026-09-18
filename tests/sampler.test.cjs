const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../shared/simulation.js');
const U = require('../shared/units.js');
const S = require('../server/trajectory-sampler.js');
const point = (tick, elapsedSeconds, x, y = 0, vx = 0, vy = 0, kind = 'sample') =>
  ({tick, elapsedSeconds, x, y, vx, vy, kind});

test('sampler excludes its stored anchor, flushes the exact endpoint and continues from it', () => {
  assert.equal(typeof S.createSampler, 'function');
  const anchor = point(0, 0, 0, 0, 0.1234567890123456, 0, 'birth');
  const sampler = S.createSampler(anchor, {version:'fixture', kmPerUnit:1, kmSPerUnit:1});
  assert.equal(sampler.size, 1);
  assert.deepEqual(sampler.flush(), []);
  sampler.push(point(1, 0.01, 0.01, 0, anchor.vx));
  const end = point(2, 1, 1, 0, anchor.vx);
  sampler.push(end);
  assert.deepEqual(sampler.flush(), [end]);
  assert.equal(sampler.size, 1);
  assert.deepEqual(sampler.flush(), []);
  const next = point(3, 2, 2, 0, anchor.vx);
  sampler.push(next);
  assert.deepEqual(sampler.flush(), [next]);
  assert.equal(anchor.kind, 'birth');
});

test('time interpolation and velocity vector error each retain a required interior point', () => {
  assert.equal(typeof S.createSampler, 'function');
  const calibration = {version:'fixture', kmPerUnit:1, kmSPerUnit:1};
  const timed = S.createSampler(point(0, 0, 0), calibration);
  const middle = point(1, 0.1, 0.5);
  timed.push(middle); timed.push(point(2, 1, 1));
  assert.deepEqual(timed.flush().map(p => p.tick), [1, 2]);
  const velocity = S.createSampler(point(0, 0, 0, 0, 10, 0), calibration);
  velocity.push(point(1, 0.5, 0, 0, 0, 10));
  velocity.push(point(2, 1, 0, 0, -10, 0));
  assert.deepEqual(velocity.flush().map(p => p.tick), [1, 2]);
});

test('pinned physical calibration sets both scene tolerances and reports the guarantee', () => {
  assert.equal(typeof S.policyFor, 'function');
  const calibration = {version:'fixture', kmPerUnit:2, kmSPerUnit:4};
  const policy = S.policyFor(calibration);
  assert.equal(policy.positionToleranceScene, 0.05);
  assert.equal(policy.velocityToleranceScene, 0.025);
  assert.equal(policy.calibrationVersion, 'fixture');
  assert.deepEqual(S.POLICY, {version:'time-linear-error-v1', blockTicks:240,
    positionToleranceKm:0.1, velocityToleranceKmS:0.1,
    velocityRelativeTolerance:0.001,
    interpolation:'linear-time', guarantee:'sampled-integrator-times'});
  const sampler = S.createSampler(point(0, 0, 0), calibration);
  calibration.kmPerUnit = 0.001; calibration.kmSPerUnit = 0.001;
  sampler.push(point(1, 0.5, 0.06, 0, 0.03)); sampler.push(point(2, 1, 0));
  assert.deepEqual(sampler.flush().map(p => p.tick), [1, 2]);
});

test('all event kinds and zero duration terminal events survive simplification', () => {
  assert.equal(typeof S.createSampler, 'function');
  const sampler = S.createSampler(point(0, 0, 0, 0, 0, 0, 'birth'), U.SCALE);
  const events = [point(1, 1, 1, 0, 0, 0, 'checkpoint'),
    point(1, 1, 1, 0, 0, 0, 'terminated'), point(2, 1, 1, 0, 0, 0, 'error')];
  for (const event of events) sampler.push(event);
  assert.deepEqual(sampler.flush(), events);
  const captured = point(2, 1, 1, 0, 0, 0, 'captured');
  sampler.push(captured);
  assert.deepEqual(sampler.flush(), [captured]);
});

test('full blocks reject overflow before changing their retained endpoint', () => {
  assert.equal(typeof S.createSampler, 'function');
  const sampler = S.createSampler(point(0, 0, 0), U.SCALE);
  for (let i = 1; i <= 240; i++) sampler.push(point(i, i / 240, i));
  assert.equal(sampler.size, 241);
  assert.throws(() => sampler.push(point(241, 241 / 240, 241)), /flush|full|capacity/i);
  assert.equal(sampler.size, 241);
  assert.deepEqual(sampler.flush().map(p => p.tick), [240]);
  assert.equal(sampler.size, 1);
  sampler.push(point(241, 241 / 240, 241));
  assert.deepEqual(sampler.flush().map(p => p.tick), [241]);
});

test('relative mode scales the vector error at each raw speed while strict mode stays absolute', () => {
  const calibration = {version:'fixture', kmPerUnit:1, kmSPerUnit:1};
  const interior = point(1, 0.5, 0, 0, 1000.5);
  for (const [options, ticks] of [[{},[2]], [{velocityRelativeTolerance:0},[1,2]]]) {
    const sampler = S.createSampler(point(0,0,0,0,1000),calibration,options);
    sampler.push(interior); sampler.push(point(2,1,0,0,1000));
    assert.deepEqual(sampler.flush().map(p => p.tick), ticks);
  }
  // A large endpoint speed cannot raise the tolerance for a nearly stationary
  // interior state: its own raw speed determines the floor.
  const reversal = S.createSampler(point(0,0,0,0,10000),calibration);
  reversal.push(point(1,0.5,0,0,0.11)); reversal.push(point(2,1,0,0,-10000));
  assert.deepEqual(reversal.flush().map(p => p.tick), [1,2]);
  for (const [speed,ticks] of [[0,[2]],[0.09,[2]],[0.11,[1,2]]]) {
    const slow = S.createSampler(point(0,0,0),calibration);
    slow.push(point(1,0.5,0,0,speed)); slow.push(point(2,1,0));
    assert.deepEqual(slow.flush().map(p => p.tick), ticks);
  }
});

test('relative policy validates its range and pins explicit options', () => {
  for (const invalid of [-0.001,0.0101,NaN,Infinity,'0.001',null]) {
    assert.throws(() => S.policyFor(U.SCALE,{velocityRelativeTolerance:invalid}), /relative/i);
    assert.throws(() => S.createSampler(point(0,0,0),U.SCALE,{velocityRelativeTolerance:invalid}), /relative/i);
  }
  assert.equal(S.policyFor(U.SCALE).velocityRelativeTolerance,0.001);
  assert.equal(S.policyFor(U.SCALE,{velocityRelativeTolerance:0}).velocityRelativeTolerance,0);
  assert.equal(S.policyFor(U.SCALE,{velocityRelativeTolerance:0.01}).velocityRelativeTolerance,0.01);
  const options = {velocityRelativeTolerance:0};
  const sampler = S.createSampler(point(0,0,0,0,1000),{version:'fixture',kmPerUnit:1,kmSPerUnit:1},options);
  options.velocityRelativeTolerance = 0.01;
  sampler.push(point(1,0.5,0,0,1000.5)); sampler.push(point(2,1,0,0,1000));
  assert.deepEqual(sampler.flush().map(p => p.tick),[1,2]);
});

function sampleOrbit(radius, speed, directionDeg, maxTicks, options = {velocityRelativeTolerance:0}) {
  const state = M.createState({name:'sampler fixture', position:{x:radius,y:0},
    massKg:1000, speed, directionDeg}, {continuousTracking:true});
  const raw = [{...M.snapshot(state),kind:'birth'}];
  const sampler = S.createSampler(raw[0], U.SCALE, options), retained = [raw[0]];
  for (let i = 0; i < maxTicks && state.status === 'active'; i++) {
    M.step(state); const snapshot = M.snapshot(state); raw.push(snapshot); sampler.push(snapshot);
    if (sampler.size === 241) retained.push(...sampler.flush());
  }
  retained.push(...sampler.flush());
  return {raw,retained,state};
}
function reconstructionErrors(raw, retained, relative = 0) {
  let segment = 0, positionKm = 0, velocityKmS = 0, velocityToleranceRatio = 0;
  for (const p of raw) {
    while (segment + 1 < retained.length - 1 && retained[segment + 1].elapsedSeconds < p.elapsedSeconds) segment++;
    const a = retained[segment], b = retained[Math.min(segment + 1, retained.length - 1)];
    const dt = b.elapsedSeconds - a.elapsedSeconds;
    const fraction = dt === 0 ? 0 : (p.elapsedSeconds - a.elapsedSeconds) / dt;
    const interpolate = field => a[field] + (b[field] - a[field]) * fraction;
    positionKm = Math.max(positionKm, Math.hypot(p.x - interpolate('x'), p.y - interpolate('y')) * U.SCALE.kmPerUnit);
    const velocityError = Math.hypot(p.vx - interpolate('vx'), p.vy - interpolate('vy')) * U.SCALE.kmSPerUnit;
    velocityKmS = Math.max(velocityKmS,velocityError);
    const allowed = Math.max(0.1,relative * Math.hypot(p.vx,p.vy) * U.SCALE.kmSPerUnit);
    velocityToleranceRatio = Math.max(velocityToleranceRatio,velocityError / allowed);
  }
  return {positionKm,velocityKmS,velocityToleranceRatio};
}
const scenarios = [
  ['far full orbit',2000,M.circularSpeed(2000),90,Math.ceil(2 * Math.PI * 2000 / M.circularSpeed(2000) * 240)],
  ['circular two orbits',330,M.circularSpeed(330),90,Math.ceil(4 * Math.PI * 330 / M.circularSpeed(330) * 240)],
  ['near full orbit',100,M.circularSpeed(100),90,Math.ceil(2 * Math.PI * 100 / M.circularSpeed(100) * 240)],
  ['capture',100,0,0,2400]
];
for (const [name,radius,speed,direction,ticks] of scenarios) {
  test(`240 Hz ${name} reconstructs every raw state within both physical tolerances`, t => {
    assert.equal(typeof S.createSampler, 'function');
    const result = sampleOrbit(radius,speed,direction,ticks);
    const errors = reconstructionErrors(result.raw,result.retained);
    assert.ok(errors.positionKm <= 0.1 + 1e-10, `position ${errors.positionKm} km`);
    assert.ok(errors.velocityKmS <= 0.1 + 1e-10, `velocity ${errors.velocityKmS} km/s`);
    assert.deepEqual(result.retained.at(-1), result.raw.at(-1));
    assert.ok(result.retained.length <= result.raw.length);
    if (name === 'far full orbit') assert.ok(result.retained.length < result.raw.length / 20);
    if (name === 'capture') assert.equal(result.retained.at(-1).kind, 'captured');
    t.diagnostic(JSON.stringify({mode:'strict-absolute',scenario:name,rawPoints:result.raw.length,
      oldPoints:originalSampling(result.raw).length,retainedPoints:result.retained.length,...errors}));
  });
}

// Original engine sampling, including a final checkpoint endpoint. This is a
// point-count baseline, not an assertion that the old points meet new bounds.
function originalSampling(raw) {
  const result = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const p = raw[i], last = result.at(-1), dt = p.elapsedSeconds - last.elapsedSeconds;
    const curved = Math.hypot(p.x - last.x - last.vx * dt,p.y - last.y - last.vy * dt) > 0.5;
    if (p.kind !== 'sample' || dt >= 1 - 1e-9 || Math.hypot(p.x,p.y) < 4 * M.MODEL.rs || curved) result.push(p);
  }
  if (result.at(-1) !== raw.at(-1)) result.push(raw.at(-1));
  return result;
}
for (const [name,radius,speed,direction,ticks] of scenarios) {
  test(`relative 0.1% ${name} meets raw-state bounds and reports original sampling comparison`, t => {
    const result = sampleOrbit(radius,speed,direction,ticks,{velocityRelativeTolerance:0.001});
    const errors = reconstructionErrors(result.raw,result.retained,0.001);
    assert.ok(errors.positionKm <= 0.1 + 1e-10,`position ${errors.positionKm} km`);
    assert.ok(errors.velocityToleranceRatio <= 1 + 1e-10,`velocity tolerance ratio ${errors.velocityToleranceRatio}`);
    assert.deepEqual(result.retained.at(-1),result.raw.at(-1));
    const old = originalSampling(result.raw);
    if (name === 'circular two orbits') assert.ok(result.retained.length < old.length, `circle ${result.retained.length} >= old ${old.length}`);
    if (name === 'near full orbit') assert.ok(result.retained.length < old.length / 2);
    t.diagnostic(JSON.stringify({mode:'relative-0.001',scenario:name,rawPoints:result.raw.length,
      oldPoints:old.length,retainedPoints:result.retained.length,...errors}));
  });
}
