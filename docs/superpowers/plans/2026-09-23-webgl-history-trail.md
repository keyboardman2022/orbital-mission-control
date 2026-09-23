# WebGL 精确历史轨迹 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把单颗卫星的全部已保存历史点按固定截止序号加载到紧凑数组，并用 WebGL 逐段精确绘制，消除 6000 点重复抽稀造成的旧轨迹错乱。

**Architecture:** `shared/history-window.js` 继续负责局部窗口与分页一致性，并新增无网络依赖的完整分页驱动；`history-webgl.js` 管理分块紧凑数组、连续段、高低位坐标和 WebGL 生命周期；`mission.js` 管理请求、会话取消、进度与 Canvas 合成。完整轨迹和局部回放窗口使用两个独立的取消控制器，共享固定 `cutoffSeq` 与当前选择版本。

**Tech Stack:** Node.js 24、浏览器原生 JavaScript、Canvas 2D、WebGL 1、TypedArray、Node `node:test`

**Spec:** `docs/superpowers/specs/2026-09-23-webgl-history-trail-design.md`

## Global Constraints

- 只替换历史轨迹线的加载、缓存和绘制方式；黑洞、星空、卫星、冲击波、准星、距离网格和交互界面继续使用现有 Canvas 2D。
- 继续使用现有 `/api/satellites/:id/trajectory` JSON 分页接口；不修改 SQLite、gzip 归档、导出格式、身份模型、采样器或物理计算。
- 一次只保留当前选中卫星的一份完整轨迹，硬上限为 409,600 个已保存点，每页最多 5,000 点。
- 完整轨迹必须固定首次局部窗口返回的 `cutoffSeq`；活动卫星之后生成的数据不进入本次回放。
- `seq` 缺口必须形成独立 `LINE_STRIP`，禁止跨缺口连线。
- 世界坐标必须使用 `Math.fround(value)` 高位加剩余低位编码；WebGL 轨迹线固定为 1 像素。
- WebGL 不可用或上下文恢复失败时保留局部窗口回放，明确告知用户，并且不回退到 `createTrail(6000)`。
- 返回实时、切换卫星、永久删除档案和身份重置必须取消完整读取并释放 CPU/GPU 资源。
- 不新增第三方前端依赖，不改变 Node.js `>=24.0.0` 要求，不修改 `.idea/`。

## Review Focus

- 分页响应含重复、倒退或非整数 `seq` 时，应保留已接收前缀、停止完整加载并显示不完整状态；Task 1 和 Task 3 覆盖。
- 用户快速切换卫星、退出回放或删除记录后，迟到页不得追加顶点或覆盖当前提示；Task 4 覆盖。
- 空轨迹、只有一个点、首点 `seq` 不为 1，以及中间多处缺口，都不得产生跨段线条；Task 1 和 Task 2 覆盖。
- 大坐标加深度缩放、拖拽和跟踪时，WebGL 与 `OrbitalCamera.toScreen(x, -y, view)` 的投影误差应小于 0.25 CSS 像素；Task 2 覆盖。
- WebGL 创建失败、编译失败、上下文丢失与恢复失败时，主动画循环和局部插值必须继续工作；Task 2 和 Task 4 覆盖。

---

## File Structure

- Create `history-webgl.js`: UMD 模块，导出紧凑轨迹存储、高低位编码和 WebGL 渲染器；不发请求、不读取表单、不管理播放状态。
- Create `tests/history-webgl.test.cjs`: 验证 40 万点保留、分段、二分前缀、高低位投影、GPU 上传、上下文丢失和资源释放。
- Modify `shared/history-window.js`: 新增固定截止点的完整分页驱动 `loadExact`；局部窗口、插值、实时观察器保持兼容。
- Modify `tests/history-window.test.cjs`: 验证完整分页固定截止、游标推进、错误页、取消与 mission 集成生命周期。
- Modify `mission.js`: 建立独立完整加载会话、追加页面、显示进度、调用 WebGL 并合成透明画布。
- Modify `mission.html`: 在 `mission.js` 前加载 `history-webgl.js` 并更新缓存版本。
- Modify `server/index.js`: 把新脚本加入静态文件白名单。
- Modify `tests/api.test.cjs`: 验证 `history-webgl.js` 能通过静态服务器读取。
- Create `docs/verification/2026-09-23-webgl-history-trail.md`: 保存真实 390,606 点轨迹的浏览器性能和目视验证结果。

### Task 1: 紧凑历史存储和连续段索引

**Files:**
- Create: `history-webgl.js`
- Create: `tests/history-webgl.test.cjs`

