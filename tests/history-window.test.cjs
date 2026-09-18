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

async function missionHarness(status='terminated'){
  const vm=require('node:vm'),fs=require('node:fs'),units=require('../shared/units.js'),model=require('../shared/simulation.js');
  const nodes=new Map(),requests=[],frames=[],streams=[],liveRenders=[],liveTrails=[],context2d=new Proxy({}, {get:(_,key)=>key==='createRadialGradient'?()=>({addColorStop(){}}):()=>{}});
  function node(id){if(nodes.has(id))return nodes.get(id);let value='';const result={id,children:[],style:{},dataset:{},checked:false,hidden:false,disabled:false,textContent:'',get value(){return value;},set value(v){value=String(v);},setAttribute(){},removeAttribute(){},addEventListener(){},after(){},remove(){},append(...items){this.children.push(...items);},querySelector(selector){return node(id+selector);},getContext(){return context2d;},getBoundingClientRect(){return {width:1000,height:800,left:0,top:0};},classList:{toggle(){},add(){},remove(){}}};nodes.set(id,result);return result;}
  for(const [id,value]of Object.entries({name:'',x:units.toKm(500),y:0,massKg:1000,speed:0,directionDeg:0,rate:1}))node(id).value=value;
  const satellite={id:'one',name:'卫星',massKg:1000,initial:{speed:0},status,state:{tick:240001,elapsedSeconds:1000.001,x:500,y:0,vx:0,vy:1}};
  const reply=data=>({ok:true,json:async()=>data});
  const sandbox={OrbitalHistory:history,OrbitalUnits:units,OrbitalModel:model,OrbitalCamera:require('../camera.js'),OrbitalVisuals:{create:()=>({blackhole(){},trail(_ctx,points){liveRenders.push(points.at(-1));liveTrails.push(points);},satellite(){},impact(){}}),satelliteAppearance:()=>({opacity:0,radius:0})},document:{getElementById:node,createElement:tag=>node('created-'+nodes.size+'-'+tag),querySelectorAll:()=>[],hidden:false},performance:{now:()=>0},matchMedia:()=>({matches:false}),ResizeObserver:class{constructor(callback){this.callback=callback;}observe(){this.callback();}},devicePixelRatio:1,requestAnimationFrame:fn=>frames.push(fn),setTimeout:()=>0,clearTimeout(){},URLSearchParams,AbortController,DOMException,EventSource:class{constructor(){streams.push(this);}addEventListener(type,handler){this[type]=handler;}close(){}},fetch:async(path,options)=>{
    if(path.includes('/trajectory?'))return new Promise(resolve=>requests.push({path,options,resolve:data=>resolve(reply(data))}));
    if(path==='/api/session/guest')return reply({user:{id:'user'},csrfToken:'token'});
    if(path==='/api/model')return reply({model:model.MODEL,server:{tick:1}});
    if(path==='/api/satellites')return reply({satellites:[satellite],server:{tick:1},nextCursor:null});
    return reply({satellite});
  }};
  vm.runInNewContext(fs.readFileSync(require.resolve('../mission.js'),'utf8'),sandbox);
  const flush=()=>new Promise(resolve=>setImmediate(resolve));await flush();
  await node('satellites').children[0].onclick();
  return {node,requests,flush,frames,streams,satellite,liveRenders,liveTrails};
}

function windowPoints(from,to){return [{seq:from+1,tick:from*240,elapsedSeconds:from,x:500,y:0,vx:0,vy:1},{seq:to+1,tick:to*240,elapsedSeconds:to,x:500,y:1,vx:0,vy:1}];}

