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