**Interfaces:**
- Consumes: 轨迹页中的 `{seq, tick, elapsedSeconds, x, y}`；最大点数整数。
- Produces: `OrbitalHistoryGL.createStore({maxPoints})`，返回含 `append(points)`、`clear()`、`pointCount`、`chunks`、`segments`、`visibleRanges(time)` 的存储对象；`OrbitalHistoryGL.split64(value)` 返回 `{high, low}`。

- [ ] **Step 1: 写入失败测试，锁定 40 万点不抽稀、序号校验、缺口分段和时间前缀**

```js
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
  assert.deepEqual(store.visibleRanges(14),[{start:0,count:2},{start:2,count:1}]);
  assert.deepEqual(store.visibleRanges(100),store.segments);
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
```

- [ ] **Step 2: 运行新测试并确认失败原因是模块或接口尚不存在**

Run: `D:\node\node.exe --test tests/history-webgl.test.cjs`

Expected: FAIL，错误包含 `Cannot find module '../history-webgl.js'` 或 `createStore is not a function`。

- [ ] **Step 3: 实现 UMD 外壳、分块 TypedArray、事务式追加、连续段和二分可见范围**

```js
'use strict';
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.OrbitalHistoryGL=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const HARD_MAX_POINTS=409600;
  const finiteKeys=['tick','elapsedSeconds','x','y'];
  function split64(value){const high=Math.fround(value);return {high,low:value-high};}
  function createStore({maxPoints=HARD_MAX_POINTS}={}){
    if(!Number.isSafeInteger(maxPoints)||maxPoints<1||maxPoints>HARD_MAX_POINTS)throw new Error('历史点上限无效');
    let chunks=[],segments=[],pointCount=0,lastSeq=null;
    const locate=index=>{let offset=index;for(const chunk of chunks){if(offset<chunk.length)return {chunk,offset};offset-=chunk.length;}return null;};
    return {
      append(points){
        if(!Array.isArray(points)||!points.length)return null;
        if(pointCount+points.length>maxPoints)throw new Error('历史点超过 409600 上限');
        let previous=lastSeq;
        for(const p of points){
          if(!Number.isSafeInteger(p.seq)||p.seq<0||finiteKeys.some(key=>!Number.isFinite(p[key])))throw new Error('历史页包含无效点');
          if(previous!==null&&p.seq<=previous)throw new Error('历史序号必须严格递增');
          previous=p.seq;
        }
        const length=points.length,x=new Float64Array(length),y=new Float64Array(length),elapsedSeconds=new Float64Array(length),tick=new Float64Array(length),seq=new Uint32Array(length);
        for(let i=0;i<length;i++){const p=points[i];x[i]=p.x;y[i]=p.y;elapsedSeconds[i]=p.elapsedSeconds;tick[i]=p.tick;seq[i]=p.seq;}
        const base=pointCount;
        for(let i=0;i<length;i++){
          const prior=i?seq[i-1]:lastSeq;
          if(prior===null||seq[i]!==prior+1)segments.push({start:base+i,count:1});else segments.at(-1).count++;
        }
        const chunk={base,length,x,y,elapsedSeconds,tick,seq};chunks.push(chunk);pointCount+=length;lastSeq=seq[length-1];return chunk;
      },
      pointAt(index){const found=locate(index);if(!found)return null;const {chunk,offset}=found;return {x:chunk.x[offset],y:chunk.y[offset],elapsedSeconds:chunk.elapsedSeconds[offset],tick:chunk.tick[offset],seq:chunk.seq[offset]};},
      visibleRanges(time){
        const ranges=[];
        for(const segment of segments){let lo=segment.start,hi=segment.start+segment.count-1;if(this.pointAt(lo).elapsedSeconds>time)continue;
          while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(this.pointAt(mid).elapsedSeconds<=time)lo=mid;else hi=mid-1;}
          const count=lo-segment.start+1;if(count>1)ranges.push({start:segment.start,count});
        }
        return ranges;
      },
      clear(){chunks=[];segments=[];pointCount=0;lastSeq=null;},
      get chunks(){return chunks;},get segments(){return segments.map(s=>({...s}));},get pointCount(){return pointCount;},get lastSeq(){return lastSeq;}
    };
  }
  return {HARD_MAX_POINTS,split64,createStore};
});
```

- [ ] **Step 4: 运行测试并修正断言中的项目上限文案，使全部通过**

Run: `D:\node\node.exe --test tests/history-webgl.test.cjs`

Expected: 4 tests PASS。

- [ ] **Step 5: 提交紧凑存储**

```powershell
git add history-webgl.js tests/history-webgl.test.cjs
git commit -m "feat: add exact trajectory store"
```

### Task 2: WebGL 高精度轨迹渲染器

**Files:**
- Modify: `history-webgl.js`
- Modify: `tests/history-webgl.test.cjs`

