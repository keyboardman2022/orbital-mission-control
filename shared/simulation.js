(function (root, factory) {
  'use strict';
  const commonJS = typeof module === 'object' && module.exports;
  const api = factory(commonJS ? require('./units.js') : root.OrbitalUnits,
    commonJS ? require('./world-generator.js') : root.OrbitalWorldGenerator);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OrbitalModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRuntime(units, generator, world) {
  'use strict';
  // Paczynski–Wiita test particles; scene units, not relativistic geodesics.
  const sweepSpeed=150,sweepSeconds=600,observationRadius=sweepSpeed*sweepSeconds;
  const centralMu=2000000,schwarzschildRadius=66,tickRate=240;
  if(world&&world.version!==generator.VERSION)throw new RangeError('此种子地图版本暂不受支持');
  const muPerSolarMass=generator?.MU_PER_SOLAR_MASS;
  const star=(id,name,orbitRadius,massRatio,collisionRadius,phase,color)=>{
    const angularSpeed=Math.sqrt(centralMu*orbitRadius)/(orbitRadius-schwarzschildRadius)/orbitRadius;
    return Object.freeze({id,name,orbitRadius,massRatio,mu:centralMu*massRatio,collisionRadius,
      softening:collisionRadius*.5,phase,angularSpeed,periodTicks:2*Math.PI/angularSpeed*tickRate,color});
  };
  const stars=world?Object.freeze([]):Object.freeze([
    star('ember','烬星',650,.006,12,.55,'#ffb36b'),
    star('aurora','曙光',1350,.018,20,1.9,'#fff1a8'),
    star('cyan','青曜',2800,.055,28,3.4,'#b8e7ff'),
    star('giant','赤巨星',5200,.12,52,5,'#ff805d'),
    star('ivory','白矮星',9500,.09,10,.2,'#f4f7ff'),
    star('cinder','暮焰',17000,.012,16,2.6,'#e86e50'),
    star('sapphire','蓝巨星',30000,.18,64,4.15,'#78bfff'),
    star('helios','耀阳',50000,.22,72,5.45,'#ffe27a'),
    star('colossus','绯红超巨星',76000,.28,86,1.25,'#ff5f67')
  ]);
  const MODEL = Object.freeze({
    version: world?'seeded-pw-2d-v1':'pw-2d-v3', mu: world?0:centralMu, rs: world?0:schwarzschildRadius, captureRadius: world?0:69.3,
    tickRate, step: 1 / tickRate, stars,
    dynamics: Object.freeze(world?{version:'seeded-multi-attractor-v1',maxMassKg:1e30,
      referenceFrame:'world origin; +Y up',approximation:'prescribed body orbits, PW black holes and softened Newtonian stars and planets'
    }:{version:'multi-attractor-pw-v1',legacyVersion:'two-body-pw-v1',maxMassKg:1e30,centralMassKg:units.centralMassKg,
      referenceFrame:'satellite position and velocity relative to the fixed central black hole',
      approximation:'finite-mass PW black hole plus prescribed Newtonian stellar attractors; not GR, no star-star or satellite-satellite forces'}),
    observation:Object.freeze({version:'sweep-10min-v2',sweepSpeed,sweepSeconds,radius:world?.radius??observationRadius,endReason:'out_of_observable'}),
    limits: Object.freeze({ maxRadius: world?.radius??observationRadius, maxSpeed: 1000, maxMassKg: 1e12, minRadius: world?0:80 }),
    calibration: units?.SCALE,
    units: Object.freeze({ length: 'scene length', time: 'simulation second', mass: 'kg', speed: 'scene length / simulation second', angle: 'degrees; +X = 0, counterclockwise; +Y up' })
  });
  const holes=world?world.systems.flatMap(system=>system.bodies.filter(body=>body.kind==='blackHole').map(body=>({x:system.x,y:system.y,radius:body.radius}))):[];
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
    if(input.dynamicsVersion!==undefined&&![MODEL.dynamics.version,MODEL.dynamics.legacyVersion].includes(input.dynamicsVersion))fail('Dynamics version conflict',409);
    if (typeof input.name !== 'string' || (!input.name.trim()&&!input.dynamicsVersion) || Array.from(input.name.trim()).length > 64) fail('Name must contain at most 64 characters; leave blank for automatic naming');
    const { massKg, speed, directionDeg } = input;
    const { x, y } = input.position || {};
    if (![x, y, massKg, speed, directionDeg].every(Number.isFinite)) fail('All numeric parameters must be finite numbers');
    const r = Math.hypot(x, y), limits = MODEL.limits;
    if (r < limits.minRadius || r > limits.maxRadius) fail('Position is outside the validated launch range');
    if (holes.some(hole=>Math.hypot(x-hole.x,y-hole.y)<=hole.radius*1.05)) fail('位置在黑洞捕获面内，无法发射');
    if (massKg <= 0 || massKg > (input.dynamicsVersion?MODEL.dynamics.maxMassKg:limits.maxMassKg)) fail('Mass is outside the validated range');
    if (speed < 0 || speed > limits.maxSpeed) fail('Speed is outside the validated range');
    const angle = ((directionDeg % 360) + 360) % 360, radians = angle * Math.PI / 180;
    return { name: input.name.trim(), position: { x, y }, massKg, speed, directionDeg: angle,
      vx: speed * Math.cos(radians), vy: speed * Math.sin(radians), modelVersion: MODEL.version,
      ...(world?{dynamicsVersion:MODEL.dynamics.version}:input.dynamicsVersion?{dynamicsVersion:input.dynamicsVersion}:{}),
      ...(input.calibration?.version === units?.SCALE.version ? {calibration:units.SCALE} : {}) };
  }
  function createState(initial, options = {}) {
    const p = validateLaunch(initial);
    return { x: p.position.x, y: p.position.y, vx: p.vx, vy: p.vy, tick: 0,
      status: 'active', elapsedSeconds: 0, escapeRadius: Math.max(1200, Math.hypot(p.position.x, p.position.y) * 3), event: null,
      ...(p.dynamicsVersion?{gravitationalMu:effectiveMu(p.massKg),dynamicsVersion:p.dynamicsVersion}:{}),
      ...(p.dynamicsVersion===MODEL.dynamics.version?{fieldTick:Number.isFinite(options.fieldTick)?options.fieldTick:0}:{}),
      ...(options.continuousTracking ? {continuousTracking:true} : {}) };
  }
  function effectiveMu(massKg) {return world?centralMu*massKg/units.centralMassKg:MODEL.mu*(1+massKg/units.centralMassKg);}
  function circularSpeed(r,mu=MODEL.mu,rs=MODEL.rs) { return Math.sqrt(mu * r) / (r - rs); }
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
  function escapeSpeed(r,mu=MODEL.mu,rs=MODEL.rs) { return Math.sqrt(2 * mu / (r - rs)); }
  const stellarTickCache=new Map();
  function stellarBodiesAtTick(fieldTick=0) {
    if(Number.isSafeInteger(fieldTick)&&stellarTickCache.has(fieldTick))return stellarTickCache.get(fieldTick);
    const seconds=fieldTick/MODEL.tickRate;
    const bodies=Object.freeze(world?world.systems.flatMap(system=>generator.bodyPositions(system,seconds).map(body=>{
      const rs=body.kind==='blackHole'?body.radius:0;
      return Object.freeze({...body,rs,mu:muPerSolarMass*body.massSolar,
        collisionRadius:rs?1.05*rs:body.radius,softening:body.radius*.5});
    })):MODEL.stars.map(star=>{
      const angle=star.phase+star.angularSpeed*seconds;
      return Object.freeze({...star,angle,x:Math.cos(angle)*star.orbitRadius,y:Math.sin(angle)*star.orbitRadius});
    }));
    if(Number.isSafeInteger(fieldTick)){
      stellarTickCache.set(fieldTick,bodies);
      while(stellarTickCache.size>4)stellarTickCache.delete(stellarTickCache.keys().next().value);
    }
    return bodies;
  }
  function energy(s,bodies) {
    if(world){
      let value=(s.vx*s.vx+s.vy*s.vy)/2;
      for(const body of bodies||stellarBodiesAtTick(s.fieldTick)){
        const r=Math.hypot(s.x-body.x,s.y-body.y);
        value-=body.rs?(body.mu+(s.gravitationalMu??0))/Math.max(r-body.rs,body.rs*.05):body.mu/Math.hypot(r,body.softening);
      }
      return value;
    }
    let value=(s.vx * s.vx + s.vy * s.vy) / 2 - (s.gravitationalMu??MODEL.mu) / (Math.hypot(s.x, s.y) - MODEL.rs);
    if(s.dynamicsVersion===MODEL.dynamics.version){
      for(const star of bodies||stellarBodiesAtTick(s.fieldTick))value-=star.mu/Math.sqrt((s.x-star.x)**2+(s.y-star.y)**2+star.softening**2);
    }
    return value;
  }
  function angularMomentum(s) { return s.x * s.vy - s.y * s.vx; }
  function acceleration(x, y,mu=MODEL.mu) {
    const r = Math.hypot(x, y), factor = -mu / (r * (r - MODEL.rs) ** 2);
    return { x: x * factor, y: y * factor };
  }
  function fieldAcceleration(x,y,fieldTick,mu=MODEL.mu,dynamicsVersion=MODEL.dynamics.version,bodies){
    const result=world?{x:0,y:0}:acceleration(x,y,mu);
    if(dynamicsVersion!==MODEL.dynamics.version)return result;
    for(const star of bodies||stellarBodiesAtTick(fieldTick)){
      const dx=star.x-x,dy=star.y-y,distanceSquared=dx*dx+dy*dy+star.softening**2;
      const distance=star.rs?Math.hypot(dx,dy):0;
      const factor=star.rs?(star.mu+mu)/(Math.max(distance,star.rs)*Math.max(distance-star.rs,star.rs*.05)**2):star.mu/distanceSquared**1.5;
      result.x+=dx*factor;result.y+=dy*factor;
    }
    return result;
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
  function finish(s, type, fraction, oldTick,extra={}) {
    s.status = type;
    s.tick = oldTick + 1;
    s.elapsedSeconds = (oldTick + fraction) / MODEL.tickRate;
    if(s.dynamicsVersion===MODEL.dynamics.version)s.fieldTick=extra.fieldTick??s.fieldTick+fraction;
    s.event = { type, substepFraction: fraction, x: s.x, y: s.y, elapsedSeconds: s.elapsedSeconds,...extra,
      ...(s.dynamicsVersion===MODEL.dynamics.version?{fieldTick:s.fieldTick}:{}) };
    return s;
  }
  function stellarCollision(x,y,nx,ny,startTick,endTick,startBodies,endBodies){
    const start=startBodies||stellarBodiesAtTick(startTick),end=endBodies||stellarBodiesAtTick(endTick);
    let first=null;
    for(let i=0;i<start.length;i++){
      const a=start[i],b=end[i],startX=x-a.x,startY=y-a.y,endX=nx-b.x,endY=ny-b.y;
      const fraction=Math.hypot(startX,startY)<=a.collisionRadius?0:crossing(startX,startY,endX,endY,a.collisionRadius,false);
      if(fraction!==null&&(!first||fraction<first.fraction))first={fraction,star:a,endStar:b};
    }
    return first;
  }
  function step(s) {
    if (s.status !== 'active') return s;
    const oldTick = s.tick,multi=s.dynamicsVersion===MODEL.dynamics.version,fieldTick=multi?s.fieldTick:0;
    if(multi&&(!Number.isFinite(fieldTick)||fieldTick<0))return finish(s,'error',0,Number.isSafeInteger(oldTick)&&oldTick>=0?oldTick:0);
    const startStars=multi?stellarBodiesAtTick(fieldTick):null;
    if (![s.x, s.y, s.vx, s.vy, s.escapeRadius, energy(s,startStars)].every(Number.isFinite) || !Number.isSafeInteger(oldTick) || oldTick < 0 || oldTick >= Number.MAX_SAFE_INTEGER) {
      return finish(s, 'error', 0, Number.isSafeInteger(oldTick) && oldTick >= 0 ? oldTick : 0);
    }
    if(Math.hypot(s.x,s.y)>MODEL.observation.radius)return finish(s,'out_of_observable',0,oldTick);
    const initialStarCollision=multi?stellarCollision(s.x,s.y,s.x,s.y,fieldTick,fieldTick,startStars,startStars):null;
    if(initialStarCollision){
      const star=initialStarCollision.star;
      return finish(s,'captured',0,oldTick,{bodyType:star.rs?'black-hole':star.kind??'star',bodyId:star.id,bodyName:star.name,bodyX:star.x,bodyY:star.y,fieldTick});
    }
    const forceVersion=s.dynamicsVersion??MODEL.dynamics.legacyVersion;
    const dt = MODEL.step,mu=s.gravitationalMu??MODEL.mu, a = fieldAcceleration(s.x,s.y,fieldTick,mu,forceVersion,startStars);
    const hx = s.vx + a.x * dt / 2, hy = s.vy + a.y * dt / 2;
    const nx = s.x + hx * dt, ny = s.y + hy * dt;
    if (![hx, hy, nx, ny].every(Number.isFinite)) return finish(s, 'error', 0, oldTick);
    const endStars=multi?stellarBodiesAtTick(fieldTick+1):null;
    const holeCapture = world?null:crossing(s.x, s.y, nx, ny, MODEL.captureRadius, false);
    const starCapture=multi?stellarCollision(s.x,s.y,nx,ny,fieldTick,fieldTick+1,startStars,endStars):null;
    const capture=holeCapture!==null&&(!starCapture||holeCapture<=starCapture.fraction)?{fraction:holeCapture,bodyType:'black-hole',bodyId:'black-hole',bodyName:'中心黑洞'}:starCapture?{...starCapture,bodyType:starCapture.star.rs?'black-hole':starCapture.star.kind??'star',bodyId:starCapture.star.id,bodyName:starCapture.star.name}:null;
    if (capture) {
      const fraction=capture.fraction,x = s.x + (nx - s.x) * fraction, y = s.y + (ny - s.y) * fraction;
      const collisionTick=fieldTick+fraction;
      const b = fieldAcceleration(x,y,collisionTick,mu,forceVersion), h = dt * fraction;
      const vx = s.vx + (a.x + b.x) * h / 2, vy = s.vy + (a.y + b.y) * h / 2;
      if (![x, y, vx, vy].every(Number.isFinite)) return finish(s, 'error', 0, oldTick);
      Object.assign(s, { x, y, vx, vy });
      const bodyX=capture.star?capture.star.x+(capture.endStar.x-capture.star.x)*fraction:0;
      const bodyY=capture.star?capture.star.y+(capture.endStar.y-capture.star.y)*fraction:0;
      return finish(s, 'captured', fraction, oldTick,{bodyType:capture.bodyType,bodyId:capture.bodyId,bodyName:capture.bodyName,bodyX,bodyY,fieldTick:collisionTick});
    }
    const b = fieldAcceleration(nx,ny,fieldTick+1,mu,forceVersion,endStars), vx = hx + b.x * dt / 2, vy = hy + b.y * dt / 2;
    const next = { x: nx, y: ny, vx, vy,...(s.gravitationalMu!==undefined?{gravitationalMu:mu,dynamicsVersion:s.dynamicsVersion}:{}),...(multi?{fieldTick:fieldTick+1}:{}) };
    if (![vx, vy, energy(next,endStars)].every(Number.isFinite)) return finish(s, 'error', 0, oldTick);
    if(Math.hypot(nx,ny)>MODEL.observation.radius){
      const fraction=crossing(s.x,s.y,nx,ny,MODEL.observation.radius,true)??1;
      const x=s.x+(nx-s.x)*fraction,y=s.y+(ny-s.y)*fraction,boundaryAcceleration=fieldAcceleration(x,y,fieldTick+fraction,mu,forceVersion),h=dt*fraction;
      Object.assign(s,{x,y,vx:s.vx+(a.x+boundaryAcceleration.x)*h/2,vy:s.vy+(a.y+boundaryAcceleration.y)*h/2});
      return finish(s,'out_of_observable',fraction,oldTick,multi?{fieldTick:fieldTick+fraction}:{});
    }
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
  return Object.freeze({ MODEL, createRuntime:world=>createRuntime(units,generator,world), validateLaunch, createState, step, effectiveMu, acceleration, fieldAcceleration, stellarBodiesAtTick, circularSpeed, circularRadiusForPeriod, escapeSpeed, energy, angularMomentum, snapshot });
});