test('mission rapid seeks abort older windows and ignore their late responses',async()=>{
  const h=await missionHarness(),initial=h.node('history').onclick();
  assert.equal(Number(h.node('timeline').max),1000.001);
  h.requests[0].resolve({points:windowPoints(0,10),nextCursor:null,cutoffSeq:500});await initial;
  h.node('timeline').value=100;h.node('timeline').oninput();
  h.node('timeline').value=500;h.node('timeline').oninput();
  assert.equal(h.requests[1].options.signal.aborted,true);
  assert.ok(h.requests[2].path.includes('cutoffSeq=500'));
  h.requests[2].resolve({points:windowPoints(490,510),nextCursor:null,cutoffSeq:500});await h.flush();
  const message=h.node('historyMessage').textContent;
  h.requests[1].resolve({points:windowPoints(90,110),nextCursor:null,cutoffSeq:500});await h.flush();
  assert.equal(h.node('timeline').value,'500');
  assert.equal(h.node('historyMessage').textContent,message);
  h.node('timeline').value=501;h.node('timeline').oninput();assert.equal(h.requests.length,3);
});

test('mission leaving replay cancels requests and ignores late responses',async()=>{
  const h=await missionHarness(),initial=h.node('history').onclick();
  h.requests[0].resolve({points:windowPoints(0,10),nextCursor:null,cutoffSeq:500});await initial;
  h.node('timeline').value=500;h.node('timeline').oninput();
  h.node('live').onclick();assert.equal(h.requests[1].options.signal.aborted,true);
  h.requests[1].resolve({points:windowPoints(490,510),nextCursor:null,cutoffSeq:500});await h.flush();
  assert.equal(h.node('replay').hidden,true);
  assert.equal(h.node('viewMode').textContent,'实时观察');
});

test('mission does not replace a pending replay window with live satellite rendering',async()=>{
  const h=await missionHarness();
  h.streams.at(-1).snapshot({data:JSON.stringify({satellites:[{...h.satellite,id:'other',status:'active'}],server:{tick:2}})});
  const pending=h.node('history').onclick();h.frames[0](16);
  assert.equal(h.liveRenders.length,0);
  h.requests[0].resolve({points:windowPoints(0,10),nextCursor:null,cutoffSeq:500});await pending;
});

test('mission playback pauses while crossing a window edge and resumes after the page arrives',async()=>{
  const h=await missionHarness(),initial=h.node('history').onclick();
  h.requests[0].resolve({points:windowPoints(0,10),nextCursor:null,cutoffSeq:500});await initial;
  h.node('timeline').value=9.99;h.node('timeline').oninput();h.node('rate').value=100;h.node('play').onclick();
  h.frames[0](16);assert.equal(h.requests.length,2);const pausedTime=h.node('timeline').value;
  h.frames[1](100);assert.equal(h.node('timeline').value,pausedTime);assert.equal(h.requests.length,2);
  h.requests[1].resolve({points:windowPoints(1,22),nextCursor:null,cutoffSeq:500});await h.flush();
  h.frames[2](150);assert.ok(Number(h.node('timeline').value)>Number(pausedTime));assert.equal(h.node('play').textContent,'暂停');
});

test('mission switching satellites rejects a late history window and preserves patch metadata',async()=>{
  const h=await missionHarness(),initial=h.node('history').onclick();
  h.requests[0].resolve({points:windowPoints(0,10),nextCursor:null,cutoffSeq:500});await initial;
  h.node('timeline').value=500;h.node('timeline').oninput();
  h.streams.at(-1).snapshot({data:JSON.stringify({satellites:[{...h.satellite,id:'other',name:'另一颗',state:{...h.satellite.state,tick:241000}}],server:{tick:2}})});
  await h.node('satellites').children[1].onclick();assert.equal(h.requests[1].options.signal.aborted,true);
  h.requests[1].resolve({points:windowPoints(490,510),nextCursor:null,cutoffSeq:500});await h.flush();
  h.streams.at(-1).snapshot({data:JSON.stringify({satellites:[{id:'other',state:{...h.satellite.state,tick:241001},status:'terminated'}],server:{tick:3}})});
  assert.equal(h.node('detailName').textContent,'另一颗');assert.ok(h.node('detailMeta').textContent.includes('1000 kg'));
  assert.equal(h.node('replay').hidden,true);assert.equal(h.node('historyMessage').textContent,'');
});