**Interfaces:**
- Consumes: Task 1 的 store chunk；相机 `{cx, cy, scale}`；画布 CSS 尺寸、DPR 和回放时间。
- Produces: `OrbitalHistoryGL.createRenderer(canvas,{maxPoints,onStatus})`，返回 `append(chunk)`、`render({view,width,height,dpr,time,hidden})`、`clear()`、`destroy()`、`available`；`OrbitalHistoryGL.projectSplit(point,view)` 供数值测试。

- [ ] **Step 1: 添加失败测试，验证大坐标投影、分段 drawArrays、增量上传和上下文生命周期**

```js
function fakeGL(){
  const calls=[];let id=0;
  const gl={calls,ARRAY_BUFFER:34962,DYNAMIC_DRAW:35048,FLOAT:5126,LINE_STRIP:3,COLOR_BUFFER_BIT:16384,VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,COMPILE_STATUS:35713,LINK_STATUS:35714,BLEND:3042,SRC_ALPHA:770,ONE_MINUS_SRC_ALPHA:771,
    createShader:()=>({id:++id}),shaderSource(){},compileShader(){},getShaderParameter:()=>true,getShaderInfoLog:()=>'',createProgram:()=>({id:++id}),attachShader(){},linkProgram(){},getProgramParameter:()=>true,getProgramInfoLog:()=>'',getAttribLocation:(_p,n)=>n==='aHigh'?0:1,getUniformLocation:(_p,n)=>n,
    createBuffer:()=>({id:++id}),bindBuffer(){},bufferData(...a){calls.push(['bufferData',...a]);},bufferSubData(...a){calls.push(['bufferSubData',...a]);},viewport(){},clearColor(){},clear(){},useProgram(){},enable(){},blendFunc(){},enableVertexAttribArray(){},vertexAttribPointer(){},uniform2f(...a){calls.push(['uniform2f',...a]);},uniform1f(...a){calls.push(['uniform1f',...a]);},drawArrays(...a){calls.push(['drawArrays',...a]);},deleteBuffer(){calls.push(['deleteBuffer']);},deleteProgram(){calls.push(['deleteProgram']);}};
  return gl;
}
function fakeCanvas(gl){const listeners={};let context=gl;return {width:0,height:0,getContext:name=>name==='webgl'?context:null,setContext:value=>context=value,addEventListener:(type,fn)=>listeners[type]=fn,removeEventListener(){},fire:(type,event={preventDefault(){}})=>listeners[type](event)};}

test('split projection matches the shared camera below a quarter CSS pixel at large coordinates',()=>{
  const camera=require('../camera.js'),width=1200,height=800,view=camera.view(width,height,.00001,{x:143,y:-91}),point={x:447000000.125,y:-210000000.375};
  const expected=camera.toScreen(point.x,-point.y,view),actual=historyGL.projectSplit(point,view,width,height);
  assert.ok(Math.hypot(actual.x-expected.x,actual.y-expected.y)<.25);
});

test('renderer uploads pages incrementally and draws each visible continuous segment separately',()=>{
  const gl=fakeGL(),canvas=fakeCanvas(gl),renderer=historyGL.createRenderer(canvas,{maxPoints:20}),store=historyGL.createStore({maxPoints:20});
  renderer.append(store.append([point(1),point(2),point(5),point(6)]));
  assert.equal(gl.calls.filter(c=>c[0]==='bufferSubData').length,2);
  renderer.render({view:{cx:500,cy:400,scale:.1},width:1000,height:800,dpr:1,time:5,hidden:false,segments:store.visibleRanges(5)});
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
```

- [ ] **Step 2: 运行渲染测试并确认新增接口缺失**

Run: `D:\node\node.exe --test tests/history-webgl.test.cjs`

Expected: FAIL，错误包含 `projectSplit is not a function` 或 `createRenderer is not a function`。

- [ ] **Step 3: 实现顶点高低位、透明离屏画布、相机 uniform 和上下文恢复**

在 `history-webgl.js` 的工厂函数中加入以下着色器和公开函数；GPU 缓冲按 `maxPoints * 2 floats * 4 bytes` 一次分配，每页只调用两次 `bufferSubData`：

