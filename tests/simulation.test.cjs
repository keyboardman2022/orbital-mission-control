const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const P = require('../shared/simulation.js');
const launch = (extra={}) => P.validateLaunch({name:'卫星',position:{x:600,y:0},massKg:1000,speed:60,directionDeg:90,...extra});
const run = (s,n) => {for(let i=0;i<n;i++)P.step(s);return s;};

test('browser and Node expose the same fixed model',()=>{
  const context={};vm.runInNewContext(fs.readFileSync(require.resolve('../shared/units.js'),'utf8'),context);
  vm.runInNewContext(fs.readFileSync(require.resolve('../shared/simulation.js'),'utf8'),context);
  assert.equal(context.OrbitalModel.MODEL.version,'pw-2d-v1');
  assert.equal(P.MODEL.step,1/240);
  assert.equal(context.OrbitalModel.MODEL.calibration.kmPerUnit,P.MODEL.calibration.kmPerUnit);
});
test('arbitrary angles normalize in a Y-up world; zero speed is valid',()=>{
  const p=launch({directionDeg:-315});assert.equal(p.directionDeg,45);
  assert.ok(Math.abs(p.vx-60/Math.sqrt(2))<1e-12);assert.ok(p.vy>0);
  assert.equal(launch({directionDeg:810}).directionDeg,90);
  assert.equal(launch({speed:0}).vx,0);
});
test('invalid and nonnumeric inputs fail with 422, model conflicts with 409',()=>{
  for(const extra of [{name:''},{name:'x'.repeat(65)},{position:{x:79,y:0}},{position:{x:1000000001,y:0}},{position:{x:'600',y:0}},{massKg:0},{massKg:Infinity},{speed:-1},{speed:1001},{speed:NaN},{directionDeg:'90'},{directionDeg:Infinity}]){
    assert.throws(()=>launch(extra),e=>e.status===422);
  }
  assert.throws(()=>launch({modelVersion:'future'}),e=>e.status===409);
});
test('mass does not affect trajectories and serialized resumption is exact',()=>{
  const a=P.createState(launch({massKg:1})),b=P.createState(launch({massKg:1e12}));
  run(a,3000);run(b,1000);const restored=JSON.parse(JSON.stringify(b));run(restored,2000);
  assert.deepEqual(a,restored);assert.equal(a.elapsedSeconds,a.tick/240);
});
test('stable circular orbit preserves radius, energy and angular momentum',()=>{
  const s=P.createState(launch({speed:P.circularSpeed(600)})),e=P.energy(s),l=P.angularMomentum(s);
  for(let i=0;i<80000;i++){
    P.step(s);assert.equal(s.status,'active');
    assert.ok(Math.abs(Math.hypot(s.x,s.y)-600)<0.001);
  }
  assert.ok(Math.abs((P.energy(s)-e)/e)<1e-8);
  assert.ok(Math.abs((P.angularMomentum(s)-l)/l)<1e-11);
});
test('zero-speed and radial infall stop at the capture intersection with fractional time',()=>{
  for(const speed of [0,1000]){
    const s=P.createState(launch({position:{x:80,y:0},speed,directionDeg:180}));
    run(s,10000);assert.equal(s.status,'captured');
    assert.ok(Math.abs(Math.hypot(s.x,s.y)-P.MODEL.captureRadius)<1e-10);
    assert.ok(s.event.substepFraction>=0&&s.event.substepFraction<=1);
    assert.equal(s.elapsedSeconds,(s.tick-1+s.event.substepFraction)/240);
    const frozen=JSON.stringify(s);run(s,100);assert.equal(JSON.stringify(s),frozen);
    assert.equal(P.snapshot(s).kind,'captured');
  }
});
test('outward positive-energy particle stops at the fixed escape boundary',()=>{
  const s=P.createState(launch({speed:1000,directionDeg:0}));run(s,10000);
  assert.equal(s.status,'escaped');assert.ok(P.energy(s)>0);
  assert.ok(Math.abs(Math.hypot(s.x,s.y)-1800)<1e-8);
});
test('overflow stops at last reliable coordinates',()=>{
  const s=P.createState(launch());s.vx=Number.MAX_VALUE;
  P.step(s);assert.equal(s.status,'error');assert.equal(s.x,600);assert.equal(s.y,0);
});

// Independent small-step reference measures the published fixed-step envelope.
function reference(initial,h,seconds){
  const s={...initial};let elapsed=0;
  function a(x,y){const r=Math.hypot(x,y),f=-2000000/(r*(r-66)**2);return [x*f,y*f];}
  while(elapsed<seconds-h/2){
    const [ax,ay]=a(s.x,s.y),hx=s.vx+ax*h/2,hy=s.vy+ay*h/2;
    const x=s.x+hx*h,y=s.y+hy*h;
    if(Math.hypot(x,y)<=69.3){
      const dx=x-s.x,dy=y-s.y,A=dx*dx+dy*dy,B=2*(s.x*dx+s.y*dy),C=s.x*s.x+s.y*s.y-69.3**2;
      const u=(-B-Math.sqrt(B*B-4*A*C))/(2*A);return {...s,elapsedSeconds:elapsed+u*h};
    }
    const [bx,by]=a(x,y);s.x=x;s.y=y;s.vx=hx+bx*h/2;s.vy=hy+by*h/2;elapsed+=h;
  }
  return {...s,elapsedSeconds:elapsed};
}
test('range extremes agree with a sixteen-times finer reference',()=>{
  for(const options of [
    {position:{x:80,y:0},speed:0,directionDeg:0},
    {position:{x:80,y:0},speed:1000,directionDeg:180},
    {position:{x:8900,y:0},speed:1000,directionDeg:90},
    {position:{x:8900,y:0},speed:0,directionDeg:0}
  ]){
    const s=P.createState(launch(options)),fine=reference(s,1/3840,1);run(s,240);
    if(s.status==='captured')assert.ok(Math.abs(s.elapsedSeconds-fine.elapsedSeconds)<0.002);
    else assert.ok(Math.hypot(s.x-fine.x,s.y-fine.y)<0.001);
  }
});
test('fast tangential launch at minimum radius has a disclosed sub-unit one-second error',()=>{
  const s=P.createState(launch({position:{x:80,y:0},speed:1000,directionDeg:90}));
  const fine=reference(s,1/3840,1);run(s,240);
  assert.equal(s.status,'active');
  assert.ok(Math.hypot(s.x-fine.x,s.y-fine.y)<0.5);
  assert.ok(Math.hypot(s.vx-fine.vx,s.vy-fine.vy)<0.5);
});
