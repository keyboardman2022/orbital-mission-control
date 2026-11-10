'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {Engine}=require('../server/engine.js');
const M=require('../shared/simulation.js');
const {createLiveObserver,interpolate}=require('../shared/history-window.js');
const {create: createSweep}=require('../shared/map-sweep.js');
const {generateWorld,bodyPositions,worldOrbitalPlanes,SPATIAL_LAYOUT,BODY_PROFILES,MU_PER_SOLAR_MASS}=require('../shared/world-generator.js');

const flight={name:'3D probe',dimension:3,position:{x:1000,y:0,z:60},speed:40,directionDeg:90,pitchDeg:30,massKg:1000,dynamicsVersion:M.MODEL.dynamics.version,idempotencyKey:'spatial-flight-test'};

test('a launch offset follows its selected star until birth and retries keep the original birth point',t=>{
 const engine=new Engine({filename:':memory:'});
 t.after(()=>engine.close());
 const user=engine.guest().user.id;
 const {worldId}=engine.registerWorld({seed:'launch reference',options:{systems:2,blackHoles:0,layout:'spatial-v2'}});
 const {runtime}=engine.worldInfo(worldId);
 const referenceBodyId=runtime.stellarBodiesAtTick(0,true)[0].id;
 const position={x:450,y:-20,z:30};
 const request={...flight,worldId,referenceBodyId,position,launchPreset:'orbit',speed:0,dynamicsVersion:runtime.MODEL.dynamics.version};
 engine.advanceTo(1200);
 const satellite=engine.launch(user,request);
 const reference=runtime.stellarBodiesAtTick(satellite.birthTick,true).find(body=>body.id===referenceBodyId);
 assert.deepEqual(satellite.initial.position,{x:reference.x+position.x,y:reference.y+position.y,z:reference.z+position.z});
 const orbit=runtime.launchPreset(satellite.initial.position,runtime.orbitReference(satellite.initial.position,request.massKg,satellite.birthTick,referenceBodyId),'orbit');
 assert.equal(satellite.initial.speed,orbit.speed);
 engine.advanceTo(1320);
 assert.deepEqual(engine.launch(user,request).initial.position,satellite.initial.position);
 assert.throws(()=>engine.launch(user,{...request,position:{...position,z:40}}),{status:409});
 assert.throws(()=>engine.launch(user,{...request,launchPreset:'escape'}),{status:409});
 assert.throws(()=>engine.launch(user,{...request,referenceBodyId:'missing',idempotencyKey:'missing-reference'}),{status:422});
});

test('paused 3D launches and their stars resume from the same tick',t=>{
 const engine=new Engine({filename:':memory:'});
 t.after(()=>engine.close());
 const user=engine.guest().user.id,other=engine.guest().user.id;
 engine.advanceTo(120);
 assert.equal(engine.setSpatialPaused(user,null,true).server.tick,120);
 const star=M.stellarBodiesAtTick(120,true).find(body=>body.id==='ember');
 const start={x:star.x+36,y:star.y,z:star.z};
 const orbit=M.launchPreset(start,M.orbitReference(start,1000,120,'ember'),'orbit');
 const request={...flight,...orbit,referenceBodyId:'ember',position:{x:36,y:0,z:0}};
 engine.advanceTo(2400);
 const satellite=engine.launch(user,request);
 assert.equal(satellite.birthFieldTick,120);
 assert.deepEqual(satellite.initial.position,start);
 engine.advanceTo(4800);
 assert.equal(engine.get(user,satellite.id).state.tick,0);
 assert.equal(engine.list(user,{dimension:3}).server.tick,120);
 assert.equal(engine.list(user).server.tick,4800);
 assert.equal(engine.list(other,{dimension:3}).server.tick,4800);
 assert.equal(engine.setSpatialPaused(user,null,false).server.tick,120);
 engine.advanceTo(4801);
 assert.equal(engine.get(user,satellite.id).state.fieldTick,121);
 assert.equal(engine.list(user,{dimension:3}).server.tick,121);
 engine.advanceTo(7200);
 const {state}=engine.get(user,satellite.id);
 const host=M.stellarBodiesAtTick(state.fieldTick,true).find(body=>body.id==='ember');
 assert.equal(state.status,'active');
 assert.ok(Math.hypot(state.x-host.x,state.y-host.y,state.z-host.z)<50);
});

