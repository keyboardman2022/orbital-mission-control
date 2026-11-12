(function (root, factory) {
  'use strict';
  const commonJS = typeof module === 'object' && module.exports;
  const api = factory(commonJS ? require('./units.js') : root.OrbitalUnits,
    commonJS ? require('./world-generator.js') : root.OrbitalWorldGenerator);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OrbitalModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRuntime(units, generator, world, bodyProvider, preparedBodies) {
  'use strict';
  // Paczynski–Wiita test particles; scene units, not relativistic geodesics.
  const sweepSpeed=150,sweepSeconds=600,observationRadius=sweepSpeed*sweepSeconds;
  const centralMu=2000000,schwarzschildRadius=66,tickRate=240;
  if(world&&world.version!==generator.VERSION)throw new RangeError('此种子地图版本暂不受支持');
  const muPerSolarMass=generator?.MU_PER_SOLAR_MASS;
  const dynamic=world?.motion===generator?.N_BODY_MOTION&&!!world?.motion;
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
    tickRate, step: 1 / tickRate, stars, launchReferenceVersion:1, simulationPauseVersion:1, launchPresetVersion:1,
    simulationRates:Object.freeze(dynamic?[1,2,4,8,16,32,64]:[1,2,4,8,16]),
    livePathAboveRate:16,
    dynamics: Object.freeze(world?{version:dynamic?'seeded-nbody-v1':'seeded-multi-attractor-v1',maxMassKg:1e30,
      referenceFrame:'world origin; +Y up',approximation:dynamic?'softened Newtonian interacting celestial bodies and passive satellites':'prescribed body orbits, PW black holes and softened Newtonian stars and planets'
    }:{version:'multi-attractor-pw-v1',legacyVersion:'two-body-pw-v1',maxMassKg:1e30,centralMassKg:units.centralMassKg,
      referenceFrame:'satellite position and velocity relative to the fixed central black hole',
      approximation:'finite-mass PW black hole plus prescribed Newtonian stellar attractors; not GR, no star-star or satellite-satellite forces'}),
    observation:Object.freeze({version:'sweep-10min-v2',sweepSpeed,sweepSeconds,radius:world?.radius??observationRadius,endReason:'out_of_observable'}),
    limits: Object.freeze({ maxRadius: world?.radius??observationRadius, maxSpeed: 1000, maxMassKg: 1e12, minRadius: world?0:80 }),
    calibration: units?.SCALE,
    units: Object.freeze({ length: 'scene length', time: 'simulation second', mass: 'kg', speed: 'scene length / simulation second', angle: 'degrees; +X = 0, counterclockwise; +Y up' })
  });
  const holes=world&&!dynamic?world.systems.flatMap(system=>system.bodies.filter(body=>body.kind==='blackHole').map(body=>({x:system.x,y:system.y,z:system.z??0,radius:body.radius}))):[];
  const radiusAt=(x,y,z)=>z===undefined?Math.hypot(x,y):Math.hypot(x,y,z);
  function fail(message, status = 422) { const e = new Error(message); e.status = status; throw e; }
  function validateLaunch(input) {
    if (!input || typeof input !== 'object') fail('Launch parameters are required');
    if (input.dimension !== undefined && ![2,3].includes(input.dimension)) fail('不支持的发射维度');
    const spatial=input.dimension===3;
    if (input.unitSystem !== undefined && input.unitSystem !== 'si-km-v1') fail('Unknown launch unit system');
    if (input.unitSystem === 'si-km-v1') {
      if (input.calibrationVersion !== undefined && input.calibrationVersion !== units?.SCALE.version) fail('物理标定版本不一致，请刷新页面',409);
      if (![input.position?.x,input.position?.y].every(Number.isFinite)||(spatial&&!Number.isFinite(input.position?.z))) fail('坐标必须是有限的 km 数值');
      if (!units || !Number.isFinite(input.speed) || input.speed < 0 || input.speed >= units.C_KM_S) fail('初速度必须是有限的 km/s 数值，且小于光速 299792.458 km/s');
      const normalized = validateLaunch({...input, unitSystem:undefined,
        position:{x:units.fromKm(input.position?.x),y:units.fromKm(input.position?.y),...(spatial?{z:units.fromKm(input.position.z)}:{})},speed:units.fromKmS(input.speed)});
      return {...normalized,calibration:units.SCALE};
    }
    if (input.modelVersion !== undefined && input.modelVersion !== MODEL.version) fail('Model version conflict', 409);
    if(input.dynamicsVersion!==undefined&&![MODEL.dynamics.version,MODEL.dynamics.legacyVersion].includes(input.dynamicsVersion))fail('Dynamics version conflict',409);
    if (typeof input.name !== 'string' || (!input.name.trim()&&!input.dynamicsVersion) || Array.from(input.name.trim()).length > 64) fail('Name must contain at most 64 characters; leave blank for automatic naming');
    const { massKg, speed, directionDeg } = input;
    const { x, y, z } = input.position || {};
    if(spatial&&(!Number.isFinite(z)||!Number.isFinite(input.pitchDeg)||Math.abs(input.pitchDeg)>90))fail('请输入有效 Z 坐标，俯仰角范围为 −90° 至 90°');
    if(spatial&&input.dynamicsVersion!==MODEL.dynamics.version)fail('3D 发射必须使用当前引力模型',409);
    if (![x, y, massKg, speed, directionDeg].every(Number.isFinite)) fail('All numeric parameters must be finite numbers');
    const r = radiusAt(x,y,spatial?z:undefined), limits = MODEL.limits;
    if (r < limits.minRadius || r > limits.maxRadius) fail('Position is outside the validated launch range');
    if (holes.some(hole=>radiusAt(x-hole.x,y-hole.y,spatial?z-hole.z:undefined)<=hole.radius*1.05)) fail('位置在黑洞捕获面内，无法发射');
    if (massKg <= 0 || massKg > (input.dynamicsVersion?MODEL.dynamics.maxMassKg:limits.maxMassKg)) fail('Mass is outside the validated range');
    if (speed < 0 || speed > limits.maxSpeed) fail('Speed is outside the validated range');
    const angle = ((directionDeg % 360) + 360) % 360, radians = angle * Math.PI / 180;
    const pitch=spatial?input.pitchDeg*Math.PI/180:0, horizontal=speed*Math.cos(pitch);
    return { name: input.name.trim(), position: { x, y, ...(spatial?{z}:{}) }, massKg, speed, directionDeg: angle,
      vx: horizontal * Math.cos(radians), vy: horizontal * Math.sin(radians), modelVersion: MODEL.version,
      ...(spatial?{dimension:3,pitchDeg:input.pitchDeg,vz:speed*Math.sin(pitch)}:{}),
      ...(world?{dynamicsVersion:MODEL.dynamics.version}:input.dynamicsVersion?{dynamicsVersion:input.dynamicsVersion}:{}),
      ...(input.calibration?.version === units?.SCALE.version ? {calibration:units.SCALE} : {}) };
  }
  function createState(initial, options = {}) {
    const p = validateLaunch(initial);
    return { x: p.position.x, y: p.position.y, vx: p.vx, vy: p.vy, tick: 0,
      ...(p.dimension===3?{z:p.position.z,vz:p.vz}:{}),
      status: 'active', elapsedSeconds: 0, escapeRadius: Math.max(1200,radiusAt(p.position.x,p.position.y,p.position.z)*3), event: null,
      ...(p.dynamicsVersion?{gravitationalMu:effectiveMu(p.massKg),dynamicsVersion:p.dynamicsVersion}:{}),
      ...(p.dynamicsVersion===MODEL.dynamics.version?{fieldTick:Number.isFinite(options.fieldTick)?options.fieldTick:0}:{}),
      ...(options.continuousTracking ? {continuousTracking:true} : {}) };
  }
  function effectiveMu(massKg) {return dynamic?0:world?centralMu*massKg/units.centralMassKg:MODEL.mu*(1+massKg/units.centralMassKg);}
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
  const centralBody={id:'black-hole',name:'黑洞',kind:'blackHole',x:0,y:0,z:0,rs:MODEL.rs,mu:0};
  function launchBodyAtTick(id,tick){
    if(!world&&id===centralBody.id)return centralBody;
    return stellarBodiesAtTick(tick,true).find(body=>body.id===id);
  }
  function resolveLaunch(input,tick){
    const {referenceBodyId,launchPreset:mode,...launch}=input;
    if(referenceBodyId===undefined){
      if(mode!==undefined)fail('请选择发射预设的基准天体');
      return input;
    }
    if(input.dimension!==3)fail('只有 3D 发射支持基准天体');
    const body=launchBodyAtTick(referenceBodyId,tick);
    if(!body)fail('当前地图中找不到发射基准天体');
    const {x,y,z}=input.position??{};
    if(![x,y,z].every(Number.isFinite))fail('请输入有效的相对坐标');
    const inKm=input.unitSystem==='si-km-v1';
    const convert=inKm?units.toKm:value=>value;
    const position={x:convert(body.x)+x,y:convert(body.y)+y,z:convert(body.z??0)+z};
    if(mode===undefined)return {...launch,position};
    if(!['orbit','escape','infall'].includes(mode))fail('未知的发射预设');
    const point=inKm?{x:units.fromKm(position.x),y:units.fromKm(position.y),z:units.fromKm(position.z)}:position;
    const reference=orbitReference(point,input.massKg,tick,referenceBodyId);
    const preset=launchPreset(point,reference,mode);
    if(!preset)fail('当前发射点无法使用该预设，请调整与基准天体的距离');
    return {...launch,position,...preset,speed:inKm?units.toKmS(preset.speed):preset.speed};
  }
  function orbitReference({x,y,z},massKg,tick=0,referenceBodyId){
    if(![x,y,z??0,massKg].every(Number.isFinite)||massKg<=0)return null;
    let nearest;
    const candidates=referenceBodyId!==undefined?[launchBodyAtTick(referenceBodyId,tick)]
      :world?stellarBodiesAtTick(tick,z!==undefined):[centralBody];
    for(const body of candidates){
      if(!body)continue;
      const radius=radiusAt(x-body.x,y-body.y,z===undefined?undefined:z-body.z);
      if(!nearest||radius<nearest.radius)nearest={...body,radius,rs:dynamic?0:body.rs,mu:body.mu+(body.rs?effectiveMu(massKg):0)};
    }
    if(!nearest||nearest.radius<=Math.max(1.05*(nearest.rs??0),nearest.collisionRadius??0))return null;
    const {radius,mu,rs}=nearest;
    if(referenceBodyId!==undefined&&z!==undefined&&!rs){
      const softenedDistance=Math.hypot(radius,nearest.softening??0);
      if(dynamic)return {...nearest,circular:Math.sqrt(mu)*radius/softenedDistance**1.5,escape:Math.sqrt(2*mu/softenedDistance),
        velocity:{x:nearest.vx,y:nearest.vy,z:nearest.vz}};
      const before=launchBodyAtTick(referenceBodyId,tick-.5),after=launchBodyAtTick(referenceBodyId,tick+.5);
      return {...nearest,circular:Math.sqrt(mu)*radius/softenedDistance**1.5,escape:Math.sqrt(2*mu/softenedDistance),
        velocity:{x:(after.x-before.x)*tickRate,y:(after.y-before.y)*tickRate,z:((after.z??0)-(before.z??0))*tickRate}};
    }
    return {...nearest,circular:circularSpeed(radius,mu,rs),escape:escapeSpeed(radius,mu,rs),
      ...(referenceBodyId!==undefined&&z!==undefined?{velocity:{x:0,y:0,z:0}}:{})};
  }
  function spatialLaunchPreset(position,reference,mode){
    const {radius,mu,rs=0,collisionRadius=0,softening=0,velocity}=reference;
    const dx=position.x-reference.x,dy=position.y-reference.y,dz=position.z-(reference.z??0);
    const horizontal=Math.hypot(dx,dy);
    const tangentX=horizontal?-dy/horizontal:0,tangentY=horizontal?dx/horizontal:1;
    let radialSpeed=0,tangentialSpeed=reference.circular;
    if(mode==='orbit'&&radius<3*rs)return null;
    if(mode==='escape'){
      radialSpeed=1.1*reference.escape;
      tangentialSpeed=0;
    }
    if(mode==='infall'){
      // At a parabolic flyby's closest point, all speed is tangential.
      const safeRadius=Math.max(collisionRadius,2*rs);
      if(radius<=safeRadius)return null;
      const periapsis=Math.min(1.1*safeRadius,(safeRadius+radius)/2);
      const potentialDistance=rs?periapsis-rs:Math.hypot(periapsis,softening);
      tangentialSpeed=periapsis/radius*Math.sqrt(2*mu/potentialDistance);
      radialSpeed=-Math.sqrt(Math.max(0,reference.escape**2-tangentialSpeed**2));
    }
    const vx=velocity.x+radialSpeed*dx/radius+tangentialSpeed*tangentX;
    const vy=velocity.y+radialSpeed*dy/radius+tangentialSpeed*tangentY;
    const vz=velocity.z+radialSpeed*dz/radius;
    return {speed:Math.hypot(vx,vy,vz),directionDeg:(Math.atan2(vy,vx)*180/Math.PI+360)%360,
      pitchDeg:Math.atan2(vz,Math.hypot(vx,vy))*180/Math.PI};
  }
  function launchPreset(position,reference,mode){
    const distance=radiusAt(position.x,position.y,position.z);
    if(!reference||distance<MODEL.limits.minRadius||distance>MODEL.limits.maxRadius)return null;
    if(reference.velocity)return spatialLaunchPreset(position,reference,mode);
    const speed=mode==='escape'?reference.escape*1.1:reference.circular*(mode==='infall'?.45:1);
    const radial=Math.atan2(position.y-reference.y,position.x-reference.x);
    const offset=mode==='escape'?20:mode==='infall'?150:90;
    if(position.z===undefined)return {speed,directionDeg:(radial*180/Math.PI+offset+360)%360};
    const rise=(position.z-(reference.z??0))/reference.radius;
    const tilt=Math.asin(Math.max(-1,Math.min(1,rise)));
    const turn=offset*Math.PI/180;
    const direction=radial+Math.atan2(Math.sin(turn),Math.cos(tilt)*Math.cos(turn));
    return {speed,directionDeg:(direction*180/Math.PI+360)%360,
      pitchDeg:Math.asin(Math.sin(tilt)*Math.cos(turn))*180/Math.PI};
  }
  const stellarTickCache=new Map(),spatialTickCache=new Map();
  const initialField=dynamic?world.systems.flatMap(system=>generator.bodyPositions(system)):null;
  const dynamicCache=new WeakMap();
  let spatialPlanes;
  function planesForWorld(){
    if(!spatialPlanes){
      spatialPlanes=world?generator.worldOrbitalPlanes(world):new Map(MODEL.stars.map(star=>
        [star.id,generator.orbitalPlane(`classic\0${star.id}`)]));
    }
    return spatialPlanes;
  }
  function stellarBodiesAtTick(fieldTick=0,spatial=false) {
    if(dynamic){
      const supplied=bodyProvider?.(fieldTick);
      if(preparedBodies&&supplied)return supplied;
      const source=supplied??initialField;
      if(!dynamicCache.has(source))dynamicCache.set(source,Object.freeze(source.map(body=>Object.freeze({...body,
        massSolar:body.mass??body.massSolar,mu:muPerSolarMass*(body.mass??body.massSolar),
        rs:body.kind==='blackHole'?body.radius:0,collisionRadius:body.radius,softening:generator.N_BODY_SOFTENING}))));
      return dynamicCache.get(source);
    }
    const cache=spatial?spatialTickCache:stellarTickCache;
    if(Number.isSafeInteger(fieldTick)&&cache.has(fieldTick))return cache.get(fieldTick);
    const seconds=fieldTick/MODEL.tickRate;
    const planes=spatial?planesForWorld():undefined;
    const bodies=Object.freeze(world?world.systems.flatMap(system=>generator.bodyPositions(system,seconds,planes).map(body=>{
      const rs=body.kind==='blackHole'?body.radius:0;
      return Object.freeze({...body,rs,mu:muPerSolarMass*body.massSolar,
        collisionRadius:rs?1.05*rs:body.radius,softening:body.radius*.5});
    })):MODEL.stars.map(star=>{
      const angle=star.phase+star.angularSpeed*seconds;
      if(spatial){
        const plane=planes.get(star.id);
        return Object.freeze({...star,angle,kind:'star',plane,orbit:{parentId:'black-hole',radius:star.orbitRadius},
          ...generator.orbitalOffset(star.orbitRadius,angle,plane)});
      }
      return Object.freeze({...star,angle,x:Math.cos(angle)*star.orbitRadius,y:Math.sin(angle)*star.orbitRadius});
    }));
    if(Number.isSafeInteger(fieldTick)){
      cache.set(fieldTick,bodies);
      while(cache.size>4)cache.delete(cache.keys().next().value);
    }
    return bodies;
  }
  function energy(s,bodies) {
    if(world){
      let value=(s.vx*s.vx+s.vy*s.vy+(s.vz??0)**2)/2;
      for(const body of bodies||stellarBodiesAtTick(s.fieldTick,s.z!==undefined)){
        const r=radiusAt(s.x-body.x,s.y-body.y,s.z===undefined?undefined:s.z-body.z);
        value-=body.rs&&!dynamic?(body.mu+(s.gravitationalMu??0))/Math.max(r-body.rs,body.rs*.05):body.mu/Math.hypot(r,body.softening);
      }
      return value;
    }
    let value=(s.vx * s.vx + s.vy * s.vy+(s.vz??0)**2) / 2 - (s.gravitationalMu??MODEL.mu) / (radiusAt(s.x,s.y,s.z) - MODEL.rs);
    if(s.dynamicsVersion===MODEL.dynamics.version){
      for(const star of bodies||stellarBodiesAtTick(s.fieldTick,s.z!==undefined))value-=star.mu/Math.sqrt((s.x-star.x)**2+(s.y-star.y)**2+(s.z===undefined?0:s.z-star.z)**2+star.softening**2);
    }
    return value;
  }
  function angularMomentum(s) { return s.x * s.vy - s.y * s.vx; }
  function acceleration(x, y,mu=MODEL.mu,z) {
    const r = radiusAt(x,y,z), factor = -mu / (r * (r - MODEL.rs) ** 2);
    return { x: x * factor, y: y * factor,...(z!==undefined?{z:z*factor}:{}) };
  }
  function fieldAcceleration(x,y,fieldTick,mu=MODEL.mu,dynamicsVersion=MODEL.dynamics.version,bodies,z){
    const result=world?{x:0,y:0,...(z!==undefined?{z:0}:{})}:acceleration(x,y,mu,z);
    if(dynamicsVersion!==MODEL.dynamics.version)return result;
    for(const star of bodies||stellarBodiesAtTick(fieldTick,z!==undefined)){
      const dx=star.x-x,dy=star.y-y,dz=z===undefined?undefined:star.z-z;
      const distanceSquared=dx*dx+dy*dy+(dz??0)**2+star.softening**2;
      const distance=star.rs&&!dynamic?radiusAt(dx,dy,dz):0;
      const factor=star.rs&&!dynamic?(star.mu+mu)/(Math.max(distance,star.rs)*Math.max(distance-star.rs,star.rs*.05)**2):star.mu/distanceSquared**1.5;
      result.x+=dx*factor;result.y+=dy*factor;
      if(dz!==undefined)result.z+=dz*factor;
    }
    return result;
  }
  // Sorted roots detect an entering segment even when it exits on the far side.
  function crossing(x, y, nx, ny, radius, outward,z=0,nz=0) {
    const dx = nx - x, dy = ny - y, dz=nz-z, a = dx * dx + dy * dy+dz*dz;
    if (!a) return null;
    const b = 2 * (x * dx + y * dy+z*dz), c = x * x + y * y+z*z - radius * radius;
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
    s.event = { type, substepFraction: fraction, x: s.x, y: s.y,...(s.z!==undefined?{z:s.z}:{}), elapsedSeconds: s.elapsedSeconds,...extra,
      ...(s.dynamicsVersion===MODEL.dynamics.version?{fieldTick:s.fieldTick}:{}) };
    return s;
  }
  function stellarCollision(x,y,nx,ny,startTick,endTick,startBodies,endBodies,z,nz){
    const start=startBodies||stellarBodiesAtTick(startTick,z!==undefined),end=endBodies||stellarBodiesAtTick(endTick,z!==undefined);
    let first=null;
    for(let i=0;i<start.length;i++){
      const a=start[i];
      const b=dynamic?(end[i]?.id===a.id?end[i]:end.find(body=>body.id===a.id)??a):end[i];
      const startX=x-a.x,startY=y-a.y,endX=nx-b.x,endY=ny-b.y;
      const startZ=z===undefined?undefined:z-a.z,endZ=nz===undefined?undefined:nz-b.z;
      if(dynamic){
        const reach=a.collisionRadius*(1+1e-12);
        // An entire relative segment outside the same slab cannot reach the sphere.
        if((startX>reach&&endX>reach)||(startX< -reach&&endX< -reach)||
          (startY>reach&&endY>reach)||(startY< -reach&&endY< -reach)||
          (startZ>reach&&endZ>reach)||(startZ< -reach&&endZ< -reach))continue;
      }
      const fraction=radiusAt(startX,startY,startZ)<=a.collisionRadius?0:crossing(startX,startY,endX,endY,a.collisionRadius,false,startZ,endZ);
      if(fraction!==null&&(!first||fraction<first.fraction))first={fraction,star:a,endStar:b};
    }
    return first;
  }
  const stepEnds=preparedBodies&&dynamic?new WeakMap():null;
  function hasFiniteEnergy(state,bodies){
    // Every prepared softened potential is bounded by mu / softening.
    if(!stepEnds||!bodies?.boundedEnergy)return Number.isFinite(energy(state,bodies));
    return Number.isFinite(state.x)&&Number.isFinite(state.y)&&Number.isFinite(state.z??0)&&
      Number.isFinite(state.vx*state.vx+state.vy*state.vy+(state.vz??0)**2);
  }
  function step(s) {
    if (s.status !== 'active') return s;
    const spatial=s.z!==undefined,z=spatial?s.z:0;
    const oldTick = s.tick,multi=s.dynamicsVersion===MODEL.dynamics.version,fieldTick=multi?s.fieldTick:0;
    if(multi&&(!Number.isFinite(fieldTick)||fieldTick<0))return finish(s,'error',0,Number.isSafeInteger(oldTick)&&oldTick>=0?oldTick:0);
    const startStars=multi?stellarBodiesAtTick(fieldTick,spatial):null;
    const forceVersion=s.dynamicsVersion??MODEL.dynamics.legacyVersion,mu=s.gravitationalMu??MODEL.mu;
    const previous=stepEnds?.get(s);
    const sameStart=previous&&previous.fieldTick===fieldTick&&previous.stars===startStars&&previous.mu===mu&&previous.forceVersion===forceVersion&&
      previous.x===s.x&&previous.y===s.y&&previous.z===s.z&&previous.vx===s.vx&&previous.vy===s.vy&&previous.vz===s.vz;
    if (![s.x, s.y, s.vx, s.vy, s.escapeRadius].every(Number.isFinite) ||
      (!sameStart&&!hasFiniteEnergy(s,startStars)) || (spatial&&![z,s.vz].every(Number.isFinite)) ||
      !Number.isSafeInteger(oldTick) || oldTick < 0 || oldTick >= Number.MAX_SAFE_INTEGER) {
      return finish(s, 'error', 0, Number.isSafeInteger(oldTick) && oldTick >= 0 ? oldTick : 0);
    }
    if(radiusAt(s.x,s.y,s.z)>MODEL.observation.radius)return finish(s,'out_of_observable',0,oldTick);
    const initialStarCollision=multi?stellarCollision(s.x,s.y,s.x,s.y,fieldTick,fieldTick,startStars,startStars,s.z,s.z):null;
    if(initialStarCollision){
      const star=initialStarCollision.star;
      return finish(s,'captured',0,oldTick,{bodyType:star.rs?'black-hole':star.kind??'star',bodyId:star.id,bodyName:star.name,bodyX:star.x,bodyY:star.y,...(spatial?{bodyZ:star.z}:{}),fieldTick});
    }
    const dt = MODEL.step,a=sameStart?previous.acceleration:fieldAcceleration(s.x,s.y,fieldTick,mu,forceVersion,startStars,s.z);
    const hx = s.vx + a.x * dt / 2, hy = s.vy + a.y * dt / 2;
    const nx = s.x + hx * dt, ny = s.y + hy * dt;
    const hz=spatial?s.vz+a.z*dt/2:0,nz=z+hz*dt;
    if (![hx, hy, nx, ny,nz].every(Number.isFinite)) return finish(s, 'error', 0, oldTick);
    const endStars=multi?stellarBodiesAtTick(fieldTick+1,spatial):null;
    const holeCapture = world?null:crossing(s.x,s.y,nx,ny,MODEL.captureRadius,false,z,nz);
    const starCapture=multi?stellarCollision(s.x,s.y,nx,ny,fieldTick,fieldTick+1,startStars,endStars,s.z,spatial?nz:undefined):null;
    const capture=holeCapture!==null&&(!starCapture||holeCapture<=starCapture.fraction)?{fraction:holeCapture,bodyType:'black-hole',bodyId:'black-hole',bodyName:'中心黑洞'}:starCapture?{...starCapture,bodyType:starCapture.star.rs?'black-hole':starCapture.star.kind??'star',bodyId:starCapture.star.id,bodyName:starCapture.star.name}:null;
    if (capture) {
      const fraction=capture.fraction,x = s.x + (nx - s.x) * fraction, y = s.y + (ny - s.y) * fraction;
      const collisionTick=fieldTick+fraction;
      const hitZ=spatial?z+(nz-z)*fraction:undefined;
      const b = fieldAcceleration(x,y,collisionTick,mu,forceVersion,undefined,hitZ), h = dt * fraction;
      const vx = s.vx + (a.x + b.x) * h / 2, vy = s.vy + (a.y + b.y) * h / 2;
      if (![x, y, vx, vy].every(Number.isFinite)) return finish(s, 'error', 0, oldTick);
      Object.assign(s, { x, y, vx, vy });
      if(spatial){s.z=hitZ;s.vz+=(a.z+b.z)*h/2;}
      const bodyX=capture.star?capture.star.x+(capture.endStar.x-capture.star.x)*fraction:0;
      const bodyY=capture.star?capture.star.y+(capture.endStar.y-capture.star.y)*fraction:0;
      const bodyZ=spatial&&capture.star?capture.star.z+(capture.endStar.z-capture.star.z)*fraction:0;
      return finish(s, 'captured', fraction, oldTick,{bodyType:capture.bodyType,bodyId:capture.bodyId,bodyName:capture.bodyName,bodyX,bodyY,...(spatial?{bodyZ}:{}),fieldTick:collisionTick});
    }
    const b = fieldAcceleration(nx,ny,fieldTick+1,mu,forceVersion,endStars,spatial?nz:undefined), vx = hx + b.x * dt / 2, vy = hy + b.y * dt / 2;
    const next = { x: nx, y: ny, vx, vy,...(spatial?{z:nz,vz:hz+b.z*dt/2}:{}),...(s.gravitationalMu!==undefined?{gravitationalMu:mu,dynamicsVersion:s.dynamicsVersion}:{}),...(multi?{fieldTick:fieldTick+1}:{}) };
    if (!Number.isFinite(vx)||!Number.isFinite(vy)||!hasFiniteEnergy(next,endStars))return finish(s, 'error', 0, oldTick);
    const nextRadius=radiusAt(nx,ny,next.z);
    if(nextRadius>MODEL.observation.radius){
      const fraction=crossing(s.x,s.y,nx,ny,MODEL.observation.radius,true,z,nz)??1;
      const boundaryZ=spatial?z+(nz-z)*fraction:undefined;
      const x=s.x+(nx-s.x)*fraction,y=s.y+(ny-s.y)*fraction,boundaryAcceleration=fieldAcceleration(x,y,fieldTick+fraction,mu,forceVersion,undefined,boundaryZ),h=dt*fraction;
      Object.assign(s,{x,y,vx:s.vx+(a.x+boundaryAcceleration.x)*h/2,vy:s.vy+(a.y+boundaryAcceleration.y)*h/2});
      if(spatial){s.z=boundaryZ;s.vz+=(a.z+boundaryAcceleration.z)*h/2;}
      return finish(s,'out_of_observable',fraction,oldTick,multi?{fieldTick:fieldTick+fraction}:{});
    }
    if (!s.continuousTracking && nextRadius >= s.escapeRadius && nx*vx+ny*vy+nz*(next.vz??0)>0 && energy(next)>0) {
      const fraction = crossing(s.x,s.y,nx,ny,s.escapeRadius,true,z,nz) ?? 1;
      Object.assign(s, { x: s.x + (nx - s.x) * fraction, y: s.y + (ny - s.y) * fraction,
        vx: s.vx + (vx - s.vx) * fraction, vy: s.vy + (vy - s.vy) * fraction });
      if(spatial){s.z=z+(nz-z)*fraction;s.vz+=(next.vz-s.vz)*fraction;}
      return finish(s, 'escaped', fraction, oldTick);
    }
    Object.assign(s, next);s.tick = oldTick + 1;s.elapsedSeconds = s.tick / MODEL.tickRate;
    if(stepEnds&&multi){
      // The next step starts at this same position in the same cached field frame.
      const end=previous??{};
      end.stars=endStars;end.mu=mu;end.forceVersion=forceVersion;end.acceleration=b;
      end.fieldTick=fieldTick+1;
      end.x=s.x;end.y=s.y;end.z=s.z;end.vx=s.vx;end.vy=s.vy;end.vz=s.vz;
      if(!previous)stepEnds.set(s,end);
    }
    return s;
  }
  function snapshot(s) {
    return { tick: s.tick, elapsedSeconds: s.elapsedSeconds, x: s.x, y: s.y, vx: s.vx, vy: s.vy,...(s.z!==undefined?{z:s.z,vz:s.vz}:{}),
      kind: s.status === 'active' ? 'sample' : s.status };
  }
  return Object.freeze({ MODEL, createRuntime:(world,bodyProvider,{preparedBodies=false}={})=>createRuntime(units,generator,world,bodyProvider,preparedBodies), resolveLaunch, validateLaunch, createState, step, effectiveMu, acceleration, fieldAcceleration, stellarBodiesAtTick, circularSpeed, circularRadiusForPeriod, escapeSpeed, orbitReference, launchPreset, energy, angularMomentum, snapshot });
});
