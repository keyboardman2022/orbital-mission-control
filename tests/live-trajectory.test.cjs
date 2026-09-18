'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const history=require('../shared/history-window.js'),M=require('../shared/simulation.js');
function orbit(massKg=1000){return M.createState({name:'orbit',position:{x:220,y:0},massKg,speed:M.circularSpeed(220,M.effectiveMu(massKg)),directionDeg:90,dynamicsVersion:M.MODEL.dynamics.version},{continuousTracking:true});}
function advance(state,ticks){const result={...state};for(let i=0;i<ticks;i++)M.step(result);return result;}
test('live motion follows the physical circular arc rather than the chord between packets',()=>{
  const a=orbit(),b=advance(a,240),segment=history.liveSegment(a,b,M);
  const middle=history.interpolate(segment,.5);
  assert.ok(Math.abs(Math.hypot(middle.x,middle.y)-220)<.01);
  assert.ok(middle.y>67&&middle.y<68);
  assert.ok(segment.length>100);
});
test('live reconstruction preserves finite satellite mass and authoritative endpoints',()=>{
  const a=orbit(1e30),b=advance(a,240),segment=history.liveSegment(a,b,M);
  assert.deepEqual(segment.at(-1),b);
  const middle=history.interpolate(segment,.5);
  assert.ok(Math.abs(Math.hypot(middle.x,middle.y)-220)<.01);
  assert.ok(middle.y>68&&middle.y<70);
});
test('large recovery gaps and inconsistent endpoints are never joined into a fabricated trajectory',()=>{
  const a=orbit();assert.equal(history.liveSegment(a,advance(a,2400),M),null);
  const b=advance(a,240);b.x+=100;
  assert.equal(history.liveSegment(a,b,M),null);
});
test('live observer keeps moving through irregular packet intervals with the same fixed-step physics',()=>{
  const a=orbit(),observer=history.createLiveObserver(M);observer.accept(a);
  const b=advance(a,48);observer.accept(b);
  observer.advance(.1);const before={...observer.state};observer.advance(.3);
  assert.ok(Math.hypot(observer.state.x-before.x,observer.state.y-before.y)>30);
  assert.ok(Math.abs(Math.hypot(observer.state.x,observer.state.y)-220)<.01);
  const expected=advance(a,96);
  assert.ok(Math.hypot(observer.state.x-expected.x,observer.state.y-expected.y)<1e-8);
});
test('live observer preserves motion when a delayed authoritative packet arrives',()=>{
  const a=orbit(),observer=history.createLiveObserver(M);observer.accept(a);observer.advance(.7);
  const before={...observer.state};observer.accept(advance(a,120));
  assert.deepEqual(observer.state,before);
  observer.advance(.1);assert.ok(Math.hypot(observer.state.x-before.x,observer.state.y-before.y)>10);
});
test('recovery snapshots do not accelerate the observer or change its displayed speed',()=>{
  const a=orbit(),observer=history.createLiveObserver(M);observer.accept(a);observer.advance(.1);
  const before={...observer.state};observer.accept(advance(a,2400),{recovering:true});
  assert.deepEqual(observer.state,before);
  observer.advance(.1);assert.ok(Math.hypot(observer.state.x-before.x,observer.state.y-before.y)>10);
  assert.ok(Math.abs(Math.hypot(observer.state.vx,observer.state.vy)-Math.hypot(a.vx,a.vy))<.001);
});
test('a delayed active packet cannot resurrect an already observed physical capture',()=>{
  const a=M.createState({name:'capture',position:{x:80,y:0},massKg:1000,speed:0,directionDeg:0},{continuousTracking:true});
  const observer=history.createLiveObserver(M);observer.accept(a);observer.advance(.5);
  assert.equal(observer.state.status,'captured');const before={...observer.state};
  observer.accept(a);assert.deepEqual(observer.state,before);
});
test('termination stops the observer even while the server is recovering',()=>{
  const a=orbit(),observer=history.createLiveObserver(M);observer.accept(a);observer.advance(.1);
  observer.accept({...a,status:'terminated'},{recovering:true});const before={...observer.state};
  observer.advance(.5);assert.deepEqual(observer.state,before);assert.equal(observer.state.status,'terminated');
});
