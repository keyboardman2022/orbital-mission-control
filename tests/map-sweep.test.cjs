'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {mkdtempSync,rmSync}=require('node:fs'),{tmpdir}=require('node:os'),{join}=require('node:path');
const {Engine}=require('../server/engine.js');
const launch={name:'sweep',position:{x:600,y:0},massKg:1000,speed:65,directionDeg:90,modelVersion:'pw-2d-v1'};
test('map wave clears near satellites first, covers screen corners and finally includes offscreen targets',()=>{
  const wave=require('../shared/map-sweep.js').create({ids:['near','far','offscreen'],origin:{x:100,y:100},width:800,height:600});
  wave.advance(.1);assert.deepEqual(wave.hits(new Map([['near',{x:110,y:100}],['far',{x:800,y:600}],['offscreen',{x:1e9,y:1e9}]])),['near']);
  wave.advance(1);assert.deepEqual(wave.hits(new Map([['far',{x:800,y:600}]])),[]);
  wave.advance(8);assert.deepEqual(wave.hits(new Map([['far',{x:800,y:600}],['offscreen',{x:1e9,y:1e9}]])),['far','offscreen']);
  assert.ok(wave.radius>=Math.hypot(700,500));assert.equal(wave.remaining.size,0);
});
test('wave expansion is slower and its world distance does not depend on viewport size',()=>{
  const S=require('../shared/map-sweep.js'),a=S.create({ids:[],origin:{x:0,y:0},width:800,height:600}),b=S.create({ids:[],origin:{x:0,y:0},width:8000,height:6000});
  a.advance(2);b.advance(2);assert.equal(a.radius,b.radius);assert.ok(a.radius<400);assert.ok(a.duration>=8);
});
test('at minimum zoom the wave reaches every visible world corner',()=>{
  const S=require('../shared/map-sweep.js'),C=require('../camera.js'),view=C.view(1000,800,1e-7);
  const extent=S.viewportExtent(view,1000,800,C),wave=S.create({ids:[],origin:{x:0,y:0},extent});wave.advance(wave.duration);
  for(const [x,y]of [[0,0],[1000,0],[0,800],[1000,800]]){const p=C.toWorld(x,y,view);assert.ok(wave.radius>=Math.hypot(p.x,p.y));}
});
test('zooming out during expansion extends coverage without jumping the wave radius',()=>{
  const S=require('../shared/map-sweep.js'),wave=S.create({ids:[],origin:{x:0,y:0},extent:1000});wave.advance(4);
  const before=wave.radius;wave.extendTo(1e10);assert.equal(wave.radius,before);assert.equal(wave.done,false);
  wave.advance(4);assert.equal(wave.radius,before+600);assert.ok(wave.duration>1e7);
  wave.advance(wave.duration-wave.age);assert.ok(wave.radius>=1e10);
});
test('starting at a much larger view distance does not increase the physical propagation speed',()=>{
  const S=require('../shared/map-sweep.js'),near=S.create({ids:[],origin:{x:0,y:0},extent:1000}),far=S.create({ids:[],origin:{x:0,y:0},extent:1e10});
  near.advance(2);far.advance(2);assert.equal(near.radius,300);assert.equal(far.radius,300);
  assert.equal(near.speed,far.speed);assert.ok(far.duration>near.duration);
});
test('map sweep discovers all owned live satellites and batch termination preserves their history',t=>{
  const dir=mkdtempSync(join(tmpdir(),'orbital-sweep-')),e=new Engine({filename:join(dir,'orbital.sqlite'),now:()=>1000});
  t.after(()=>{e.close();rmSync(dir,{recursive:true,force:true});});
  const a=e.guest(),b=e.guest(),one=e.launch(a.user.id,{...launch,idempotencyKey:'sweep-one'}),two=e.launch(a.user.id,{...launch,idempotencyKey:'sweep-two'}),other=e.launch(b.user.id,{...launch,idempotencyKey:'sweep-other'});
  e.advanceTo(240);
  assert.deepEqual(e.active(a.user.id).satellites.map(s=>s.id).sort(),[one.id,two.id].sort());
  const result=e.terminateMany(a.user.id,[one.id,two.id]);assert.equal(result.satellites.length,2);
  assert.ok(result.satellites.every(s=>s.status==='terminated'));assert.equal(e.get(b.user.id,other.id).status,'active');
  const points=e.trajectory(a.user.id,one.id).points;assert.equal(points[0].kind,'birth');assert.equal(points.at(-1).kind,'terminated');
  assert.equal(e.active(a.user.id).satellites.length,0);
  assert.equal(e.terminateMany(a.user.id,[one.id]).satellites[0].status,'terminated');
});
test('map sweep validates every satellite owner before changing any satellite',t=>{
  const dir=mkdtempSync(join(tmpdir(),'orbital-sweep-')),e=new Engine({filename:join(dir,'orbital.sqlite'),now:()=>1000});
  t.after(()=>{e.close();rmSync(dir,{recursive:true,force:true});});
  const a=e.guest(),b=e.guest(),one=e.launch(a.user.id,{...launch,idempotencyKey:'sweep-one'}),other=e.launch(b.user.id,{...launch,idempotencyKey:'sweep-other'});
  assert.throws(()=>e.terminateMany(a.user.id,[one.id,other.id]),/找不到/);
  assert.equal(e.get(a.user.id,one.id).status,'active');assert.equal(e.get(b.user.id,other.id).status,'active');
});