test('3D launch presets match 2D at equal radius and aim tangent in space',()=>{
 const flat={x:1000,y:0},spatial={x:800,y:0,z:600};
 const a=M.orbitReference(flat,1000),b=M.orbitReference(spatial,1000);
 for(const mode of ['infall','orbit','escape']){
  assert.equal(M.launchPreset(flat,a,mode).speed,M.launchPreset(spatial,b,mode).speed);
 }
 const orbit=M.launchPreset(spatial,b,'orbit');
 const state=M.createState({...flight,position:spatial,...orbit});
 assert.ok(Math.abs(state.x*state.vx+state.y*state.vy+state.z*state.vz)<1e-8);
 const escape=M.launchPreset(spatial,b,'escape');
 assert.ok(escape.pitchDeg>0);
});

test('selected-body presets compute tangency, radial escape and an inward flyby in the body frame',()=>{
 const tick=321,star=M.stellarBodiesAtTick(tick,true).find(body=>body.id==='ember');
 const offset={x:36,y:12,z:8};
 const position={x:star.x+offset.x,y:star.y+offset.y,z:star.z+offset.z};
 const reference=M.orbitReference(position,1000,tick,star.id);
 for(const mode of ['orbit','escape','infall']){
  const input={...flight,referenceBodyId:star.id,position:offset,launchPreset:mode,speed:0,directionDeg:0,pitchDeg:0};
  const state=M.createState(M.resolveLaunch(input,tick),{fieldTick:tick});
  const vx=state.vx-reference.velocity.x,vy=state.vy-reference.velocity.y,vz=state.vz-reference.velocity.z;
  const radial=(offset.x*vx+offset.y*vy+offset.z*vz)/reference.radius;
  const speed=Math.hypot(vx,vy,vz);
  if(mode==='orbit'){
   assert.ok(Math.abs(radial)<1e-8);
   assert.ok(Math.abs(speed-reference.circular)<1e-8);
  }else if(mode==='escape'){
   assert.ok(radial>reference.escape);
   assert.ok(Math.abs(radial-speed)<1e-8);
  }else{
   assert.ok(radial<0);
   const periapsis=1.1*star.collisionRadius;
   const angularMomentum=reference.radius*Math.hypot(speed*Math.sqrt(1-(radial/speed)**2));
   assert.ok(Math.abs(angularMomentum-periapsis*Math.sqrt(2*star.mu/Math.hypot(periapsis,star.softening)))<1e-8);
  }
 }
});

test('3D live observation advances between packets and accepts a vertical correction',()=>{
 const initial=M.createState(flight,{continuousTracking:true});
 const observer=createLiveObserver(M);
 observer.accept(initial);
 assert.deepEqual(observer.advance(.4,{collect:false}),[]);
 const first=observer.state.z;
 assert.equal(observer.state.tick,96);
 observer.advance(.4,{collect:false});
 assert.equal(observer.state.tick,192);
 assert.ok(observer.state.z>first);
 const corrected={...observer.state,z:observer.state.z+1};
 assert.equal(observer.accept(corrected),true);
 assert.equal(observer.state.z,corrected.z);
});

test('3D launch turns pitch into vertical velocity and integrates vertical gravity',()=>{
 const state=M.createState(flight,{continuousTracking:true});
 assert.equal(state.z,60);
 assert.ok(Math.abs(state.vz-20)<1e-10);
 M.step(state);
 assert.ok(state.z>60&&state.vz<20);
 assert.throws(()=>M.validateLaunch({...flight,pitchDeg:91}),{status:422});
 assert.throws(()=>M.validateLaunch({...flight,position:{x:1000,y:0}}),{status:422});
 const overHole=M.createState({...flight,position:{x:0,y:0,z:100},pitchDeg:-90},{continuousTracking:true});
 for(let i=0;i<240&&overHole.status==='active';i++)M.step(overHole);
 assert.equal(overHole.status,'captured');
 assert.equal(overHole.event.bodyType,'black-hole');
 assert.ok(Math.abs(overHole.z-M.MODEL.captureRadius)<1e-6);
});

