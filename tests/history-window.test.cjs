'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const history=require('../shared/history-window.js');

test('window stays within the lifecycle and at most twenty simulation seconds',()=>{
  assert.deepEqual(history.windowRange(500,{tick:240000,elapsedSeconds:1000},240),{fromTick:117600,toTick:122400});
  assert.deepEqual(history.windowRange(0,{tick:240000,elapsedSeconds:1000},240),{fromTick:0,toTick:2400});
  const life=history.lifecycle({tick:241,elapsedSeconds:1.001},240);
  assert.equal(life.endSeconds,1.001);
  assert.equal(life.endTick,241);
  assert.equal(history.windowRange(1.001,{tick:241,elapsedSeconds:1.001},240).toTick,241);
  for(let tick=0;tick<240000;tick+=997){const time=(tick+.37)/240,range=history.windowRange(time,{tick:240000,elapsedSeconds:1000});assert.ok(range.fromTick>=0&&range.toTick<=240000);assert.ok(range.toTick-range.fromTick<=4800);assert.ok(range.fromTick<=tick&&range.toTick>=tick);}
});

test('interpolation uses adjacent samples and never clamps a missing time to a cached endpoint',()=>{
  const points=[{elapsedSeconds:1,x:10,y:2,vx:1,vy:2},{elapsedSeconds:3,x:30,y:6,vx:3,vy:4}];
  assert.deepEqual(history.interpolate(points,2),{elapsedSeconds:2,x:20,y:4,vx:2,vy:3});
  assert.equal(history.interpolate(points,.5),null);
  assert.equal(history.interpolate(points,3.01),null);
  assert.equal(history.interpolate(points,3).x,30);
});

test('cache replaces the previous window and rejects oversized data rather than truncating',()=>{
  const cache=history.createCache(3),points=[0,1,2].map(tick=>({tick,elapsedSeconds:tick}));
  cache.set({fromTick:0,toTick:2},points);
  assert.equal(cache.contains(1),true);
  cache.set({fromTick:3,toTick:4},[{tick:3,elapsedSeconds:3},{tick:4,elapsedSeconds:4}]);
  assert.equal(cache.contains(1),false);
  assert.equal(cache.points.length,2);
  assert.throws(()=>cache.set({fromTick:0,toTick:4},[...points,...points]),/bound/);
});

test('replay trail retains loaded windows, clips at playback time and keeps gaps separate',()=>{
  const trail=history.createTrail(8);
  trail.add({fromTick:0,toTick:20},[
    {seq:1,tick:0,elapsedSeconds:0,x:0,y:0,vx:1,vy:0},
    {seq:2,tick:10,elapsedSeconds:10,x:10,y:0,vx:1,vy:0},
    {seq:3,tick:20,elapsedSeconds:20,x:20,y:0,vx:1,vy:0}
  ]);
  trail.add({fromTick:20,toTick:40},[
    {seq:3,tick:20,elapsedSeconds:20,x:20,y:0,vx:1,vy:0},
    {seq:4,tick:30,elapsedSeconds:30,x:30,y:0,vx:1,vy:0},
    {seq:5,tick:40,elapsedSeconds:40,x:40,y:0,vx:1,vy:0}
  ]);
  assert.equal(trail.segmentCount,1);
  assert.deepEqual(trail.visible(25)[0].map(point=>point.elapsedSeconds),[0,10,20,25]);
  trail.add({fromTick:100,toTick:110},[
    {seq:10,tick:100,elapsedSeconds:100,x:100,y:0,vx:1,vy:0},
    {seq:11,tick:110,elapsedSeconds:110,x:110,y:0,vx:1,vy:0}
  ]);
  assert.equal(trail.segmentCount,2);
  assert.deepEqual(trail.visible(110).map(segment=>segment.map(point=>point.elapsedSeconds)),[[0,10,20,30,40],[100,110]]);
  assert.ok(trail.pointCount<=8);
});

test('lightweight snapshots preserve initial metadata and do not invent incomplete records',()=>{
  const old={id:'one',name:'卫星',massKg:1000,initial:{speed:1},state:{tick:1},status:'active'};
  const merged=history.mergeSnapshot(old,{id:'one',state:{tick:2},status:'terminated'});
  assert.equal(merged.name,'卫星');
  assert.equal(merged.initial,old.initial);
  assert.equal(merged.state.tick,2);
  assert.equal(history.mergeSnapshot(null,{id:'one',state:{tick:2}}),null);
});

test('paged loader pins the first cutoff and includes boundaries without duplicate samples',async()=>{
  const requests=[];
  const result=await history.loadWindow({fromTick:10,toTick:20},async options=>{
    requests.push(options);
    return options.cursor?{points:[{seq:2,tick:20,elapsedSeconds:20},{seq:3,tick:21,elapsedSeconds:21}],nextCursor:null,cutoffSeq:99}:{points:[{seq:1,tick:9,elapsedSeconds:9},{seq:2,tick:20,elapsedSeconds:20}],nextCursor:'next',cutoffSeq:3};
  });
  assert.equal(requests[0].boundaries,true);
  assert.equal(requests[1].cutoffSeq,3);
  assert.deepEqual(result.points.map(p=>p.tick),[9,20,21]);
  assert.equal(result.cutoffSeq,3);
});