```js
const VERTEX=`attribute vec2 aHigh;attribute vec2 aLow;uniform vec2 uOriginHigh;uniform vec2 uOriginLow;uniform vec2 uViewport;uniform float uScale;const float C=0.8869949227792842;const float S=-0.4617791755414829;const float T=0.66;void main(){vec2 p=(aHigh-uOriginHigh)+(aLow-uOriginLow);vec2 screen=uViewport*.5+uScale*vec2(p.x*C-p.y*T*S,p.x*S+p.y*T*C);vec2 clip=screen/uViewport*2.0-1.0;gl_Position=vec4(clip.x,-clip.y,0.0,1.0);}`;
const FRAGMENT=`precision mediump float;void main(){gl_FragColor=vec4(0.643,0.859,0.651,0.52);}`;

function projectSplit(point,view,width,height){
  const px=split64(point.x),py=split64(-point.y),origin=worldOrigin(view,width,height);
  const x=(px.high-origin.x.high)+(px.low-origin.x.low),y=(py.high-origin.y.high)+(py.low-origin.y.low);
  return {x:width*.5+view.scale*(x*Math.cos(-.48)-y*.66*Math.sin(-.48)),y:height*.5+view.scale*(x*Math.sin(-.48)+y*.66*Math.cos(-.48))};
}
function worldOrigin(view,width,height){
  const cos=Math.cos(-.48),sin=Math.sin(-.48),dx=width*.5-view.cx,dy=height*.5-view.cy;
  return {x:split64((dx*cos+dy*sin)/view.scale),y:split64((-dx*sin+dy*cos)/(view.scale*.66))};
}
```

`createRenderer` 必须保存已经收到的 chunk 引用；上传时把 `chunk.x` 与 `-chunk.y` 分别编码到 high/low `Float32Array`。`webglcontextrestored` 重新取得 context、创建 program/buffer 并依序重传这些 chunk。初次无 context 调用 `onStatus('unavailable')`；着色器编译或链接失败调用 `onStatus('error')`；恢复时仍无 context 或重建失败则删除 GPU 对象、设置 `available=false` 并调用 `onStatus('restore-failed')`。`render` 在 `hidden`、上下文丢失或 `available === false` 时直接返回 `false`，否则更新画布像素尺寸、清透明背景、上传由 CSS 视口中心反算得到的世界原点 high/low、viewport/scale，并对传入的每个 `{start,count}` 调用 `gl.drawArrays(gl.LINE_STRIP,start,count)`。`clear` 删除旧 buffer、清空 chunk 引用并把 buffer 置空，下一页追加时再按硬上限分配；`destroy` 移除两个事件监听器并删除 buffer/program。

- [ ] **Step 4: 运行渲染测试，确认数值误差、调用次数和恢复路径通过**

Run: `D:\node\node.exe --test tests/history-webgl.test.cjs`

Expected: 9 tests PASS，且大坐标误差断言小于 0.25。

- [ ] **Step 5: 提交 WebGL 渲染器**

```powershell
git add history-webgl.js tests/history-webgl.test.cjs
git commit -m "feat: render exact history with WebGL"
```

### Task 3: 固定截止点的完整分页驱动

**Files:**
- Modify: `shared/history-window.js`
- Modify: `tests/history-window.test.cjs`

**Interfaces:**
- Consumes: `loadExact(fetchPage,{cutoffSeq,maxPoints,pageSize,signal,onPage})`；`fetchPage({cursor,cutoffSeq,limit,boundaries:false,signal})`。
- Produces: 完成时 `{pointCount,cutoffSeq,lastCursor:null}`；每页调用 `onPage(points,{pointCount,cutoffSeq,nextCursor,trajectoryCoverage})`。

- [ ] **Step 1: 写入失败测试，覆盖固定截止、5000 页大小、游标和取消**

```js
const exactPoints=(from,count)=>Array.from({length:count},(_,i)=>({seq:from+i,tick:(from+i)*240,elapsedSeconds:from+i,x:500+i,y:i}));

test('loadExact pins cutoff and streams every page once',async()=>{
  const calls=[],pages=[];
  const result=await history.loadExact(async options=>{
    calls.push(options);
    if(options.cursor===null)return {points:exactPoints(1,2),nextCursor:'2',cutoffSeq:9};
    return {points:exactPoints(3,2),nextCursor:null,cutoffSeq:9};
  },{cutoffSeq:9,maxPoints:20,pageSize:5000,onPage:(points,meta)=>pages.push({points,meta})});
  assert.deepEqual(calls.map(c=>[c.cursor,c.cutoffSeq,c.limit]),[[null,9,20],['3',9,18]]);
  assert.equal(result.pointCount,4);assert.equal(pages.length,2);
});

test('loadExact rejects nonadvancing cursor, duplicate sequence and changed cutoff',async()=>{
  await assert.rejects(history.loadExact(async()=>({points:exactPoints(1,1),nextCursor:'same',cutoffSeq:8}),{cutoffSeq:9}),/截止/);
  let n=0;await assert.rejects(history.loadExact(async()=>++n===1?{points:exactPoints(1,1),nextCursor:'same',cutoffSeq:9}:{points:exactPoints(2,1),nextCursor:'same',cutoffSeq:9},{cutoffSeq:9}),/游标|cursor/i);
  n=0;await assert.rejects(history.loadExact(async()=>++n===1?{points:exactPoints(1,2),nextCursor:'2',cutoffSeq:9}:{points:exactPoints(2,1),nextCursor:null,cutoffSeq:9},{cutoffSeq:9}),/序号/);
});

test('loadExact stops before dispatch when aborted',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(history.loadExact(async()=>{calls++;return {points:[],nextCursor:null,cutoffSeq:9};},{cutoffSeq:9,signal:controller.signal}),e=>e.name==='AbortError');
  assert.equal(calls,0);
});
```

