(function (root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports ? require('./units.js') : root.OrbitalUnits);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OrbitalModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (units) {
  'use strict';
  // Paczynski–Wiita test particles; scene units, not relativistic geodesics.
  const MODEL = Object.freeze({
    version: 'pw-2d-v1', mu: 2000000, rs: 66, captureRadius: 69.3,
    tickRate: 240, step: 1 / 240,
    dynamics: Object.freeze({version:'two-body-pw-v1',maxMassKg:1e30,centralMassKg:units.centralMassKg,
      referenceFrame:'satellite position and velocity relative to its independent black hole',
      approximation:'finite-mass extension of PW pair potential; not GR, no satellite-satellite forces'}),
    limits: Object.freeze({ maxRadius: 1e9, maxSpeed: 1000, maxMassKg: 1e12, minRadius: 80 }),
    calibration: units?.SCALE,
    units: Object.freeze({ length: 'scene length', time: 'simulation second', mass: 'kg', speed: 'scene length / simulation second', angle: 'degrees; +X = 0, counterclockwise; +Y up' })
  });
  function fail(message, status = 422) { const e = new Error(message); e.status = status; throw e; }
  function validateLaunch(input) {
    if (!input || typeof input !== 'object') fail('Launch parameters are required');
    if (input.unitSystem !== undefined && input.unitSystem !== 'si-km-v1') fail('Unknown launch unit system');
    if (input.unitSystem === 'si-km-v1') {
      if (input.calibrationVersion !== undefined && input.calibrationVersion !== units?.SCALE.version) fail('物理标定版本不一致，请刷新页面',409);
      if (![input.position?.x,input.position?.y].every(Number.isFinite)) fail('坐标必须是有限的 km 数值');
      if (!units || !Number.isFinite(input.speed) || input.speed < 0 || input.speed >= units.C_KM_S) fail('初速度必须是有限的 km/s 数值，且小于光速 299792.458 km/s');
      const normalized = validateLaunch({...input, unitSystem:undefined,
        position:{x:units.fromKm(input.position?.x),y:units.fromKm(input.position?.y)},speed:units.fromKmS(input.speed)});
      return {...normalized,calibration:units.SCALE};
    }
    if (input.modelVersion !== undefined && input.modelVersion !== MODEL.version) fail('Model version conflict', 409);
    if(input.dynamicsVersion!==undefined&&input.dynamicsVersion!==MODEL.dynamics.version)fail('Dynamics version conflict',409);
    if (typeof input.name !== 'string' || (!input.name.trim()&&!input.dynamicsVersion) || Array.from(input.name.trim()).length > 64) fail('Name must contain at most 64 characters; leave blank for automatic naming');
    const { massKg, speed, directionDeg } = input;
    const { x, y } = input.position || {};
    if (![x, y, massKg, speed, directionDeg].every(Number.isFinite)) fail('All numeric parameters must be finite numbers');
    const r = Math.hypot(x, y), limits = MODEL.limits;
    if (r < limits.minRadius || r > limits.maxRadius || r <= MODEL.captureRadius) fail('Position is outside the validated launch range');
    if (massKg <= 0 || massKg > (input.dynamicsVersion?MODEL.dynamics.maxMassKg:limits.maxMassKg)) fail('Mass is outside the validated range');
    if (speed < 0 || speed > limits.maxSpeed) fail('Speed is outside the validated range');
    const angle = ((directionDeg % 360) + 360) % 360, radians = angle * Math.PI / 180;
    return { name: input.name.trim(), position: { x, y }, massKg, speed, directionDeg: angle,
      vx: speed * Math.cos(radians), vy: speed * Math.sin(radians), modelVersion: MODEL.version,
      ...(input.dynamicsVersion?{dynamicsVersion:input.dynamicsVersion}:{}),
      ...(input.calibration?.version === units?.SCALE.version ? {calibration:units.SCALE} : {}) };
  }
  function createState(initial, options = {}) {
    const p = validateLaunch(initial);
    return { x: p.position.x, y: p.position.y, vx: p.vx, vy: p.vy, tick: 0,
      status: 'active', elapsedSeconds: 0, escapeRadius: Math.max(1200, Math.hypot(p.position.x, p.position.y) * 3), event: null,
      ...(p.dynamicsVersion?{gravitationalMu:effectiveMu(p.massKg),dynamicsVersion:p.dynamicsVersion}:{}),
      ...(options.continuousTracking ? {continuousTracking:true} : {}) };
  }
  function effectiveMu(massKg) {return MODEL.mu*(1+massKg/units.centralMassKg);}
  function circularSpeed(r,mu=MODEL.mu) { return Math.sqrt(mu * r) / (r - MODEL.rs); }
  // Period is in simulation seconds (normal live playback uses one per wall second).
  // Solve on the stable circular-orbit branch; this is an observation criterion,
  // never a boundary of the gravitational field.
  function circularRadiusForPeriod(period,mu=MODEL.mu) {
    const stableRadius=3*MODEL.rs;
    const orbitPeriod=r=>2*Math.PI*r/circularSpeed(r,mu);
    if(!Number.isFinite(period)||!Number.isFinite(mu)||mu<=0||period<orbitPeriod(stableRadius))throw new RangeError('Period must admit a stable circular orbit');
    let low=stableRadius,high=stableRadius;
    while(orbitPeriod(high)<period)high*=2;
    for(let i=0;i<80;i++){const middle=(low+high)/2;if(orbitPeriod(middle)<period)low=middle;else high=middle;}
    return (low+high)/2;
  }
  function escapeSpeed(r,mu=MODEL.mu) { return Math.sqrt(2 * mu / (r - MODEL.rs)); }
  function energy(s) { return (s.vx * s.vx + s.vy * s.vy) / 2 - (s.gravitationalMu??MODEL.mu) / (Math.hypot(s.x, s.y) - MODEL.rs); }
  function angularMomentum(s) { return s.x * s.vy - s.y * s.vx; }
  function acceleration(x, y,mu=MODEL.mu) {
    const r = Math.hypot(x, y), factor = -mu / (r * (r - MODEL.rs) ** 2);
    return { x: x * factor, y: y * factor };
  }
  // Sorted roots detect an entering segment even when it exits on the far side.
  function crossing(x, y, nx, ny, radius, outward) {
    const dx = nx - x, dy = ny - y, a = dx * dx + dy * dy;
    if (!a) return null;
    const b = 2 * (x * dx + y * dy), c = x * x + y * y - radius * radius;
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return null;
    const u = (-b + (outward ? 1 : -1) * Math.sqrt(discriminant)) / (2 * a);
    return u >= 0 && u <= 1 ? u : null;
  }
  function finish(s, type, fraction, oldTick) {
    s.status = type;
    s.tick = oldTick + 1;
    s.elapsedSeconds = (oldTick + fraction) / MODEL.tickRate;
    s.event = { type, substepFraction: fraction, x: s.x, y: s.y, elapsedSeconds: s.elapsedSeconds };
    return s;
  }
  function step(s) {
    if (s.status !== 'active') return s;
    const oldTick = s.tick;
    if (![s.x, s.y, s.vx, s.vy, s.escapeRadius, energy(s)].every(Number.isFinite) || !Number.isSafeInteger(oldTick) || oldTick < 0 || oldTick >= Number.MAX_SAFE_INTEGER) {
      return finish(s, 'error', 0, Number.isSafeInteger(oldTick) && oldTick >= 0 ? oldTick : 0);
    }
    const dt = MODEL.step,mu=s.gravitationalMu??MODEL.mu, a = acceleration(s.x, s.y,mu);
    const hx = s.vx + a.x * dt / 2, hy = s.vy + a.y * dt / 2;
    const nx = s.x + hx * dt, ny = s.y + hy * dt;
    if (![hx, hy, nx, ny].every(Number.isFinite)) return finish(s, 'error', 0, oldTick);
    const capture = crossing(s.x, s.y, nx, ny, MODEL.captureRadius, false);
    if (capture !== null) {
      const x = s.x + (nx - s.x) * capture, y = s.y + (ny - s.y) * capture;
      const b = acceleration(x, y,mu), h = dt * capture;
      const vx = s.vx + (a.x + b.x) * h / 2, vy = s.vy + (a.y + b.y) * h / 2;
      if (![x, y, vx, vy].every(Number.isFinite)) return finish(s, 'error', 0, oldTick);
      Object.assign(s, { x, y, vx, vy });
      return finish(s, 'captured', capture, oldTick);
    }
    const b = acceleration(nx, ny,mu), vx = hx + b.x * dt / 2, vy = hy + b.y * dt / 2;
    const next = { x: nx, y: ny, vx, vy,...(s.gravitationalMu!==undefined?{gravitationalMu:mu}:{}) };
    if (![vx, vy, energy(next)].every(Number.isFinite)) return finish(s, 'error', 0, oldTick);
    if (!s.continuousTracking && Math.hypot(nx, ny) >= s.escapeRadius && nx * vx + ny * vy > 0 && energy(next) > 0) {
      const fraction = crossing(s.x, s.y, nx, ny, s.escapeRadius, true) ?? 1;
      Object.assign(s, { x: s.x + (nx - s.x) * fraction, y: s.y + (ny - s.y) * fraction,
        vx: s.vx + (vx - s.vx) * fraction, vy: s.vy + (vy - s.vy) * fraction });
      return finish(s, 'escaped', fraction, oldTick);
    }
    Object.assign(s, next);s.tick = oldTick + 1;s.elapsedSeconds = s.tick / MODEL.tickRate;
    return s;
  }
  function snapshot(s) {
    return { tick: s.tick, elapsedSeconds: s.elapsedSeconds, x: s.x, y: s.y, vx: s.vx, vy: s.vy,
      kind: s.status === 'active' ? 'sample' : s.status };
  }
  return Object.freeze({ MODEL, validateLaunch, createState, step, effectiveMu, acceleration, circularSpeed, circularRadiusForPeriod, escapeSpeed, energy, angularMomentum, snapshot });
});