test('dense history shrinks around the target and reloads instead of silently dropping points',async()=>{
  const requests=[];
  const result=await history.loadWindow({fromTick:0,toTick:20},async options=>{
    requests.push(options);
    return {points:Array.from({length:options.toTick-options.fromTick+1},(_,i)=>({seq:options.fromTick+i,tick:options.fromTick+i,elapsedSeconds:options.fromTick+i})),nextCursor:null,cutoffSeq:20};
  },{maxPoints:8,targetTick:10});
  assert.ok(result.points.length<=8);
  assert.ok(result.range.fromTick<=10&&result.range.toTick>=10);
  assert.ok(requests.length>1);
  assert.equal(requests[1].cutoffSeq,20);
  assert.equal(result.points.length,result.range.toTick-result.range.fromTick+1);
});

test('paged loader fails a nonadvancing cursor instead of looping forever',async()=>{
  let calls=0;
  await assert.rejects(history.loadWindow({fromTick:0,toTick:20},async()=>{
    if(++calls>3)throw new Error('unbounded page loop');
    return {points:[{seq:1,tick:0,elapsedSeconds:0}],nextCursor:'same',cutoffSeq:1};
  }),/cursor/i);
  assert.equal(calls,2);
});

const exactPoints=(from,count)=>Array.from({length:count},(_,i)=>({seq:from+i,tick:(from+i)*240,elapsedSeconds:from+i,x:500+i,y:i}));

test('loadExact pins cutoff and streams every page once',async()=>{
  const calls=[],pages=[];
  const result=await history.loadExact(async options=>{
    calls.push(options);
    if(options.cursor===null)return {points:exactPoints(1,2),nextCursor:'2',cutoffSeq:9};
    return {points:exactPoints(3,2),nextCursor:null,cutoffSeq:9};
  },{cutoffSeq:9,maxPoints:20,pageSize:5000,onPage:(points,meta)=>pages.push({points,meta})});
  assert.deepEqual(calls.map(c=>[c.cursor,c.cutoffSeq,c.limit]),[[null,9,20],['2',9,18]]);
  assert.equal(result.pointCount,4);assert.equal(pages.length,2);
});

test('loadExact rejects nonadvancing cursor, duplicate sequence and changed cutoff',async()=>{
  await assert.rejects(history.loadExact(async()=>({points:exactPoints(1,1),nextCursor:'same',cutoffSeq:8}),{cutoffSeq:9}),/截止/);
  let n=0;await assert.rejects(history.loadExact(async()=>++n===1?{points:exactPoints(1,1),nextCursor:'same',cutoffSeq:9}:{points:exactPoints(2,1),nextCursor:'same',cutoffSeq:9},{cutoffSeq:9}),/游标|cursor/i);
  n=0;await assert.rejects(history.loadExact(async()=>++n===1?{points:exactPoints(1,2),nextCursor:'2',cutoffSeq:9}:{points:exactPoints(2,1),nextCursor:null,cutoffSeq:9},{cutoffSeq:9}),/序号/);
});

test('loadExact stops before dispatch when aborted',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(history.loadExact(async()=>{calls++;return {points:[],nextCursor:null,cutoffSeq:9};},{cutoffSeq:9,signal:controller.signal}),error=>error.name==='AbortError');
  assert.equal(calls,0);
});

test('celestial display advances between confirmed frames without jumping on early or late arrivals',()=>{
  const observer=history.createBodyFrameObserver();
  const frame=(tick,x)=>({tick,bodies:[{id:'star',x,y:0,z:0}],catalog:[]});
  const sample=at=>observer.sample(at).bodies[0].x;
  observer.accept(frame(0,0),0);
  observer.accept(frame(120,12),200);
  assert.equal(sample(300),6);
  observer.accept(frame(180,18),300);
  assert.equal(sample(300),6);
  assert.equal(sample(350),12);
  assert.equal(sample(900),18);
  observer.accept(frame(190,19),900);
  assert.equal(sample(900),18);
  observer.accept(frame(180,18),910);
  assert.equal(sample(1200),19);
  observer.accept(frame(200,20),1201,{paused:true});
  assert.equal(sample(1201),20);
});

test('celestial display switches collision participants at the archived impact tick',()=>{
  const observer=history.createBodyFrameObserver();
  const body=(id,x)=>({id,x,y:0,z:0});
  observer.accept({tick:0,bodies:[body('a',0),body('b',10)],catalog:[]},0);
  observer.accept({tick:20,bodies:[body('merged',8)],catalog:[
    {id:'a',endTick:10},{id:'b',endTick:10},{id:'merged',birthTick:10,mergeOrigin:{x:5,y:0,z:0}}
  ]},200);
  assert.deepEqual(observer.sample(299).bodies.map(item=>item.id),['a','b']);
  assert.deepEqual(observer.sample(300).bodies,[body('merged',5)]);
  assert.deepEqual(observer.sample(400).bodies,[body('merged',8)]);
});
