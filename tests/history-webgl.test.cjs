'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const historyGL=require('../history-webgl.js');

const point=seq=>({seq,tick:seq*240,elapsedSeconds:seq,x:4.47e8+seq*.125,y:-2.1e8+seq*.25});

test('store retains four hundred thousand exact points without resampling',()=>{
  const store=historyGL.createStore({maxPoints:409600});
  for(let start=1;start<=400000;start+=5000){
    store.append(Array.from({length:Math.min(5000,400001-start)},(_,i)=>point(start+i)));
  }
  assert.equal(store.pointCount,400000);
  assert.equal(store.chunks.length,80);
  assert.deepEqual(store.segments,[{start:0,count:400000}]);
  assert.deepEqual([store.pointAt(0).seq,store.pointAt(199999).seq,store.pointAt(399999).seq],[1,200000,400000]);
});

test('store starts a separate segment at every sequence gap',()=>{
  const store=historyGL.createStore({maxPoints:20});
  store.append([point(10),point(11),point(14)]);
  store.append([point(15),point(21)]);
  assert.deepEqual(store.segments,[{start:0,count:2},{start:2,count:2},{start:4,count:1}]);
  assert.deepEqual(store.visibleRanges(14),[{start:0,count:2}]);
  assert.deepEqual(store.visibleRanges(100),store.segments.filter(segment=>segment.count>1));
});

test('store rejects duplicate, backwards, invalid and excessive points without mutating the accepted prefix',()=>{
  const store=historyGL.createStore({maxPoints:3});
  store.append([point(1),point(2)]);
  for(const bad of [point(2),point(1),{...point(3),x:Infinity},{...point(3),seq:3.5}]){
    assert.throws(()=>store.append([bad]));
    assert.equal(store.pointCount,2);
  }
  assert.throws(()=>store.append([point(3),point(4)]),/409600|上限|maximum/i);
  assert.equal(store.pointCount,2);
});

test('single point and empty stores never invent a line',()=>{
  const empty=historyGL.createStore({maxPoints:5});
  assert.deepEqual(empty.visibleRanges(100),[]);
  empty.append([point(7)]);
  assert.deepEqual(empty.visibleRanges(100),[]);
});

function fakeGL(){
  const calls=[];let id=0;
  return {calls,ARRAY_BUFFER:34962,DYNAMIC_DRAW:35048,FLOAT:5126,LINE_STRIP:3,COLOR_BUFFER_BIT:16384,VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,COMPILE_STATUS:35713,LINK_STATUS:35714,BLEND:3042,SRC_ALPHA:770,ONE_MINUS_SRC_ALPHA:771,
    createShader:()=>({id:++id}),shaderSource(){},compileShader(){},getShaderParameter:()=>true,getShaderInfoLog:()=>'',createProgram:()=>({id:++id}),attachShader(){},linkProgram(){},getProgramParameter:()=>true,getProgramInfoLog:()=>'',getAttribLocation:(_p,n)=>n==='aHigh'?0:1,getUniformLocation:(_p,n)=>n,
    createBuffer:()=>({id:++id}),bindBuffer(){},bufferData(...a){calls.push(['bufferData',...a]);},bufferSubData(...a){calls.push(['bufferSubData',...a]);},viewport(){},clearColor(){},clear(){},useProgram(){},enable(){},blendFunc(){},enableVertexAttribArray(){},vertexAttribPointer(){},uniform2f(...a){calls.push(['uniform2f',...a]);},uniform1f(...a){calls.push(['uniform1f',...a]);},drawArrays(...a){calls.push(['drawArrays',...a]);},deleteBuffer(){calls.push(['deleteBuffer']);},deleteProgram(){calls.push(['deleteProgram']);}};
}
function fakeCanvas(gl){const listeners={};let context=gl;return {width:0,height:0,getContext:name=>name==='webgl'?context:null,setContext:value=>context=value,addEventListener:(type,fn)=>listeners[type]=fn,removeEventListener(){},fire:(type,event={preventDefault(){}})=>listeners[type](event)};}

test('split projection matches the shared camera below a quarter CSS pixel at large coordinates',()=>{
  const camera=require('../camera.js'),width=1200,height=800,view=camera.view(width,height,.00001,{x:143,y:-91}),p={x:447000000.125,y:-210000000.375};
  const expected=camera.toScreen(p.x,-p.y,view),actual=historyGL.projectSplit(p,view,width,height);
  assert.ok(Math.hypot(actual.x-expected.x,actual.y-expected.y)<.25);
});

test('renderer uploads pages incrementally and draws each visible continuous segment separately',()=>{
  const gl=fakeGL(),canvas=fakeCanvas(gl),renderer=historyGL.createRenderer(canvas,{maxPoints:20}),store=historyGL.createStore({maxPoints:20});
  renderer.append(store.append([point(1),point(2),point(5),point(6)]));
  assert.equal(gl.calls.filter(c=>c[0]==='bufferSubData').length,2);
  renderer.render({view:{cx:500,cy:400,scale:.1},width:1000,height:800,dpr:1,time:6,hidden:false,segments:store.visibleRanges(6)});
  assert.deepEqual(gl.calls.filter(c=>c[0]==='drawArrays').map(c=>c.slice(2)),[[0,2],[2,2]]);
});

test('context loss suspends drawing and restore reuploads retained CPU chunks',()=>{
  const gl=fakeGL(),canvas=fakeCanvas(gl),statuses=[],renderer=historyGL.createRenderer(canvas,{maxPoints:20,onStatus:s=>statuses.push(s)}),store=historyGL.createStore({maxPoints:20});
  renderer.append(store.append([point(1),point(2)]));
  canvas.fire('webglcontextlost');renderer.render({view:{cx:0,cy:0,scale:1},width:10,height:10,dpr:1,time:2,hidden:false,segments:store.visibleRanges(2)});
  const before=gl.calls.filter(c=>c[0]==='drawArrays').length;
  canvas.fire('webglcontextrestored');
  assert.equal(gl.calls.filter(c=>c[0]==='drawArrays').length,before);
  assert.ok(gl.calls.filter(c=>c[0]==='bufferSubData').length>=4);
  assert.deepEqual(statuses,['lost','restored']);renderer.destroy();
  assert.ok(gl.calls.some(c=>c[0]==='deleteBuffer'));
});

test('renderer reports unavailable WebGL without throwing',()=>{
  const statuses=[],renderer=historyGL.createRenderer(fakeCanvas(null),{onStatus:s=>statuses.push(s)});
  assert.equal(renderer.available,false);assert.deepEqual(statuses,['unavailable']);
});

test('shader compilation and context restore failures disable only the exact layer',()=>{
  const broken=fakeGL();broken.getShaderParameter=()=>false;
  const compileStatuses=[],compileRenderer=historyGL.createRenderer(fakeCanvas(broken),{onStatus:s=>compileStatuses.push(s)});
  assert.equal(compileRenderer.available,false);assert.deepEqual(compileStatuses,['error']);
  const gl=fakeGL(),canvas=fakeCanvas(gl),restoreStatuses=[],renderer=historyGL.createRenderer(canvas,{onStatus:s=>restoreStatuses.push(s)});
  canvas.fire('webglcontextlost');canvas.setContext(null);canvas.fire('webglcontextrestored');
  assert.equal(renderer.available,false);assert.deepEqual(restoreStatuses,['lost','restore-failed']);
});