- [ ] **Step 2: 运行目标测试并确认 `loadExact` 尚不存在**

Run: `D:\node\node.exe --test tests/history-window.test.cjs --test-name-pattern="loadExact"`

Expected: FAIL with `history.loadExact is not a function`。

- [ ] **Step 3: 实现分页驱动并导出，不在函数中保留所有 JSON 点**

```js
async function loadExact(fetchPage,{cutoffSeq,maxPoints=409600,pageSize=5000,signal,onPage=()=>{}}={}){
  if(!Number.isSafeInteger(cutoffSeq)||cutoffSeq<0)throw new Error('完整历史读取缺少固定截止标记');
  let cursor=null,pointCount=0,lastSeq=null;const cursors=new Set();
  for(;;){
    if(signal?.aborted)throw new DOMException('历史读取已取消','AbortError');
    const remaining=maxPoints-pointCount;if(remaining<=0)throw new Error('完整历史超过 409600 点上限');
    const data=await fetchPage({cursor,cutoffSeq,limit:Math.min(pageSize,remaining),boundaries:false,signal});
    if(data.cutoffSeq!==cutoffSeq)throw new Error('完整历史截止标记发生变化');
    const points=data.points||[];
    for(const point of points){if(!Number.isSafeInteger(point.seq)||(lastSeq!==null&&point.seq<=lastSeq))throw new Error('完整历史序号必须严格递增');lastSeq=point.seq;}
    pointCount+=points.length;const nextCursor=data.nextCursor||null;
    onPage(points,{pointCount,cutoffSeq,nextCursor,trajectoryCoverage:data.trajectoryCoverage});
    if(!nextCursor)return {pointCount,cutoffSeq,lastCursor:null};
    if(nextCursor===cursor||cursors.has(nextCursor)||points.length===0)throw new Error('完整历史游标没有推进');
    cursors.add(nextCursor);cursor=nextCursor;
  }
}
```

把工厂返回值更新为：

```js
return {MAX_POINTS,MAX_TICKS,lifecycle,windowRange,interpolate,createCache,createTrail,loadWindow,loadExact,mergeSnapshot,liveSegment,createLiveObserver};
```

- [ ] **Step 4: 运行历史工具测试**

Run: `D:\node\node.exe --test tests/history-window.test.cjs --test-name-pattern="loadExact|loadWindow|createTrail"`

Expected: 所有匹配测试 PASS。

- [ ] **Step 5: 提交完整分页驱动**

```powershell
git add shared/history-window.js tests/history-window.test.cjs
git commit -m "feat: stream exact history at a fixed cutoff"
```

### Task 4: 接入任务控制页面、进度和取消生命周期

**Files:**
- Modify: `mission.js`
- Modify: `tests/history-window.test.cjs`

**Interfaces:**
- Consumes: `OrbitalHistoryGL.createStore`、`createRenderer` 和 `OrbitalHistory.loadExact`。
- Produces: `startExactHistory(id,cutoffSeq,expectedPoints,sessionVersion)` 内部流程；Canvas draw 顺序为黑洞/网格、WebGL 历史层、回放卫星/HUD。

- [ ] **Step 1: 扩展 mission VM 测试桩并写失败集成测试**

在 `missionHarness` 的 sandbox 增加可观察的 WebGL 假对象：

```js
const exact={pages:[],renders:[],clearCount:0,destroyCount:0};
const exactStore={pointCount:0,append(points){this.pointCount+=points.length;exact.pages.push(points);return {base:this.pointCount-points.length,length:points.length};},visibleRanges(){return this.pointCount>1?[{start:0,count:this.pointCount}]:[];},clear(){this.pointCount=0;}};
const OrbitalHistoryGL={createStore:()=>exactStore,createRenderer:()=>({available:true,append(){},render(input){exact.renders.push(input);return true;},clear(){exact.clearCount++;},destroy(){exact.destroyCount++;}})};
```

把它加入 sandbox，并加入测试：

