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

async function missionHarness(status='terminated',trajectoryCoverage=null,{webglAvailable=true,workerAvailable=false,stellarAvailable=false,performanceStep=0,initialServer={tick:1}}={}){
  const vm=require('node:vm'),fs=require('node:fs'),units=require('../shared/units.js'),model=require('../shared/simulation.js'),visualModule=require('../orbital-visuals.js');
  const nodes=new Map(),requests=[],frames=[],streams=[],workerMessages=[],liveRenders=[],liveTrails=[],starRenders=[],impactRenders=[],sweepRequests=[],deleteRequests=[],confirmations=[],drawImages=[],mapLabels=[],mapFills=[];
  const context2d=new Proxy({
    createRadialGradient:()=>({addColorStop(){}}),
    drawImage:(...args)=>drawImages.push(args),
    fillText:(name,x,y)=>mapLabels.push({name,x,y}),
    fill(){mapFills.push(this.fillStyle);},
    measureText:name=>({width:name.length*11})
  },{get:(target,key)=>target[key]??(()=>{})});let performanceNow=0;
  const exact={pages:[],renders:[],clearCount:0,destroyCount:0,canvas:null},stellar={frames:[],canvas:null};
  const exactStore={pointCount:0,append(points){this.pointCount+=points.length;exact.pages.push(points);return {base:this.pointCount-points.length,length:points.length};},visibleRanges(){return this.pointCount>1?[{start:0,count:this.pointCount}]:[];},clear(){this.pointCount=0;}};
  const OrbitalHistoryGL={HARD_MAX_POINTS:409600,createStore:()=>exactStore,createRenderer:canvas=>{exact.canvas=canvas;return {available:webglAvailable,append(){},render(input){exact.renders.push(input);return true;},clear(){exact.clearCount++;},destroy(){exact.destroyCount++;}}}};
  function node(id){if(nodes.has(id))return nodes.get(id);let value='';const handlers={};const result={id,children:[],afterItems:[],attributes:{},style:{},dataset:{},checked:false,hidden:false,disabled:false,textContent:'',get value(){return value;},set value(v){value=String(v);},setAttribute(name,attributeValue){this.attributes[name]=String(attributeValue);},removeAttribute(name){delete this.attributes[name];},addEventListener(type,fn){handlers[type]=fn;},dispatch(type,event={}){handlers[type]?.(event);},after(...items){this.afterItems.push(...items);},remove(){},append(...items){this.children.push(...items);},querySelector(selector){return node(id+selector);},getContext(){return context2d;},getBoundingClientRect(){return {width:1000,height:800,left:0,top:0};},classList:{toggle(){},add(){},remove(){}}};nodes.set(id,result);return result;}
  for(const [id,value]of Object.entries({name:'',x:units.toKm(500),y:0,massKg:1000,speed:0,directionDeg:0,rate:1}))node(id).value=value;
  const satellite={id:'one',name:'卫星',massKg:1000,initial:{speed:0},status,state:{tick:240001,elapsedSeconds:1000.001,x:500,y:0,vx:0,vy:1},...(trajectoryCoverage?{trajectoryCoverage}:{})};
  node('exportJson').dataset.export='json';
  const reply=data=>({ok:true,json:async()=>data});
  const sandbox={OrbitalSweep:require('../shared/map-sweep.js'),OrbitalHistory:history,OrbitalHistoryGL,OrbitalUnits:units,OrbitalModel:model,OrbitalCamera:require('../camera.js'),OrbitalVisuals:{create:()=>({blackhole(){},star(_ctx,point,appearance,body){starRenders.push({point,appearance,body});},trail(_ctx,points){liveRenders.push(points.at(-1));liveTrails.push(points);},satellite(){},impact(_ctx,impactView,age,mass,angle){impactRenders.push({impactView,age,mass,angle});},mapImpact(){}}),satelliteAppearance:()=>({opacity:0,radius:0}),stellarAppearance:(scale,body)=>({radius:body.collisionRadius*scale,markerRadius:3}),blackHoleAppearance:visualModule.blackHoleAppearance},document:{getElementById:node,createElement:tag=>node('created-'+nodes.size+'-'+tag),querySelectorAll:selector=>selector==='[data-export]'?[node('exportJson')]:[],hidden:false},confirm:text=>{confirmations.push(text);return true;},performance:{now:()=>performanceNow},matchMedia:()=>({matches:false}),ResizeObserver:class{constructor(callback){this.callback=callback;}observe(){this.callback();}},...(workerAvailable?{Worker:class{postMessage(message){workerMessages.push(message);}}}:{}),devicePixelRatio:1,requestAnimationFrame:fn=>frames.push(fn),setTimeout:fn=>{if(workerAvailable)fn();return 0;},clearTimeout(){},URLSearchParams,AbortController,DOMException,EventSource:class{constructor(){streams.push(this);}addEventListener(type,handler){this[type]=handler;}close(){}},fetch:async(path,options)=>{
    if(path.includes('/trajectory?'))return new Promise(resolve=>requests.push({path,options,resolve:data=>resolve(reply(data))}));
    if(path==='/api/session/guest')return reply({user:{id:'user'},csrfToken:'token'});
    if(path==='/api/model')return reply({model:model.MODEL,server:initialServer});
    if(path==='/api/satellites')return reply({satellites:[satellite],server:initialServer,nextCursor:null});
    if(path==='/api/satellites/active')return reply({satellites:[satellite],server:{tick:1}});
    if(path==='/api/satellites/terminate-many'){sweepRequests.push(JSON.parse(options.body));return reply({satellites:[{...satellite,status:'terminated'}]});}
    if(path==='/api/satellites/one'&&options?.method==='DELETE')return new Promise(resolve=>deleteRequests.push({path,options,resolve:()=>resolve(reply({deleted:{id:'one'}}))}));
    if(path==='/api/satellites/one/exports')return reply({export:{id:'export-one',format:'json',status:'ready',cutoffTick:trajectoryCoverage?.endTick??satellite.state.tick,trajectoryCoverage}});
    return reply({satellite});
  }};
  sandbox.performance.now=()=>{const now=performanceNow;performanceNow+=performanceStep;return now;};
  sandbox.OrbitalStellar={createRenderer:canvas=>{stellar.canvas=canvas;return {available:stellarAvailable,render(input){stellar.frames.push(input);return stellarAvailable;},destroy(){}};}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../mission.js'),'utf8'),sandbox);
  const flush=()=>new Promise(resolve=>setImmediate(resolve));await flush();
  await node('satellites').children[0].onclick();
  return {node,requests,flush,frames,streams,workerMessages,setPerformanceNow:value=>{performanceNow=value;},satellite,liveRenders,liveTrails,starRenders,impactRenders,sweepRequests,deleteRequests,confirmations,drawImages,mapLabels,mapFills,exact,stellar};
}

function windowPoints(from,to){return [{seq:from+1,tick:from*240,elapsedSeconds:from,x:500,y:0,vx:0,vy:1},{seq:to+1,tick:to*240,elapsedSeconds:to,x:500,y:1,vx:0,vy:1}];}
const localRequests=h=>h.requests.filter(request=>request.path.includes('fromTick='));
const exactRequests=h=>h.requests.filter(request=>!request.path.includes('fromTick='));

test('mission discloses a capped trajectory and limits replay and export to its coverage',async()=>{
 const coverage={status:'capped',estimatedBytes:104857600,limitBytes:104857600,estimatedBytesPerPoint:256,maxPoints:409600,lastSeq:409600,endTick:120000,endElapsedSeconds:500,truncated:true};
 const h=await missionHarness('active',coverage);
 assert.match(h.node('detailMeta').textContent,/轨迹记录已达约 100 MiB 上限/);
 assert.match(h.node('satellites').children[0].children[1].textContent,/轨迹已截断/);
 const loading=h.node('history').onclick();h.requests[0].resolve({points:windowPoints(0,10),nextCursor:null,cutoffSeq:coverage.lastSeq,trajectoryCoverage:coverage});await loading;
 assert.equal(Number(h.node('timeline').max),coverage.endElapsedSeconds);
 assert.match(h.node('historyMessage').textContent,/轨迹仅记录到存储上限/);
 await h.node('exportJson').onclick();assert.match(h.node('historyMessage').textContent,/轨迹导出已就绪/);assert.match(h.node('historyMessage').textContent,/轨迹已截断/);
});

test('recording trajectory keeps the lifecycle replay endpoint',async()=>{
 const coverage={status:'recording',estimatedBytes:2560,limitBytes:104857600,estimatedBytesPerPoint:256,maxPoints:409600,lastSeq:10,endTick:216000,endElapsedSeconds:900,truncated:false};
 const h=await missionHarness('terminated',coverage),loading=h.node('history').onclick();
 h.requests[0].resolve({points:windowPoints(0,10),nextCursor:null,cutoffSeq:10,trajectoryCoverage:coverage});await loading;
 assert.equal(Number(h.node('timeline').max),h.satellite.state.elapsedSeconds);
 assert.doesNotMatch(h.node('detailMeta').textContent,/100 MiB/);
});

test('mission permanently deletes the selected satellite after explicit confirmation',async()=>{
 const h=await missionHarness('active'),deleting=h.node('deleteRecord').onclick();h.deleteRequests[0].resolve();await deleting;
 assert.equal(h.confirmations.length,1);assert.match(h.confirmations[0],/永久删除/);assert.match(h.confirmations[0],/无法恢复/);
 assert.equal(h.deleteRequests.length,1);assert.equal(h.deleteRequests[0].options.method,'DELETE');
 assert.equal(h.node('detail').hidden,true);assert.match(h.node('notice').textContent,/已永久删除/);
});

test('a confirmed deletion still clears the record if replay opens before the response arrives',async()=>{
 const h=await missionHarness('active'),deleting=h.node('deleteRecord').onclick();
 const historyLoad=h.node('history').onclick();assert.equal(h.requests.length,1);
 h.deleteRequests[0].resolve();await deleting;
 assert.equal(h.node('detail').hidden,true);assert.match(h.node('notice').textContent,/已永久删除/);
 h.requests[0].resolve({points:windowPoints(0,10),nextCursor:null,cutoffSeq:10});await historyLoad;
 assert.equal(h.node('detail').hidden,true);
});

test('mission clamps extreme zoom requests to the observable scale and keeps distant satellites locatable',async()=>{
 const h=await missionHarness(),U=require('../shared/units.js');
 h.node('resetView').onclick();h.node('zoom').value=0;h.node('zoom').dispatch('input');h.node('blackHoleMarker').onclick();
 const canvas=h.node('universe');
 for(let i=0;i<3;i++)canvas.dispatch('wheel',{deltaY:1e6,deltaMode:0,clientX:500,clientY:400,preventDefault(){}});
 h.node('blackHoleMarker').onclick();canvas.dispatch('click',{clientX:0,clientY:0});
 assert.ok(Math.abs(Math.hypot(Number(h.node('x').value),Number(h.node('y').value))-U.toKm(90000))<1e-4);
 assert.match(h.node('physicalScale').textContent,/1\.9884e\+31 kg/);
 assert.match(h.node('observationRange').textContent,/不是引力边界/);
 assert.match(h.node('observationRange').textContent,/10 分钟/);
 h.node('x').value=1e6;h.node('y').value=0;h.node('locate').onclick();
 canvas.dispatch('click',{clientX:500,clientY:416});
 assert.ok(Math.abs(Number(h.node('x').value)-1e6)<1e-5);
 assert.ok(Math.abs(Number(h.node('y').value))<1e-5);
 assert.equal(h.satellite.state.x,500);
});

test('mission removes an outward satellite from the map and labels its archive after crossing',async()=>{
 const h=await missionHarness('active');
 const exiting={...h.satellite,state:{...h.satellite.state,x:89999.9,y:0,vx:200,vy:0}};
 h.streams.at(-1).snapshot({data:JSON.stringify({satellites:[exiting],server:{tick:2,status:'running'}})});
 h.frames[0](16);
 assert.equal(h.liveRenders.length,0);
 assert.match(h.node('detailMeta').textContent,/超出可观测区域/);
 h.streams.at(-1).snapshot({data:JSON.stringify({satellites:[{...exiting,status:'out_of_observable',endReason:'out_of_observable',state:{...exiting.state,x:90000,status:'out_of_observable'}}],server:{tick:3,status:'recovering'}})});
 h.frames[1](32);assert.equal(h.liveRenders.length,0);
 assert.match(h.node('detailMeta').textContent,/超出可观测区域/);
});

test('mission draws all prescribed stars and centers a stellar capture effect on the impacted star',async()=>{
 const h=await missionHarness('active');h.frames[0](16);
 assert.equal(h.starRenders.length,9);
 const event={type:'captured',bodyType:'star',bodyId:'ember',bodyName:'烬星',bodyX:420,bodyY:25,fieldTick:2,substepFraction:.5,x:404,y:25,elapsedSeconds:1};
 const captured={...h.satellite,status:'captured',endReason:'captured',state:{...h.satellite.state,status:'captured',event}};
 h.streams.at(-1).snapshot({data:JSON.stringify({satellites:[captured],server:{tick:2,status:'running'}})});
 h.frames[1](32);
 const impact=h.impactRenders.at(-1),hole=h.impactRenders.find(item=>item!==impact);
 assert.ok(impact);
 assert.notEqual(impact.impactView.cx,500);
 assert.notEqual(impact.impactView.cy,392);
 assert.match(h.node('notice').textContent,/撞上恒星 · 存活/);
 assert.equal(hole,undefined);
});

test('mission composites the procedural field and keeps stellar close-ups centered without changing orbit data',async()=>{
  const h=await missionHarness('active',null,{stellarAvailable:true});
  h.node('stellarFocus').value='ember';h.node('stellarFocus').dispatch('change');h.frames[0](0);
  assert.ok(h.stellar.frames.length>0);assert.equal(h.stellar.frames.at(-1).bodies.length,9);
  const first=h.stellar.frames.at(-1).bodies.find(b=>b.star.id==='ember');
  assert.ok(Math.abs(first.x-500)<1e-8&&Math.abs(first.y-416)<1e-8);
  assert.ok(h.drawImages.some(args=>args[0]===h.stellar.canvas));
  assert.equal(h.starRenders.length,0);assert.equal(h.node('trackSelected').attributes['aria-pressed'],'false');
  h.setPerformanceNow(200);h.frames[1](200);const moved=h.stellar.frames.at(-1).bodies.find(b=>b.star.id==='ember');
  assert.ok(Math.abs(moved.x-500)<1e-8&&Math.abs(moved.y-416)<1e-8);
  assert.notEqual(first.star.x,moved.star.x);
  h.node('universe').dispatch('keydown',{key:'ArrowLeft',preventDefault(){}});
  assert.equal(h.node('stellarFocus').value,'');
  h.node('stellarFocus').value='colossus';h.node('stellarFocus').dispatch('change');
  h.node('resetView').onclick();assert.equal(h.node('stellarFocus').value,'');
  h.node('zoom').value=1000;h.node('zoom').dispatch('input');assert.equal(h.node('zoomValue').textContent,'6400%');
});

test('subpixel stars retain their individual colors on the full map without name labels',async()=>{
  const h=await missionHarness('active',null,{stellarAvailable:true});
  h.node('resetView').onclick();
  h.node('zoom').value=0;h.node('zoom').dispatch('input');
  h.node('blackHoleMarker').onclick();h.frames[0](0);
  const bodies=h.stellar.frames.at(-1).bodies;
  assert.ok(bodies.every(body=>body.radius<1));
  for(const {star} of bodies)assert.ok(h.mapFills.includes(star.color),star.color);
  assert.ok(h.mapLabels.every(label=>bodies.every(body=>body.star.name!==label.name)));
  assert.ok(h.node('stellarFocus').children.every(option=>/^恒星 \d+$/.test(option.textContent)));
});

test('stellar close-up and its surface share one world phase even when drawing takes time',async()=>{
  const h=await missionHarness('active',null,{stellarAvailable:true,performanceStep:20});
  h.node('stellarFocus').value='ember';h.node('stellarFocus').dispatch('change');h.frames[0](0);
  const body=h.stellar.frames.at(-1).bodies.find(b=>b.star.id==='ember');
  assert.ok(Math.hypot(body.x-500,body.y-416)<1e-8,'the close-up must not drift between camera placement and surface drawing');
});

test('paused observation keeps launch prediction synchronized to the latest server world tick',async()=>{
 const h=await missionHarness('active',null,{workerAvailable:true});h.workerMessages.length=0;
  h.node('pause').onclick();h.setPerformanceNow(10000);
  h.streams.at(-1).snapshot({data:JSON.stringify({satellites:[],server:{tick:2401,status:'running'}})});
 h.node('predict').checked=true;h.node('x').dispatch('input');
  assert.equal(h.workerMessages.at(-1).fieldTick,2401);
});

test('stellar observation advances smoothly while recovery packets jump ahead and prediction stays authoritative',async()=>{
  const h=await missionHarness('active',null,{workerAvailable:true,initialServer:{tick:240000,status:'recovering',lagSeconds:1000000}});
  const star=()=>h.starRenders.findLast(item=>item.body.id==='ember').body;
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  h.frames[0](0);const initial=star();
  const M=require('../shared/simulation.js'),expected=M.stellarBodiesAtTick(240000)[0];
  assert.ok(distance(initial,expected)<1e-8,'initial observation uses the persisted world phase');
  h.setPerformanceNow(200);h.frames[1](200);const before=star();
  assert.ok(distance(initial,before)>1&&distance(initial,before)<20,'stars advance by wall time');
  for(let i=1;i<=3;i++){
    h.streams.at(-1).snapshot({data:JSON.stringify({satellites:[],server:{tick:240000+i*8880,status:'recovering',lagSeconds:1000000-i*37}})});
    h.frames[i+1](200);
    assert.ok(distance(before,star())<1e-8,'catch-up packets must not teleport the observed stars');
  }
  h.node('predict').checked=true;h.node('x').dispatch('input');
  assert.equal(h.workerMessages.at(-1).fieldTick,266640,'launch prediction follows the actual server clock');
  h.setPerformanceNow(400);h.frames[5](400);
  assert.ok(distance(before,star())>1&&distance(before,star())<20,'observation keeps moving between packets');
  h.node('pause').onclick();h.frames[6](400);const paused=star();
  h.setPerformanceNow(1400);
  h.streams.at(-1).snapshot({data:JSON.stringify({satellites:[],server:{tick:300000,status:'recovering',lagSeconds:900000}})});
  h.frames[7](1400);
  assert.ok(distance(paused,star())<1e-8,'pause keeps the observed phase fixed');
});

test('mission rapid seeks abort older windows and ignore their late responses',async()=>{
  const h=await missionHarness(),initial=h.node('history').onclick();
  assert.equal(Number(h.node('timeline').max),1000.001);
  h.requests[0].resolve({points:windowPoints(0,10),nextCursor:null,cutoffSeq:500});await initial;
  h.node('timeline').value=100;h.node('timeline').oninput();
  h.node('timeline').value=500;h.node('timeline').oninput();
  const windows=localRequests(h);assert.equal(windows[1].options.signal.aborted,true);
  assert.ok(windows[2].path.includes('cutoffSeq=500'));
  windows[2].resolve({points:windowPoints(490,510),nextCursor:null,cutoffSeq:500});await h.flush();
  const message=h.node('historyMessage').textContent;
  windows[1].resolve({points:windowPoints(90,110),nextCursor:null,cutoffSeq:500});await h.flush();
  assert.equal(h.node('timeline').value,'500');
  assert.equal(h.node('historyMessage').textContent,message);
  h.node('timeline').value=501;h.node('timeline').oninput();assert.equal(localRequests(h).length,3);
});

test('mission leaving replay cancels requests and ignores late responses',async()=>{
  const h=await missionHarness(),initial=h.node('history').onclick();
  h.requests[0].resolve({points:windowPoints(0,10),nextCursor:null,cutoffSeq:500});await initial;
  h.node('timeline').value=500;h.node('timeline').oninput();
  const window=localRequests(h)[1];h.node('live').onclick();assert.equal(window.options.signal.aborted,true);
  window.resolve({points:windowPoints(490,510),nextCursor:null,cutoffSeq:500});await h.flush();
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
  h.frames[0](16);assert.equal(localRequests(h).length,2);const pausedTime=h.node('timeline').value;
  h.frames[1](100);assert.equal(h.node('timeline').value,pausedTime);assert.equal(localRequests(h).length,2);
  localRequests(h)[1].resolve({points:windowPoints(1,22),nextCursor:null,cutoffSeq:500});await h.flush();
  h.frames[2](150);assert.ok(Number(h.node('timeline').value)>Number(pausedTime));assert.equal(h.node('play').textContent,'暂停');
});

test('mission local seeks do not reset the exact trajectory store',async()=>{
  const h=await missionHarness(),initial=h.node('history').onclick();
  h.requests[0].resolve({points:windowPoints(0,10),nextCursor:null,cutoffSeq:500});await initial;
  exactRequests(h)[0].resolve({points:exactPoints(1,2),nextCursor:null,cutoffSeq:500});await h.flush();
  const clears=h.exact.clearCount;
  h.node('timeline').value=20;h.node('timeline').oninput();
  localRequests(h)[1].resolve({points:windowPoints(10,30),nextCursor:null,cutoffSeq:500});await h.flush();
  assert.equal(h.exact.pages.flat().length,2);assert.equal(h.exact.clearCount,clears);
  assert.match(h.node('historyMessage').textContent,/完整精确轨迹/);
});

test('mission switching satellites rejects a late history window and preserves patch metadata',async()=>{
  const h=await missionHarness(),initial=h.node('history').onclick();
  h.requests[0].resolve({points:windowPoints(0,10),nextCursor:null,cutoffSeq:500});await initial;
  h.node('timeline').value=500;h.node('timeline').oninput();
  h.streams.at(-1).snapshot({data:JSON.stringify({satellites:[{...h.satellite,id:'other',name:'另一颗',state:{...h.satellite.state,tick:241000}}],server:{tick:2}})});
  const lateWindow=localRequests(h)[1];await h.node('satellites').children[1].onclick();assert.equal(lateWindow.options.signal.aborted,true);
  lateWindow.resolve({points:windowPoints(490,510),nextCursor:null,cutoffSeq:500});await h.flush();
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

test('mission keeps observation moving during recovery and displays the observed velocity',async()=>{
  const h=await missionHarness('active');h.frames[0](10);const before=h.liveRenders.at(-1);
  h.streams.at(-1).snapshot({data:JSON.stringify({satellites:[{id:'one',state:{...h.satellite.state,tick:250000,x:-500},status:'active'}],server:{tick:2,status:'recovering',lagSeconds:1000}})});
  h.frames[1](110);assert.ok(Math.hypot(h.liveRenders.at(-1).x-before.x,h.liveRenders.at(-1).y-before.y)>.01);
  assert.ok(h.node('viewMode').textContent.includes('补算'));
  assert.ok(!h.node('viewMode').textContent.includes('固定'));
  const units=require('../shared/units.js');assert.ok(h.node('detailSpeed').textContent.includes(units.formatSpeed(h.liveRenders.at(-1))));
  h.streams.at(-1).snapshot({data:JSON.stringify({satellites:[],server:{tick:3,status:'running',lagSeconds:0}})});
  h.frames[2](210);assert.ok(Math.abs(h.liveRenders.at(-1).x+500)<1);
  assert.ok(h.liveTrails.at(-1).every(p=>p.x<0));
});

test('a new live packet starts from the position currently on screen without jumping ahead',async()=>{
  const M=require('../shared/simulation.js'),h=await missionHarness('active');
  const state=M.createState({name:'arc',position:{x:220,y:0},massKg:1000,speed:M.circularSpeed(220),directionDeg:90},{continuousTracking:true});
  state.tick=240010;state.elapsedSeconds=state.tick/240;
  const send=()=>h.streams.at(-1).snapshot({data:JSON.stringify({satellites:[{id:'one',state:{...state},status:'active'}],server:{tick:2}})});
  send();for(let i=0;i<48;i++)M.step(state);send();h.frames[0](100);const before=h.liveRenders.at(-1);
  for(let i=0;i<48;i++)M.step(state);send();h.frames[1](100);
  assert.ok(Math.hypot(h.liveRenders.at(-1).x-before.x,h.liveRenders.at(-1).y-before.y)<1e-9);
  h.frames[2](300);assert.ok(Math.abs(h.liveRenders.at(-1).elapsedSeconds-(240010/240+.3))<1e-9);
});

test('mission continues moving after reaching the latest packet endpoint',async()=>{
  const M=require('../shared/simulation.js'),h=await missionHarness('active');
  const state=M.createState({name:'continuous',position:{x:220,y:0},massKg:1000,speed:M.circularSpeed(220),directionDeg:90},{continuousTracking:true});
  state.tick=240010;state.elapsedSeconds=state.tick/240;
  const send=()=>h.streams.at(-1).snapshot({data:JSON.stringify({satellites:[{id:'one',state:{...state},status:'active'}],server:{tick:2}})});
  send();for(let i=0;i<48;i++)M.step(state);send();h.frames[0](200);const before=h.liveRenders.at(-1);
  h.frames[1](350);assert.ok(Math.hypot(h.liveRenders.at(-1).x-before.x,h.liveRenders.at(-1).y-before.y)>15);
  assert.ok(Math.abs(Math.hypot(h.liveRenders.at(-1).x,h.liveRenders.at(-1).y)-220)<.01);
});
test('map sweep progressively removes satellites, terminates them and rejects late active display patches',async()=>{
  const h=await missionHarness('active');await h.node('sweepAll').onclick();
  h.frames[0](10);assert.equal(h.sweepRequests.length,0);
  for(let i=1;i<=90;i++){h.frames[i](i*100);await h.flush();}
  assert.deepEqual(h.sweepRequests.flatMap(r=>r.ids),['one']);
  const rendered=h.liveRenders.length;
  h.streams.at(-1).snapshot({data:JSON.stringify({satellites:[{...h.satellite}],server:{tick:3}})});
  h.frames[91](9100);assert.equal(h.liveRenders.length,rendered);
  assert.equal(h.node('sweepAll').disabled,false);
});
test('an empty map still plays the wave for longer than one minute without terminating historical satellites',async()=>{
  const h=await missionHarness('terminated');await h.node('sweepAll').onclick();
  assert.equal(h.node('sweepAll').textContent,'停止冲击波');
  for(let i=0;i<630;i++)h.frames[i](i*100);
  assert.equal(h.sweepRequests.length,0);assert.equal(h.node('sweepAll').textContent,'停止冲击波');
  assert.match(h.node('viewMode').textContent,/剩余约 9\.0 分钟/);
});
test('stopping a wave leaves satellites it has not reached running',async()=>{
  const h=await missionHarness('active');await h.node('sweepAll').onclick();h.frames[0](100);
  assert.equal(h.node('sweepAll').disabled,false);await h.node('sweepAll').onclick();
  h.frames[1](200);await h.flush();
  assert.equal(h.sweepRequests.length,0);assert.equal(h.node('sweepAll').textContent,'全图冲击波');
  assert.ok(h.node('notice').textContent.includes('已停止'));assert.ok(h.liveRenders.length>0);
});

test('full-map wave reaches the expanded observation boundary in ten minutes even after panning',async()=>{
 const h=await missionHarness('terminated');await h.node('sweepAll').onclick();
 for(let i=0;i<50;i++)h.node('universe').dispatch('keydown',{key:'ArrowLeft',shiftKey:true,preventDefault(){}});
 for(let i=0;i<=600;i++){h.frames[i](i*100);await h.flush();}
 assert.match(h.node('viewMode').textContent,/4,027\.16 km/);
 assert.match(h.node('viewMode').textContent,/剩余约 9\.0 分钟/);
 for(let i=601;i<6008;i++)h.frames[i](i*100);
 assert.equal(h.node('sweepAll').textContent,'全图冲击波');
 assert.ok(h.node('notice').textContent.includes('已清除 0'));
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

test('mission streams the fixed-cutoff full history independently from local cached seeks',async()=>{
  const h=await missionHarness(),opening=h.node('history').onclick();
  h.requests[0].resolve({points:windowPoints(0,10),nextCursor:null,cutoffSeq:20,trajectoryCoverage:{status:'recording',lastSeq:20,endTick:4800,endElapsedSeconds:20}});await h.flush();
  assert.ok(h.requests[1].path.includes('cutoffSeq=20'));assert.ok(h.requests[1].path.includes('limit=5000'));
  h.requests[1].resolve({points:exactPoints(1,10),nextCursor:'10',cutoffSeq:20});await h.flush();
  h.node('timeline').value=9;h.node('timeline').oninput();
  assert.equal(h.requests[2].options.signal.aborted,false);
  h.requests[2].resolve({points:exactPoints(11,10),nextCursor:null,cutoffSeq:20});await h.flush();await opening;
  assert.equal(h.exact.pages.flat().length,20);assert.match(h.node('historyMessage').textContent,/完整精确轨迹/);
});

test('historical replay omits velocity and center distance while live telemetry keeps them',async()=>{
  const h=await missionHarness('active');h.frames[0](16);
  assert.match(h.node('telemetryHud').textContent,/距中心/);
  assert.match(h.node('telemetryHud').textContent,/km\/s/);
  const opening=h.node('history').onclick();
  h.requests[0].resolve({points:windowPoints(0,10),nextCursor:null,cutoffSeq:10});await opening;
  h.frames[1](32);
  assert.equal(h.node('telemetryHud').textContent,'回放 / 卫星 · 0.00 模拟秒');
  assert.equal(h.node('replayTime').textContent,'0.00 模拟秒');
  assert.doesNotMatch(h.node('historyMessage').textContent,/速度|距中心/);
  assert.match(h.node('detailSpeed').textContent,/速度/);
  assert.match(h.node('satellites').children[0].children[1].textContent,/速度/);
  h.node('timeline').value=5;h.node('timeline').oninput();h.frames[2](48);
  assert.equal(h.node('telemetryHud').textContent,'回放 / 卫星 · 5.00 模拟秒');
  assert.equal(h.node('replayTime').textContent,'5.00 模拟秒');
  assert.doesNotMatch(h.node('telemetryHud').textContent,/km\/s|距中心/);
  h.node('live').onclick();h.frames[3](64);
  assert.match(h.node('telemetryHud').textContent,/距中心/);
  assert.match(h.node('telemetryHud').textContent,/km\/s/);
});

test('mission composites exact history as a dedicated DOM layer without copying it into the 2D canvas',async()=>{
  const h=await missionHarness(),opening=h.node('history').onclick();
  assert.equal(h.exact.canvas.id,'historyTrajectory');
  assert.ok(h.node('universe').afterItems.includes(h.exact.canvas));
  assert.equal(h.exact.canvas.attributes['aria-hidden'],'true');
  assert.deepEqual({...h.exact.canvas.style},{position:'absolute',inset:'0',width:'100%',height:'100%',pointerEvents:'none',cursor:'default'});
  h.requests[0].resolve({points:windowPoints(0,10),nextCursor:null,cutoffSeq:10});await h.flush();
  h.requests[1].resolve({points:exactPoints(1,10),nextCursor:null,cutoffSeq:10});await h.flush();await opening;
  h.frames[0](16);
  assert.equal(h.exact.canvas.hidden,false);
  assert.ok(h.exact.renders.length>0);
  assert.equal(h.drawImages.length,0);
  h.node('live').onclick();
  assert.equal(h.exact.canvas.hidden,true);
});

test('leaving replay aborts exact loading and ignores a late page',async()=>{
  const h=await missionHarness(),opening=h.node('history').onclick();
  h.requests[0].resolve({points:windowPoints(0,2),nextCursor:null,cutoffSeq:20});await h.flush();
  const exactRequest=h.requests[1];h.node('live').onclick();assert.equal(exactRequest.options.signal.aborted,true);
  exactRequest.resolve({points:exactPoints(1,10),nextCursor:null,cutoffSeq:20});await h.flush();
  assert.equal(h.exact.pages.length,0);assert.ok(h.exact.clearCount>0);await opening;
});

test('switching satellites and deleting the selected record reject late exact pages',async()=>{
  const switched=await missionHarness(),switchOpen=switched.node('history').onclick();
  switched.requests[0].resolve({points:windowPoints(0,2),nextCursor:null,cutoffSeq:20});await switched.flush();
  const switchLate=switched.requests[1];
  switched.streams.at(-1).snapshot({data:JSON.stringify({satellites:[{...switched.satellite,id:'other',name:'另一颗'}],server:{tick:2}})});
  await switched.node('satellites').children[1].onclick();assert.equal(switchLate.options.signal.aborted,true);
  switchLate.resolve({points:exactPoints(1,10),nextCursor:null,cutoffSeq:20});await switched.flush();assert.equal(switched.exact.pages.length,0);await switchOpen;

  const deleted=await missionHarness(),deleteOpen=deleted.node('history').onclick();
  deleted.requests[0].resolve({points:windowPoints(0,2),nextCursor:null,cutoffSeq:20});await deleted.flush();
  const deleteLate=deleted.requests[1],deleting=deleted.node('deleteRecord').onclick();deleted.deleteRequests[0].resolve();await deleting;
  assert.equal(deleteLate.options.signal.aborted,true);deleteLate.resolve({points:exactPoints(1,10),nextCursor:null,cutoffSeq:20});await deleted.flush();
  assert.equal(deleted.exact.pages.length,0);await deleteOpen;
});

test('WebGL unavailable keeps local replay and shows a clear explanation',async()=>{
  const h=await missionHarness('active',null,{webglAvailable:false}),opening=h.node('history').onclick();
  h.requests[0].resolve({points:windowPoints(0,10),nextCursor:null,cutoffSeq:10});await opening;
  h.frames[0](16);
  assert.equal(h.exact.canvas.hidden,true);
  assert.equal(h.node('replay').hidden,false);assert.match(h.node('historyMessage').textContent,/不支持完整精确轨迹/);
});
