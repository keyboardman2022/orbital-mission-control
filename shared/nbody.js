(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./world-generator.js'));
  else root.OrbitalNBody = factory(root.OrbitalWorldGenerator);
})(globalThis, function (generator) {
  'use strict';

  const {MAP_RADIUS,randomFromSeed} = generator;

  const SPAWN_RADIUS = MAP_RADIUS, MIN_SPAWN_SEPARATION = 20000, MAX_BODIES = 48;
  // Express the experimental gravity in map units while retaining its overall time scale.
  const G = 720 * (SPAWN_RADIUS/900)**3, SOFTENING = 400, STEP = 1/120;
  const TYPES = Object.freeze({
    blackHole: {label:'黑洞', color:'#f8b67c', mass:[12,28], radius:[75,185], weight:12},
    giant: {label:'巨星', color:'#ff9875', mass:[3,9], radius:[40,85], weight:20},
    star: {label:'普通恒星', color:'#adcfff', mass:[.7,2.7], radius:[19,37], weight:32},
    dwarf: {label:'矮星', color:'#f9d89b', mass:[.15,.65], radius:[8,18], weight:20},
    compact: {label:'致密星', color:'#d3adff', mass:[1.2,2.4], radius:[4,10], weight:9},
    rock: {label:'岩质天体', color:'#8ed7ca', mass:[.003,.03], radius:[2,6], weight:7}
  });
  const kinds = Object.keys(TYPES);

  function generateBodies(seed, count) {
    if (!Number.isInteger(count) || count < 2 || count > MAX_BODIES) throw new RangeError(`天体数量需在 2–${MAX_BODIES} 之间。`);
    const normalized = String(seed).trim().normalize('NFC');
    if (!normalized || normalized.length > 64) throw new RangeError('请输入 1–64 个字符的种子。');
    const random = randomFromSeed(`nbody-lab-v2\0${normalized}`);
    const velocityRandom = randomFromSeed(`nbody-velocity-v2\0${normalized}`);
    const sample = ([min,max]) => min + (max-min)*random();
    function direction(length,draw) {
      const z = 2*draw()-1, angle = 2*Math.PI*draw();
      const horizontal = length*Math.sqrt(1-z*z);
      return [horizontal*Math.cos(angle),horizontal*Math.sin(angle),length*z];
    }
    const bodies = [];
    for (let id=1; id<=count; id++) {
      let draw = 100*random();
      const kind = kinds.find(key => (draw -= TYPES[key].weight) < 0);
      const type = TYPES[kind];
      const radius = sample(type.radius), mass = sample(type.mass);
      for (let attempt=0; attempt<512; attempt++) {
        // The cube root gives a uniform sample by volume, with independent angles.
        const [x,y,z] = direction((SPAWN_RADIUS-radius)*Math.cbrt(random()),random);
        if (bodies.some(other => Math.hypot(x-other.x,y-other.y,z-other.z) <
          Math.max(MIN_SPAWN_SEPARATION,radius+other.radius+1))) continue;
        bodies.push({id,kind,radius,mass,color:type.color,x,y,z});
        break;
      }
      if (bodies.length !== id) throw new Error('这次放不下所有天体，请换一个种子。');
    }
    const total = bodies.reduce((sum,body) => sum+body.mass,0);
    const speedScale = Math.sqrt(G*total/SPAWN_RADIUS);
    for (const body of bodies) {
      // Sample magnitude and both angles without changing any other body's draw.
      const [vx,vy,vz] = direction(speedScale*(.05+.75*velocityRandom()),velocityRandom);
      Object.assign(body,{vx,vy,vz});
    }
    return bodies;
  }

  function contactTime(a,b,limit) {
    const radius=a.radius+b.radius;
    // A separated axis cannot produce contact unless relative drift can close it.
    const reach=radius*(1+1e-12);
    const x=b.x-a.x,vx=b.vx-a.vx;
    if(Math.abs(x)>reach+Math.abs(vx)*limit)return Infinity;
    const y=b.y-a.y,vy=b.vy-a.vy;
    if(Math.abs(y)>reach+Math.abs(vy)*limit)return Infinity;
    const z=b.z-a.z,vz=b.vz-a.vz;
    if(Math.abs(z)>reach+Math.abs(vz)*limit)return Infinity;
    const gap=x*x+y*y+z*z-radius**2;
    if (gap<=0) return 0;
    const closing=x*vx+y*vy+z*vz;
    if (closing>=0) return Infinity;
    const discriminant=closing*closing-gap*(vx*vx+vy*vy+vz*vz);
    if (discriminant<0) return Infinity;
    const time=gap/(-closing+Math.sqrt(discriminant));
    return time<=limit ? time : Infinity;
  }

  function createSimulation(initial, {gravity=G,softening=SOFTENING,startTime=0,
    nextId=1+Math.max(0,...initial.map(body=>body.id).filter(Number.isSafeInteger)),mergeId=id=>id}={}) {
    const bodies = initial.map(body => ({...body})), collisions = [];
    const softeningSquared=softening*softening;
    let time=startTime;
    function kick(dt) {
      if (!gravity) return;
      const scale=gravity*dt;
      for (let i=0; i<bodies.length-1; i++){
        const a=bodies[i],ax=a.x,ay=a.y,az=a.z,mass=a.mass;
        let {vx,vy,vz}=a;
        for (let j=i+1; j<bodies.length; j++) {
          const b=bodies[j],x=b.x-ax,y=b.y-ay,z=b.z-az;
          const squared=x*x+y*y+z*z+softeningSquared;
          if (!squared) continue;
          const impulse=scale/(squared*Math.sqrt(squared));
          const towardB=impulse*b.mass,towardA=impulse*mass;
          vx+=x*towardB;vy+=y*towardB;vz+=z*towardB;
          b.vx-=x*towardA;b.vy-=y*towardA;b.vz-=z*towardA;
        }
        a.vx=vx;a.vy=vy;a.vz=vz;
      }
    }
    function move(dt) {
      for (const body of bodies) {
        body.x+=body.vx*dt;body.y+=body.vy*dt;body.z+=body.vz*dt;
      }
    }
    function merge(i,j,at) {
      const a=bodies[i],b=bodies[j],mass=a.mass+b.mass;
      const dominant=a.kind==='blackHole' ? a : b.kind==='blackHole' ? b : a.mass>=b.mass ? a : b;
      const id=mergeId(nextId++);
      const merged={...dominant,id,kind:dominant.kind,color:dominant.color,mass,radius:Math.cbrt(a.radius**3+b.radius**3),
        ...(dominant.name?{name:`合并天体 ${id}`}: {})};
      for (const key of ['x','y','z','vx','vy','vz']) merged[key]=(a[key]*a.mass+b[key]*b.mass)/mass;
      bodies.splice(j,1);bodies.splice(i,1,merged);
      collisions.push({time:at,first:{...a},second:{...b},result:{...merged}});
    }
    function drift(dt) {
      let remaining=dt;
      while (remaining>0) {
        let first=-1,second=-1,earliest=Infinity;
        for (let i=0; i<bodies.length; i++) for (let j=i+1; j<bodies.length; j++) {
          const hit=contactTime(bodies[i],bodies[j],remaining);
          if (hit<earliest) {first=i;second=j;earliest=hit;}
        }
        if (first===-1) {move(remaining);return;}
        move(earliest);
        remaining-=earliest;
        merge(first,second,time+dt-remaining);
      }
    }
    function step(dt=STEP) {
      if (!Number.isFinite(dt) || dt<=0) throw new RangeError('积分步长必须为正。');
      // Half a velocity update on each side of the position update (velocity Verlet).
      kick(dt/2);drift(dt);kick(dt/2);time+=dt;
    }
    return {bodies,collisions,step,get time(){return time;},get nextId(){return nextId;}};
  }

  return Object.freeze({G,STEP,SPAWN_RADIUS,MAX_BODIES,TYPES,generateBodies,createSimulation});
});
