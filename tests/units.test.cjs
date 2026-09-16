const {test}=require('node:test');
const assert=require('node:assert/strict');
const U=require('../shared/units.js');
const M=require('../shared/simulation.js');
test('physical calibration satisfies Schwarzschild radius and gravitational acceleration',()=>{
 const s=U.SCALE;
 assert.ok(Math.abs(s.schwarzschildRadiusKm-29.5325)<.001);
 assert.equal(s.centralMassSolar,10);
 assert.ok(Math.abs(66*s.kmPerUnit-s.schwarzschildRadiusKm)<1e-12);
 const convertedMu=2e6*(s.kmPerUnit*1000)**3/s.secondsPerUnit**2;
 assert.ok(Math.abs(convertedMu/s.gmM3S2-1)<1e-12);
 assert.ok(Math.abs(U.fromKm(U.toKm(1e8))-1e8)<1e-6);
});
test('km and km/s launch matches the same world orbit, with sublight input validation',()=>{
 const p=M.validateLaunch({name:'SI orbit',position:{x:U.toKm(600),y:0},massKg:1000,speed:U.toKmS(M.circularSpeed(600)),directionDeg:90,unitSystem:'si-km-v1'});
 assert.ok(Math.abs(p.position.x-600)<1e-10);
 assert.ok(Math.abs(p.speed-M.circularSpeed(600))<1e-10);
 assert.equal(p.calibration.centralMassSolar,10);
 assert.throws(()=>M.validateLaunch({name:'bad',position:{x:100,y:0},massKg:1,speed:U.C_KM_S,directionDeg:0,unitSystem:'si-km-v1'}),e=>e.status===422);
 assert.throws(()=>M.validateLaunch({name:'bad',position:{x:'100',y:0},massKg:1,speed:10,directionDeg:0,unitSystem:'si-km-v1'}),e=>e.status===422);
 assert.throws(()=>M.validateLaunch({name:'stale',position:{x:100,y:0},massKg:1,speed:10,directionDeg:0,unitSystem:'si-km-v1',calibrationVersion:'other-mass-v2'}),e=>e.status===409);
});
test('telemetry records velocity magnitude and exposes invalid superluminal approximation',()=>{
 const s={x:300,y:400,vx:3,vy:4,elapsedSeconds:2};
 const p=U.telemetry(s);
 assert.equal(p.speed,5);assert.equal(p.speedKmS,U.toKmS(5));
 assert.equal(p.radiusKm,U.toKm(500));assert.equal(p.physicalElapsedSeconds,2*U.SCALE.secondsPerUnit);
 assert.equal(U.telemetry({...s,vx:1000}).physicalSpeedValid,false);
});
test('ruler uses world distances with readable 1/2/5 divisions over the zoom range',()=>{
 for(const km of [.00003,.3,35,1000,1e6,1e10]){
  const division=U.niceDistance(km);assert.ok(division<=km&&division>=km/2.5);
  assert.ok([1,2,5].some(n=>Math.abs(division/10**Math.floor(Math.log10(division))-n)<1e-10));
 }
 const C=require('../camera.js');
 for(const zoom of [1e-7,.0001,2]){
  const view=C.view(375,520,zoom),p={x:1e9,y:-2e8},q=C.toScreen(p.x,p.y,view),back=C.toWorld(q.x,q.y,view);
  assert.ok(Math.abs(back.x-p.x)<1e-5&&Math.abs(back.y-p.y)<1e-5);
 }
});