test('inclined binary stars move in 3D while preserving their separation and barycenter',()=>{
 const world=generateWorld('ORBITAL-06');
 const runtime=M.createRuntime(world);
 const system=world.systems.find(candidate=>candidate.binary);
 const ids=system.bodies.filter(body=>body.kind==='star').map(body=>body.id);
 const positions=tick=>runtime.stellarBodiesAtTick(tick,true).filter(body=>ids.includes(body.id));
 const [a,b]=positions(0),[later]=positions(24000);
 assert.notEqual(a.z,later.z);
 assert.ok(Math.abs(a.z)>1);
 assert.ok(Math.abs(Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)-system.binary.separation)<1e-8);
 assert.ok(Math.abs(a.massSolar*a.z+b.massSolar*b.z)<1e-8);
 assert.equal(runtime.stellarBodiesAtTick(0).find(body=>body.id===a.id).z,undefined);
 const companions=world.systems.find(candidate=>!candidate.binary);
 const field=runtime.stellarBodiesAtTick(24000,true);
 const memberIds=new Set(companions.bodies.map(body=>body.id));
 const orbiters=field.filter(body=>memberIds.has(body.id)&&body.orbit);
 assert.equal(new Set(orbiters.map(body=>body.plane)).size,orbiters.length);
 const planet=orbiters.find(body=>body.kind==='planet');
 const parent=field.find(body=>body.id===planet.orbit.parentId);
 assert.ok(Math.abs(Math.hypot(planet.x-parent.x,planet.y-parent.y,planet.z-parent.z)-planet.orbit.radius)<1e-8);
});

test('3D gravity and collision use an inclined star’s actual height',()=>{
 const runtime=M.createRuntime(generateWorld('ORBITAL-06'));
 const tick=24000, bodies=runtime.stellarBodiesAtTick(tick,true);
 const star=bodies.find(body=>body.kind==='star'&&Math.abs(body.z)>body.radius*3);
 assert.ok(star);
 const start={...flight,dynamicsVersion:runtime.MODEL.dynamics.version,speed:0,
   position:{x:star.x,y:star.y,z:star.z+star.radius*2}};
 const above=runtime.createState(start,{fieldTick:tick,continuousTracking:true});
 runtime.step(above);
 assert.equal(above.status,'active');
 assert.ok(above.vz<0);
 const hit=runtime.createState({...start,position:{x:star.x,y:star.y,z:star.z}},{fieldTick:tick});
 runtime.step(hit);
 assert.equal(hit.event.bodyId,star.id);
 assert.equal(hit.event.bodyZ,star.z);
});

test('3D launch and trajectory keep altitude after restart and stay out of the 2D list',t=>{
 const directory=mkdtempSync(join(tmpdir(),'orbital-3d-')),filename=join(directory,'orbital.sqlite');
 let engine=new Engine({filename});
 t.after(()=>{engine.close();rmSync(directory,{recursive:true,force:true});});
 const user=engine.guest().user.id,record=engine.launch(user,flight);
 engine.advanceTo(240);engine.close();engine=new Engine({filename});
 assert.equal(engine.list(user).satellites.length,0);
 assert.equal(engine.list(user,{dimension:'3'}).satellites[0].id,record.id);
 assert.equal(engine.launch(user,flight).id,record.id);
 const points=engine.trajectory(user,record.id).points;
 assert.equal(points[0].z,60);
 assert.ok(points.at(-1).z>60);
 assert.ok(points.at(-1).vz<20);
 assert.equal(engine.get(user,record.id).state.z,points.at(-1).z);
});

test('replay interpolates altitude and vertical speed while leaving 2D points planar',()=>{
 const a={x:0,y:0,z:2,vx:4,vy:6,vz:8,elapsedSeconds:0};
 const b={x:4,y:4,z:6,vx:0,vy:2,vz:4,elapsedSeconds:2};
 assert.deepEqual(interpolate([a,b],1),{x:2,y:2,z:4,vx:2,vy:4,vz:6,elapsedSeconds:1});
 const flat=[a,b].map(({z,vz,...point})=>point);
 assert.equal('z' in interpolate(flat,1),false);
});

test('3D sweep includes vertical distance and cannot terminate a 2D satellite',t=>{
 const engine=new Engine({filename:':memory:'});
 t.after(()=>engine.close());
 const user=engine.guest().user.id;
 const spatial=engine.launch(user,flight);
 const planar=engine.launch(user,{...flight,dimension:2,idempotencyKey:'planar-sweep-test'});
 const sweep=createSweep({ids:[spatial.id],origin:{x:0,y:0,z:0},extent:100});
 const positions=new Map([[spatial.id,{x:0,y:0,z:60}]]);
 sweep.advance(30/sweep.speed);
 assert.deepEqual(sweep.hits(positions),[]);
 sweep.advance(31/sweep.speed);
 assert.deepEqual(sweep.hits(positions),[spatial.id]);
 assert.throws(()=>engine.terminateMany(user,[spatial.id,planar.id],null,3),{status:404});
 assert.throws(()=>engine.terminateMany(user,[spatial.id],null),{status:404});
 assert.equal(engine.get(user,spatial.id).status,'active');
 assert.equal(engine.terminateMany(user,[spatial.id],null,3).satellites[0].status,'terminated');
 assert.equal(engine.get(user,planar.id).status,'active');
});