test('mission draws a physical arc and its trail between sparse live packets',async()=>{
  const M=require('../shared/simulation.js'),h=await missionHarness('active');
  const state=M.createState({name:'arc',position:{x:220,y:0},massKg:1000,speed:M.circularSpeed(220),directionDeg:90},{continuousTracking:true});
  const send=s=>h.streams.at(-1).snapshot({data:JSON.stringify({satellites:[{id:'one',state:{...s},status:'active'}],server:{tick:2}})});
  state.tick=240010;state.elapsedSeconds=state.tick/240;send(state);
  for(let i=0;i<48;i++)M.step(state);send(state);h.frames[0](100);
  assert.ok(Math.abs(Math.hypot(h.liveRenders.at(-1).x,h.liveRenders.at(-1).y)-220)<.01);
  assert.ok(h.liveTrails.at(-1).length>10);
});

test('mission freezes observation during recovery instead of drawing accelerated jumps',async()=>{
  const h=await missionHarness('active');h.frames[0](10);const before=h.liveRenders.at(-1);
  h.streams.at(-1).snapshot({data:JSON.stringify({satellites:[{id:'one',state:{...h.satellite.state,tick:250000,x:-500},status:'active'}],server:{tick:2,status:'recovering',lagSeconds:1000}})});
  h.frames[1](110);assert.equal(h.liveRenders.at(-1).x,before.x);
  assert.ok(h.node('viewMode').textContent.includes('补算'));
  h.streams.at(-1).snapshot({data:JSON.stringify({satellites:[],server:{tick:3,status:'running',lagSeconds:0}})});
  h.frames[2](210);assert.equal(h.liveRenders.at(-1).x,-500);
  assert.equal(h.liveTrails.at(-1).length,1);
});

test('a new live packet starts from the position currently on screen without jumping ahead',async()=>{
  const M=require('../shared/simulation.js'),h=await missionHarness('active');
  const state=M.createState({name:'arc',position:{x:220,y:0},massKg:1000,speed:M.circularSpeed(220),directionDeg:90},{continuousTracking:true});
  state.tick=240010;state.elapsedSeconds=state.tick/240;
  const send=()=>h.streams.at(-1).snapshot({data:JSON.stringify({satellites:[{id:'one',state:{...state},status:'active'}],server:{tick:2}})});
  send();for(let i=0;i<48;i++)M.step(state);send();h.frames[0](100);const before=h.liveRenders.at(-1);
  for(let i=0;i<48;i++)M.step(state);send();h.frames[1](100);
  assert.ok(Math.hypot(h.liveRenders.at(-1).x-before.x,h.liveRenders.at(-1).y-before.y)<1e-9);
  h.frames[2](300);assert.ok(Math.hypot(h.liveRenders.at(-1).x-state.x,h.liveRenders.at(-1).y-state.y)<1e-9);
});

test('mission pins the first page cutoff before an interrupted initial window finishes loading',async()=>{
  const h=await missionHarness(),initial=h.node('history').onclick();
  h.requests[0].resolve({points:windowPoints(0,5),nextCursor:6,cutoffSeq:500});await h.flush();
  assert.equal(h.requests.length,2);
  h.node('timeline').value=500;h.node('timeline').oninput();
  assert.equal(h.requests[1].options.signal.aborted,true);
  assert.ok(h.requests[2].path.includes('cutoffSeq=500'));
  h.requests[2].resolve({points:windowPoints(490,510),nextCursor:null,cutoffSeq:500});await h.flush();
  h.requests[1].resolve({points:windowPoints(5,10),nextCursor:null,cutoffSeq:500});await initial;
  assert.equal(h.node('timeline').value,'500');
});

test('mission clear and show-all leave replay controls hidden',async()=>{
  for(const action of ['clear','showAll']){
    const h=await missionHarness(),initial=h.node('history').onclick();
    h.requests[0].resolve({points:windowPoints(0,10),nextCursor:null,cutoffSeq:500});await initial;
    assert.equal(h.node('replay').hidden,false);
    h.node(action).onclick();
    assert.equal(h.node('replay').hidden,true);
  }
});