```js
test('mission streams the fixed-cutoff full history independently from local seek windows',async()=>{
  const h=await missionHarness(),opening=h.node('history').onclick();
  h.requests[0].resolve({points:windowPoints(0,10),nextCursor:null,cutoffSeq:20,trajectoryCoverage:{lastSeq:20,endElapsedSeconds:20}});await h.flush();
  assert.ok(h.requests[1].path.includes('cutoffSeq=20'));assert.ok(h.requests[1].path.includes('limit=5000'));
  h.requests[1].resolve({points:exactPoints(1,10),nextCursor:'10',cutoffSeq:20});await h.flush();
  h.node('timeline').value=9;h.node('timeline').oninput();
  assert.equal(h.requests[2].options.signal.aborted,false);
  h.requests[2].resolve({points:exactPoints(11,10),nextCursor:null,cutoffSeq:20});await h.flush();await opening;
  assert.equal(h.exact.pages.flat().length,20);assert.match(h.node('historyMessage').textContent,/完整精确轨迹/);
});

test('leaving replay aborts exact loading and ignores a late page',async()=>{
  const h=await missionHarness(),opening=h.node('history').onclick();
  h.requests[0].resolve({points:windowPoints(0,2),nextCursor:null,cutoffSeq:20});await h.flush();
  const exactRequest=h.requests[1];h.node('live').onclick();assert.equal(exactRequest.options.signal.aborted,true);
  exactRequest.resolve({points:windowPoints(0,10),nextCursor:null,cutoffSeq:20});await h.flush();
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
  assert.equal(h.node('replay').hidden,false);assert.match(h.node('historyMessage').textContent,/不支持完整精确轨迹/);
});
```

- [ ] **Step 2: 运行 mission 目标测试并确认完整加载、双控制器和 renderer 尚未接入**

Run: `D:\node\node.exe --test tests/history-window.test.cjs --test-name-pattern="fixed-cutoff full history|leaving replay aborts exact|WebGL unavailable"`

Expected: FAIL，缺少第二个分页请求或 `OrbitalHistoryGL` 调用。

- [ ] **Step 3: 在 mission 状态区替换 `historyTrail`，建立完整存储和独立控制器**

将现有状态：

```js
const history=OrbitalHistory,historyCache=history.createCache(),historyTrail=history.createTrail(6000);
let historySnapshot=null,historyCutoffSeq,historyVersion=0,historyController=null,historyLoading=false,historyResume=false;
```

替换为：

```js
const history=OrbitalHistory,historyCache=history.createCache();
const exactStore=OrbitalHistoryGL.createStore({maxPoints:OrbitalHistoryGL.HARD_MAX_POINTS});
const exactCanvas=document.createElement('canvas');
const exactRenderer=OrbitalHistoryGL.createRenderer(exactCanvas,{maxPoints:OrbitalHistoryGL.HARD_MAX_POINTS,onStatus:status=>{if(status==='lost')$('historyMessage').textContent='精确轨迹图层暂时中断，正在等待图形上下文恢复…';if(status==='unavailable')$('historyMessage').textContent='此浏览器不支持完整精确轨迹；局部窗口回放仍可使用。';}});
let historySnapshot=null,historyCutoffSeq,historyRequestVersion=0,historySessionVersion=0,historyController=null,exactController=null,historyLoading=false,exactLoading=false,exactStarted=false,historyResume=false;
let windowStatus='',exactStatus='';
const updateHistoryStatus=()=>{$('historyMessage').textContent=[windowStatus,exactStatus].filter(Boolean).join(' · ');};
```

新增完整读取函数：

```js
async function startExactHistory(id,cutoffSeq,expectedPoints,sessionVersion,identity,selection){
  exactController?.abort();exactController=new AbortController();const signal=exactController.signal;
  exactStore.clear();exactRenderer.clear();
  if(!exactRenderer.available){exactLoading=false;exactStatus='此浏览器不支持完整精确轨迹；局部窗口回放仍可使用。';updateHistoryStatus();return;}
  exactLoading=true;
  const current=()=>historyMode&&selectedId===id&&sessionVersion===historySessionVersion&&identity===identityEpoch&&selection===selectionEpoch&&!signal.aborted;
  try{
    await history.loadExact(async options=>{
      const params=new URLSearchParams({limit:String(options.limit),cutoffSeq:String(cutoffSeq)});if(options.cursor!==null)params.set('cursor',options.cursor);
      return api('/api/satellites/'+encodeURIComponent(id)+'/trajectory?'+params,{signal});
    },{cutoffSeq,maxPoints:OrbitalHistoryGL.HARD_MAX_POINTS,pageSize:5000,signal,onPage:(points,meta)=>{
      if(!current())throw new DOMException('历史读取已取消','AbortError');
      const chunk=exactStore.append(points);if(chunk)exactRenderer.append(chunk);
      const total=Math.max(expectedPoints||cutoffSeq||meta.pointCount,meta.pointCount),percent=Math.min(100,meta.pointCount/total*100);
      exactStatus=`完整轨迹已加载 ${meta.pointCount.toLocaleString('zh-CN')} / ${total.toLocaleString('zh-CN')} 点 · ${percent.toFixed(1)}%`;updateHistoryStatus();
    }});
    if(current()){exactStatus=`完整精确轨迹 · ${exactStore.pointCount.toLocaleString('zh-CN')} 个保存点 · 截止 seq ${cutoffSeq}${historySnapshot.trajectoryCoverage?.status==='capped'?' · 轨迹仅记录到存储上限。':''}`;updateHistoryStatus();}
  }catch(error){if(current()&&error.name!=='AbortError'){exactStatus=`完整轨迹不完整：已保留 ${exactStore.pointCount.toLocaleString('zh-CN')} 个点。${error.message}`;updateHistoryStatus();}}
  finally{if(current())exactLoading=false;}
}
```