test('an off-center spherical sweep finishes on schedule and only hits positions in range',()=>{
 const origin={x:60,y:80,z:0};
 const wave=createSweep({ids:['near','far','outside','unseen'],origin,extent:200,speed:25});
 const positions=new Map([
  ['near',{x:60,y:80,z:-30}],
  ['far',{x:-100,y:-40,z:0}],
  ['outside',{x:60,y:80,z:201}]
 ]);
 wave.advance(1);
 assert.deepEqual(wave.hits(positions),[]);
 wave.advance(1);
 assert.deepEqual(wave.hits(positions),['near']);
 wave.advance(6);
 assert.equal(wave.radius,200);
 assert.deepEqual(wave.hits(positions),['far']);
 wave.advance(.7);
 assert.ok(wave.done);
});

test('spatial seeds respect requested counts and preview the same inclined moons as flight',()=>{
 const options={layout:'spatial-v2',systems:3,blackHoles:1,stars:7,planets:5,moons:9};
 const world=generateWorld('层云',options);
 assert.deepEqual(generateWorld('层云',options),world);
 assert.ok(world.systems.some(system=>system.z>0)&&world.systems.some(system=>system.z<0));
 assert.ok(world.systems.every(system=>Math.hypot(system.x,system.y,system.z)+system.extent<world.radius));
 const bodies=world.systems.flatMap(system=>system.bodies);
 assert.deepEqual(['blackHole','star','planet','moon'].map(kind=>bodies.filter(body=>body.kind===kind).length),[1,7,5,9]);
 assert.equal(new Set(bodies.map(body=>body.name)).size,bodies.length);
 const planes=worldOrbitalPlanes(world),runtime=M.createRuntime(world);
 const positions=runtime.stellarBodiesAtTick(0,true);
 for(const system of world.systems){
  for(const preview of bodyPositions(system,0,planes)){
   const live=positions.find(body=>body.id===preview.id);
   assert.deepEqual([live.x,live.y,live.z],[preview.x,preview.y,preview.z]);
   if(live.kind==='moon'){
    const host=positions.find(body=>body.id===live.orbit.parentId);
    assert.equal(host.kind,'planet');
    assert.ok(Math.abs(Math.hypot(live.x-host.x,live.y-host.y,live.z-host.z)-live.orbit.radius)<1e-8);
   }
  }
 }
 assert.throws(()=>generateWorld('层云',{...options,moons:11}),RangeError);
 const classic=generateWorld('层云',{systems:3,blackHoles:1,stars:7,planets:5});
 assert.ok(classic.systems.every(system=>system.z===undefined&&system.bodies.every(body=>body.kind!=='moon')));
});

test('3D flight validates an elevated black hole and detects an orbiting moon collision',()=>{
 const world=generateWorld('立体引力',{layout:'spatial-v2',systems:2,blackHoles:1,moons:2});
 const runtime=M.createRuntime(world),tick=2400;
 const bodies=runtime.stellarBodiesAtTick(tick,true);
 const hole=bodies.find(body=>body.kind==='blackHole'),moon=bodies.find(body=>body.kind==='moon');
 const launch={...flight,speed:0,dynamicsVersion:runtime.MODEL.dynamics.version};
 assert.throws(()=>runtime.validateLaunch({...launch,position:{x:hole.x,y:hole.y,z:hole.z}}),{status:422});
 assert.doesNotThrow(()=>runtime.validateLaunch({...launch,position:{x:hole.x,y:hole.y,z:0}}));
 const impact=runtime.createState({...launch,position:{x:moon.x,y:moon.y,z:moon.z}},{fieldTick:tick});
 runtime.step(impact);
 assert.equal(impact.status,'captured');
 assert.equal(impact.event.bodyId,moon.id);
 assert.equal(impact.event.bodyType,'moon');
});

