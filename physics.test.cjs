const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./physics.js');

test('far-field acceleration approaches inverse square gravity', () => {
  const r = 1e7, a = P.acceleration(r, 0);
  assert.ok(Math.abs(a.x / (-P.MU / (r*r)) - 1) < 0.00002);
  assert.equal(Math.abs(a.y), 0);
});
test('stable circular orbit conserves radius, energy and angular momentum', () => {
  const p=P.createParticle(330,0,'orbit',1),e=P.energy(p),l=P.angularMomentum(p);
  let error=0;
  for(let i=0;i<24000;i++){
    P.step(p,P.STEP);
    assert.equal(p.status,'active');
    error=Math.max(error,Math.abs(Math.hypot(p.x,p.y)/330-1));
  }
  assert.ok(error<0.0001,`radius drift ${error}`);
  assert.ok(Math.abs((P.energy(p)-e)/e)<0.00001);
  assert.ok(Math.abs((P.angularMomentum(p)-l)/l)<1e-10);
});
test('low angular momentum leads to capture, not a timed expiry', () => {
  const p=P.createParticle(330,0,'infall',1);
  for(let i=0;i<24000&&p.status==='active';i++)P.step(p,P.STEP);
  assert.equal(p.status,'captured');
});
test('positive-energy launch escapes', () => {
  const p=P.createParticle(330,0,'escape',1);
  assert.ok(P.energy(p)>0);
  for(let i=0;i<24000&&p.status==='active';i++)P.step(p,P.STEP);
  assert.equal(p.status,'escaped');
});
test('test-particle size does not change gravitational acceleration', () => {
  const a=P.createParticle(330,0,'infall',1),b=P.createParticle(330,0,'infall',3);
  for(let i=0;i<300;i++){P.step(a,P.STEP);P.step(b,P.STEP);}
  assert.equal(a.x,b.x);assert.equal(a.y,b.y);assert.equal(a.vx,b.vx);assert.equal(a.vy,b.vy);
});
test('fixed timestep gives the same trajectory at 30, 60 and 144 Hz', () => {
  const positions=[30,60,144].map(fps=>{
    const sim=new P.Simulation(),p=P.createParticle(330,0,'orbit',1);sim.particles.push(p);
    for(let i=0;i<fps*10;i++)sim.advance(1/fps);
    return p;
  });
  for(const p of positions.slice(1))assert.ok(Math.hypot(p.x-positions[0].x,p.y-positions[0].y)<1e-7);
});
test('zero elapsed time leaves a particle unchanged; adding more than twelve is allowed', () => {
  const sim=new P.Simulation();
  for(let i=0;i<100;i++)sim.particles.push(P.createParticle(330+i,0,'orbit',1));
  const before=JSON.stringify(sim.particles);sim.advance(0);
  assert.equal(JSON.stringify(sim.particles),before);assert.equal(sim.particles.length,100);
});
test('capture boundary prevents tunneling through the singularity', () => {
  const p=P.createParticle(100,0,'infall',1);p.vx=-100000;p.vy=0;
  P.step(p,P.STEP);assert.equal(p.status,'captured');
});
test('distant escape launches remain observable before crossing their removal boundary', () => {
  const p=P.createParticle(3000,0,'escape',1);
  for(let i=0;i<240;i++)P.step(p);
  assert.equal(p.status,'active');
  for(let i=0;i<240*600&&p.status==='active';i++)P.step(p);
  assert.equal(p.status,'escaped');
});