- [ ] **Step 4: 把完整读取接到初始窗口成功路径，并补齐所有清理入口**

修改 `clearHistory()`：

```js
function clearHistory(){historySessionVersion++;historyRequestVersion++;historyController?.abort();exactController?.abort();historyController=null;exactController=null;historyLoading=false;exactLoading=false;exactStarted=false;historyResume=false;historySnapshot=null;historyCutoffSeq=undefined;windowStatus='';exactStatus='';historyCache.clear();exactStore.clear();exactRenderer.clear();historyPoints=[];$('history').disabled=false;$('play').textContent='播放';updateHistoryStatus();}
```

`requestHistory` 使用 `const requestVersion=++historyRequestVersion` 过滤局部窗口迟到响应，不再修改 `historySessionVersion`。初始局部窗口成功并得到 `historyCutoffSeq` 后只执行一次：

```js
if(!exactStarted){exactStarted=true;void startExactHistory(selectedId,historyCutoffSeq,historySnapshot.trajectoryCoverage?.lastSeq||historyCutoffSeq,historySessionVersion,identityEpoch,selectionEpoch);}
```

确认 `selectSatellite`、`live`、删除成功路径、`resetIdentity` 和 `clear/showAll` 仍全部调用 `clearHistory()`；测试桩分别触发这些入口并断言两个 signal 均 aborted 且 `clearCount` 增加。

- [ ] **Step 5: 在现有 draw 顺序中合成 WebGL 历史层并保留局部点插值**

把 `historyTrail.visible` 的 Canvas 线条块替换为：

```js
if(historyMode&&exactRenderer.available&&!document.hidden){
  exactRenderer.render({view,width,height,dpr:Math.min(devicePixelRatio||1,2),time:replayElapsed,hidden:document.hidden,segments:exactStore.visibleRanges(replayElapsed)});
  ctx.drawImage(exactCanvas,0,0,exactCanvas.width,exactCanvas.height,0,0,width,height);
}
if(historyMode&&historyPoints.length){const point=replayPoint(replayElapsed),last=historyPoints.at(-1);if(point&&!(last.kind==='captured'&&replayElapsed>=last.elapsedSeconds-1e-9))drawSatellite(point,'回放 / '+(satellites.get(selectedId)?.name||''),true,satellites.get(selectedId)?.massKg||1000);}
```

局部窗口提示写入 `windowStatus`，只报告“当前窗口 N 个采样点”，然后调用 `updateHistoryStatus()`；不得再显示 `historyTrail.pointCount` 或“累计保留”。完整进度只写入 `exactStatus`，因此用户拖动时间轴不会覆盖完整加载进度或完成状态。

- [ ] **Step 6: 运行 mission 历史测试，修正旧的累计轨迹断言**

Run: `D:\node\node.exe --test tests/history-window.test.cjs`

Expected: 全部 PASS；旧测试 `mission retains contiguous replay windows as one cumulative trajectory` 改为断言局部 seek 不会重置完整存储，且不再引用 6000 点累计缓存。

- [ ] **Step 7: 提交页面集成**

```powershell
git add mission.js tests/history-window.test.cjs
git commit -m "feat: load complete history into WebGL replay"
```

### Task 5: 浏览器静态交付和版本更新

**Files:**
- Modify: `mission.html`
- Modify: `server/index.js`
- Modify: `tests/api.test.cjs`

**Interfaces:**
- Consumes: `history-webgl.js` 的浏览器全局 `OrbitalHistoryGL`。
- Produces: `/history-webgl.js` 静态响应；`mission.html` 保证模块先于 `mission.js` 执行。

- [ ] **Step 1: 写静态交付失败测试**

在现有 `HTTP launch, ownership, CSRF, persistence, pagination, recovery and exports` 测试的 `request` helper 定义之后加入：

```js
const historyScript=await request('/history-webgl.js');assert.equal(historyScript.res.status,200);assert.match(historyScript.res.headers.get('content-type'),/text\/javascript/);assert.match(historyScript.data,/OrbitalHistoryGL/);
const missionPage=await request('/mission.html');assert.ok(missionPage.data.indexOf('history-webgl.js')<missionPage.data.indexOf('mission.js'));
```

