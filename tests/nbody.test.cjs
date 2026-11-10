'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createSimulation,generateBodies}=require('../shared/nbody.js');
const {generateWorld,SPATIAL_LAYOUT}=require('../shared/world-generator.js');

const body=(id,props)=>({id,kind:'star',mass:1,radius:1,color:'#fff',x:0,y:0,z:0,vx:0,vy:0,vz:0,...props});

test('random initial conditions reproduce by seed and fill a volume without overlaps',()=>{
  const bodies=generateBodies('三维引力',24);
  assert.deepEqual(generateBodies('三维引力',24),bodies);
  assert.notDeepEqual(generateBodies('另一片星空',24),bodies);
  assert.ok(new Set(bodies.map(body=>body.kind)).size>=3);
  for(const [index,a] of bodies.entries()){
    assert.ok(a.z!==0&&Math.hypot(a.vx,a.vy,a.vz)>0);
    for(const b of bodies.slice(index+1))assert.ok(Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)>a.radius+b.radius);
  }
  const first=createSimulation(bodies),second=createSimulation(generateBodies('三维引力',24));
  for(let i=0;i<180;i++){first.step();second.step();}
  assert.deepEqual(first.bodies,second.bodies);
  assert.deepEqual(first.collisions,second.collisions);
});

test('even a full 48-body experiment starts on the same spatial scale as a seeded map',()=>{
  const bodies=generateBodies('LAB-19ukayt-15xwv6c',48);
  const map=generateWorld('spatial-scale',{layout:SPATIAL_LAYOUT});
  const furthest=Math.max(...bodies.map(body=>Math.hypot(body.x,body.y,body.z)));
  assert.ok(furthest>=map.radius*.9&&furthest<=map.radius);
  for(const [index,a] of bodies.entries())for(const b of bodies.slice(index+1)){
    assert.ok(Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)>=20000);
  }
});

test('each body gets its own speed and direction in three dimensions',()=>{
  const seed='LAB-19ukayt-15xwv6c', bodies=generateBodies(seed,48), subset=generateBodies(seed,24);
  const speed=body=>Math.hypot(body.vx,body.vy,body.vz);
  const speeds=bodies.map(speed);
  assert.equal(new Set(speeds).size,bodies.length);
  assert.ok(Math.max(...speeds)>4*Math.min(...speeds));
  const octants=bodies.map(({vx,vy,vz})=>[vx,vy,vz].map(Math.sign).join(','));
  assert.equal(new Set(octants).size,8);
  for(const [index,a] of subset.entries()){
    const b=bodies[index];
    for(const axis of ['vx','vy','vz'])assert.ok(Math.abs(a[axis]/speed(a)-b[axis]/speed(b))<1e-12);
  }
});

test('gravity moves both masses in three dimensions and conserves pair momentum',()=>{
  const sim=createSimulation([body(1,{z:-10}),body(2,{z:10,mass:3})],{gravity:100,softening:0});
  sim.step(.02);
  const [a,b]=sim.bodies;
  assert.ok(a.z>-10&&b.z<10);
  assert.ok(Math.abs(a.vz-.015)<.00001);
  assert.ok(Math.abs(a.vz+3*b.vz)<1e-12);
  assert.equal(sim.collisions.length,0);
});

test('fast bodies merge at first contact and retain their mass and momentum',()=>{
  const sim=createSimulation([body(1,{x:-10,vx:100,mass:2}),body(2,{x:10,vx:-80,kind:'blackHole',mass:3})],{gravity:0});
  sim.step(.25);
  assert.equal(sim.bodies.length,1);
  const [merged]=sim.bodies,[collision]=sim.collisions;
  assert.equal(merged.mass,5);
  assert.equal(merged.vx,-8);
  assert.equal(merged.kind,'blackHole');
  assert.ok(Math.abs(merged.x)<1e-10);
  assert.ok(Math.abs(collision.time-.1)<1e-12);
});

test('a projected crossing with sufficient vertical separation does not collide',()=>{
  const sim=createSimulation([body(1,{x:-10,vx:100}),body(2,{x:10,z:3,vx:-100})],{gravity:0});
  sim.step(.25);
  assert.equal(sim.bodies.length,2);
  assert.equal(sim.collisions.length,0);
});
