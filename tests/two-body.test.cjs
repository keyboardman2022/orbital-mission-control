const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const M=require('../shared/simulation.js');
const U=require('../shared/units.js');
const {Engine}=require('../server/engine.js');
const input=(massKg=1000)=>({name:'',position:{x:600,y:0},massKg,speed:60,directionDeg:90,dynamicsVersion:'two-body-pw-v1'});
test('finite mass changes independent two-body relative acceleration with the true mass ratio',()=>{
 const a=M.createState(input(1000)),b=M.createState(input(1e30));
 assert.equal(a.gravitationalMu,M.MODEL.mu);
 assert.ok(Math.abs(b.gravitationalMu/M.MODEL.mu-1-1e30/U.centralMassKg)<1e-14);
 M.step(a);M.step(b);assert.ok(b.vx<a.vx);assert.notEqual(a.x,b.x);
 const r=1e6,acc=M.acceleration(r,0,b.gravitationalMu);
 assert.ok(Math.abs(-acc.x/(b.gravitationalMu/r**2)-1)<.0002);
});
test('mass-aware circular speed and specific relative energy agree with the same potential',()=>{
 const mu=M.effectiveMu(1e30),v=M.circularSpeed(600,mu),s=M.createState({...input(1e30),speed:v});
 assert.ok(v>M.circularSpeed(600));const e=M.energy(s);
 for(let i=0;i<24000;i++)M.step(s);
 assert.ok(Math.abs(Math.hypot(s.x,s.y)-600)<.001);
 assert.ok(Math.abs((M.energy(s)-e)/e)<1e-8);
});
test('mass-aware capture preserves its fractional final point and input mass limits are enforced',()=>{
 const a=M.createState({...input(1000),position:{x:100,y:0},speed:0}),b=M.createState({...input(1e30),position:{x:100,y:0},speed:0});
 for(let i=0;i<1000;i++){M.step(a);M.step(b);}
 assert.equal(a.status,'captured');assert.equal(b.status,'captured');assert.ok(b.elapsedSeconds<a.elapsedSeconds);
 assert.ok(Math.abs(Math.hypot(b.x,b.y)-M.MODEL.captureRadius)<1e-8);
 assert.ok(Number.isFinite(b.vx));assert.throws(()=>M.validateLaunch(input(1.01e30)),e=>e.status===422);
});
test('legacy states keep their original force law and unsupported dynamics fail explicitly',()=>{
 const p={...input(),name:'old'};delete p.dynamicsVersion;
 const a=M.createState(p),b=JSON.parse(JSON.stringify(a));
 assert.equal(a.gravitationalMu,undefined);
 for(let i=0;i<1000;i++){M.step(a);M.step(b);}assert.deepEqual(a,b);
 assert.throws(()=>M.validateLaunch({...input(),dynamicsVersion:'unknown'}),e=>e.status===409);
});
test('timestamp hash names are unique, durable and stable across retries; custom names remain intact',t=>{
 const file=join(mkdtempSync(join(tmpdir(),'orbital-mass-')),'test.sqlite');
 let e=new Engine({filename:file,now:()=>100000});t.after(()=>e.close());const u=e.guest().user.id;
 const req={...input(1e30),idempotencyKey:'timestamp-hash-1'},a=e.launch(u,req),b=e.launch(u,{...req,idempotencyKey:'timestamp-hash-2'});
 assert.match(a.name,/^SAT-[a-f0-9]{16}$/);assert.notEqual(a.name,b.name);
 assert.equal(a.nameGenerated,true);assert.equal(a.nameTimestampMs,100000);
 assert.equal(e.launch(u,req).name,a.name);
 const c=e.launch(u,{...req,name:'自定义探测器',idempotencyKey:'custom-name-3'});assert.equal(c.name,'自定义探测器');
 e.advanceTo(800);e.checkpoint();const saved=e.get(u,a.id);e.close();e=new Engine({filename:file,now:()=>100000});
 assert.deepEqual(e.get(u,a.id),saved);assert.equal(e.launch(u,req).name,a.name);
 const exported=e.prepareExport(u,a.id,'json');assert.equal(exported.satellite.initial.dynamicsVersion,'two-body-pw-v1');
 assert.equal(exported.satellite.state.gravitationalMu,M.effectiveMu(1e30));
});
test('launching another satellite cannot perturb an existing satellite trajectory',t=>{
 const make=()=>new Engine({filename:join(mkdtempSync(join(tmpdir(),'orbital-independent-')),'test.sqlite'),now:()=>100000});
 const a=make(),b=make();t.after(()=>{a.close();b.close();});const ua=a.guest().user.id,ub=b.guest().user.id;
 const p=a.launch(ua,{...input(1e30),idempotencyKey:'independent-1'}),q=b.launch(ub,{...input(1e30),idempotencyKey:'independent-1'});
 b.launch(ub,{...input(1e30),position:{x:601,y:0},idempotencyKey:'independent-2'});
 a.advanceTo(2400);b.advanceTo(2400);assert.deepEqual(a.get(ua,p.id).state,b.get(ub,q.id).state);
});