test('seeded body classes vary physical radius and gravity while keeping binary orbits consistent',()=>{
 const classes=new Set(), seen=new Map();
 for(let index=0;index<40;index++){
  const world=generateWorld('stellar-profiles-'+index,{layout:'spatial-v2',systems:3,blackHoles:1,moons:0});
  const runtime=M.createRuntime(world);
  for(const body of runtime.stellarBodiesAtTick(0,true).filter(body=>body.kind==='star'||body.kind==='planet')){
   const profile=BODY_PROFILES[body.bodyClass];
   assert.ok(profile,body.bodyClass);
   assert.ok(body.massSolar>=profile.mass[0]-1e-15&&body.massSolar<=profile.mass[1]);
   assert.ok(body.radius>=profile.radius[0]&&body.radius<=profile.radius[1]);
   assert.equal(body.collisionRadius,body.radius);
   assert.equal(body.mu,MU_PER_SOLAR_MASS*body.massSolar);
   classes.add(body.bodyClass);
   if(!seen.has(body.bodyClass))seen.set(body.bodyClass,new Set());
   seen.get(body.bodyClass).add(body.radius);
  }
  for(const system of world.systems.filter(system=>system.binary)){
   const [primary,companion]=system.bodies;
   const {massRatio,separation}=system.binary;
   assert.ok(Math.abs(companion.massSolar/primary.massSolar-massRatio)<1e-12);
   assert.equal(primary.orbit.angularSpeed,Math.sqrt(MU_PER_SOLAR_MASS*(primary.massSolar+companion.massSolar)/separation**3));
  }
 }
 assert.deepEqual([...classes].sort(),Object.keys(BODY_PROFILES).sort());
 assert.ok([...seen.values()].every(radii=>radii.size>1));
});

test('new 3D worlds contain only the requested stars and black holes',()=>{
 const options={layout:SPATIAL_LAYOUT,systems:3,blackHoles:1,stars:7};
 for(let index=0;index<20;index++){
  const seed='stars-only-'+index,world=generateWorld(seed,options);
  const bodies=world.systems.flatMap(system=>system.bodies);
  assert.equal(world.systems.length,3);
  assert.equal(bodies.filter(body=>body.kind==='blackHole').length,1);
  assert.equal(bodies.filter(body=>body.kind==='star'&&BODY_PROFILES[body.bodyClass]).length,7);
  assert.equal(bodies.length,8);
  assert.deepEqual(generateWorld(seed,options),world);
 }
 assert.throws(()=>generateWorld('stars-only',{...options,planets:3}),RangeError);
});

test('a hierarchical triple keeps both barycentres and distinct orbital planes in the flight model',()=>{
 const options={layout:'spatial-v5',systems:2,blackHoles:0,stars:5};
 const world=generateWorld('三星试飞',options);
 assert.deepEqual(generateWorld('三星试飞',options),world);
 assert.deepEqual(world.systems.map(system=>system.type).sort(),['binary','hierarchical-triple']);
 const system=world.systems.find(candidate=>candidate.triple);
 const runtime=M.createRuntime(world), ids=system.bodies.map(body=>body.id);
 const tripleAt=tick=>ids.map(id=>runtime.stellarBodiesAtTick(tick,true).find(body=>body.id===id));
 const axes=['x','y','z'];
 const distance=(a,b)=>Math.hypot(...axes.map(axis=>a[axis]-b[axis]));
 const centerOf=bodies=>Object.fromEntries(axes.map(axis=>[axis,
  bodies.reduce((sum,body)=>sum+body.massSolar*body[axis],0)/bodies.reduce((sum,body)=>sum+body.massSolar,0)]));
 const [a,b,c]=tripleAt(0);
 assert.ok(a.orbit.angularSpeed>4*c.orbit.angularSpeed);
 assert.equal(a.plane,b.plane);
 const planeDot=a.plane.cosInclination*c.plane.cosInclination+a.plane.sinInclination*c.plane.sinInclination*
  (a.plane.cosNode*c.plane.cosNode+a.plane.sinNode*c.plane.sinNode);
 assert.ok(Math.acos(planeDot)>.3);
 const innerDistance=distance(a,b),outerDistance=distance(centerOf([a,b]),c);
 assert.ok(outerDistance>6*innerDistance);
 assert.notEqual(tripleAt(24000)[2].z,c.z);
 for(const tick of [0,24000,120000]){
  const trio=tripleAt(tick), [first,second,outer]=trio;
  assert.ok(trio.every(star=>distance(star,system)+star.radius<=system.extent));
  assert.ok(Math.abs(distance(first,second)-innerDistance)<1e-8);
  assert.ok(Math.abs(distance(centerOf([first,second]),outer)-outerDistance)<1e-8);
  assert.ok(distance(centerOf(trio),system)<1e-8);
 }
 const hit=runtime.createState({...flight,dynamicsVersion:runtime.MODEL.dynamics.version,
   position:{x:c.x,y:c.y,z:c.z}},{fieldTick:0});
 runtime.step(hit);
 assert.equal(hit.event.bodyId,c.id);
});