- [ ] **Step 2: 运行静态交付测试并确认返回 404 或页面缺少脚本**

Run: `D:\node\node.exe --test tests/api.test.cjs`

Expected: FAIL with HTTP 404 或顺序断言失败。

- [ ] **Step 3: 更新白名单和页面脚本顺序**

在 `server/index.js` 的 `FILES` 集合加入：

```js
'history-webgl.js'
```

把 `mission.html` 末尾脚本改为：

```html
<script src="shared/history-window.js?v=exact-history-1"></script><script src="shared/map-sweep.js?v=sweep-observation-2"></script><script src="history-webgl.js?v=exact-history-1"></script><script src="mission.js?v=exact-history-1"></script>
```

- [ ] **Step 4: 运行静态交付和脚本语法检查**

Run: `D:\node\node.exe --check history-webgl.js`

Expected: exit 0。

Run: `D:\node\node.exe --test tests/api.test.cjs`

Expected: PASS。

- [ ] **Step 5: 提交静态资源交付**

```powershell
git add mission.html server/index.js tests/api.test.cjs
git commit -m "feat: serve WebGL history replay assets"
```

### Task 6: 全量回归和真实长轨迹验证

**Files:**
- Create: `docs/verification/2026-09-23-webgl-history-trail.md`
- Modify when a failure identifies a defect: `history-webgl.js`, `mission.js`, `shared/history-window.js`, corresponding test file

**Interfaces:**
- Consumes: 当前 SQLite 中约 390,606 点的真实轨迹、运行中的本地服务。
- Produces: 可复核的加载时间、浏览器内存、静止/跟踪帧率、目视检查和最终测试结果。

- [ ] **Step 1: 运行全部自动测试**

Run: `D:\node\node.exe --test physics.test.cjs camera.test.cjs tests/*.test.cjs`

Expected: 全部测试 PASS；不得减少原有测试数量，新增测试计入总数。

- [ ] **Step 2: 启动当前项目并确认健康状态**

Run: `D:\node\node.exe server/index.js`

Expected: 服务监听 `http://127.0.0.1:4174`；如果现有实例持有 `data/server.lock`，使用现有实例并请求 `GET /health`，返回 HTTP 200 且 `status` 为 `running`。

- [ ] **Step 3: 在浏览器对真实长轨迹执行固定验证流程**

打开 `http://127.0.0.1:4174/mission.html`，选择约 390,606 点的卫星并执行：加载历史直到“完整精确轨迹”；分别把时间轴置于出生点、50% 和末点；在每个位置拖拽、滚轮缩放和开启“跟踪卫星”；返回实时后再次进入历史。记录完整加载秒数、加载完成后的 `performance.memory.usedJSHeapSize`（浏览器支持时）、静止 10 秒平均帧率、跟踪 10 秒平均帧率，并目视确认三处没有横穿轨道的直线、缩放时没有可见抖动、返回实时后显存层清空。

- [ ] **Step 4: 写入实际验证证据**

`docs/verification/2026-09-23-webgl-history-trail.md` 必须包含以下完整字段，并写入刚测得的值和观察结果：

```markdown
# WebGL 精确历史轨迹验证

- 测试日期：2026-09-23
- 浏览器与版本：
- 轨迹点数：
- 固定 cutoffSeq：
- 完整加载时间：
- JS heap（若浏览器提供）：
- 静止回放平均帧率：
- 跟踪视角平均帧率：
- 出生段目视结果：
- 中段目视结果：
- 末段目视结果：
- 拖拽与缩放结果：
- WebGL 上下文恢复结果：
- 全量自动测试结果：
```

- [ ] **Step 5: 检查工作区和差异，确保没有数据库、归档和 IDE 文件进入提交**

Run: `git status --short`

Expected: 只显示本功能源文件、测试和验证文档；`.idea/` 保持未跟踪且不加入暂存区，`data/` 无新增暂存文件。

Run: `git diff --check`

Expected: exit 0，无空白错误。

- [ ] **Step 6: 提交验证结果和必要修正**

```powershell
git add history-webgl.js mission.js mission.html shared/history-window.js server/index.js tests/history-webgl.test.cjs tests/history-window.test.cjs tests/api.test.cjs docs/verification/2026-09-23-webgl-history-trail.md
git commit -m "test: verify long WebGL history replay"
```

- [ ] **Step 7: 推送并验证远端提交**

```powershell
D:\node\node.exe data\push-private.cjs push
D:\node\node.exe data\push-private.cjs verify
```

Expected: `verify` 报告远端 `main` 与本地 `HEAD` 为同一提交；输出中不得包含认证凭据。
