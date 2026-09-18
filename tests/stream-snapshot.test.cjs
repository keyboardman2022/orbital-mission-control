const test=require('node:test');
const assert=require('node:assert/strict');
let api;try{api=require('../server/stream-snapshot.js');}catch{}
const record=(tick=0,status='active')=>({id:'a',name:'satellite',massKg:1000,initial:{name:'satellite'},birthTick:0,state:{tick,x:tick,y:0,vx:1,vy:0},status,endReason:status==='active'?null:status,telemetry:{speed:1}});
test('stream sends full metadata initially and only current changed state subsequently',()=>{
 assert.equal(typeof api?.buildSnapshot,'function');const state=api.createStreamState();let s=api.buildSnapshot(state,{server:{tick:0},satellites:[record()]},{now:0});assert.ok(s.satellites[0].initial);
 s=api.buildSnapshot(state,{server:{tick:240},satellites:[record(240)]},{now:1000});assert.equal(s.satellites[0].state.tick,240);assert.equal(s.satellites[0].initial,undefined);assert.equal(s.satellites[0].massKg,undefined);
 assert.equal(api.buildSnapshot(state,{server:{tick:240},satellites:[record(240)]},{now:2000}).satellites.length,0);
});
test('selected record updates faster and terminal state bypasses other-record throttle',()=>{
 assert.equal(typeof api?.buildSnapshot,'function');const state=api.createStreamState();api.buildSnapshot(state,{satellites:[record()]},{now:0});
 assert.equal(api.buildSnapshot(state,{satellites:[record(48)]},{now:200}).satellites.length,0);
 assert.equal(api.buildSnapshot(state,{satellites:[record(96)]},{now:400,selectedId:'a'}).satellites[0].state.tick,96);
 assert.equal(api.buildSnapshot(state,{satellites:[record(97,'captured')]},{now:410}).satellites[0].status,'captured');
 const reconnect=api.buildSnapshot(api.createStreamState(),{satellites:[record(98)]},{now:420});assert.ok(reconnect.satellites[0].initial);
});
