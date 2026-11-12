'use strict';
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.OrbitalHistory=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const MAX_POINTS=8000,MAX_TICKS=4800;
  function lifecycle(state,tickRate=240){return {endTick:Math.max(0,Number(state?.tick)||0),endSeconds:Number.isFinite(state?.elapsedSeconds)?Math.max(0,state.elapsedSeconds):Math.max(0,Number(state?.tick)||0)/tickRate};}
  function windowRange(time,state,tickRate=240){const life=lifecycle(state,tickRate),target=Math.min(life.endTick,Math.max(0,time*tickRate)),radius=Math.min(MAX_TICKS/2,10*tickRate);return {fromTick:Math.max(0,Math.floor(target-radius)),toTick:Math.min(life.endTick,Math.floor(target-radius)+MAX_TICKS,Math.ceil(target+radius))};}
  function interpolate(points,time){
    if(!points.length||time<points[0].elapsedSeconds||time>points[points.length-1].elapsedSeconds)return null;
    let lo=0,hi=points.length-1;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(points[mid].elapsedSeconds<=time)lo=mid;else hi=mid-1;}
    const a=points[lo],b=points[Math.min(lo+1,points.length-1)],fraction=b.elapsedSeconds===a.elapsedSeconds?0:(time-a.elapsedSeconds)/(b.elapsedSeconds-a.elapsedSeconds),result={elapsedSeconds:time};
    for(const key of ['x','y','vx','vy'])result[key]=a[key]+(b[key]-a[key])*fraction;
    if(a.z!==undefined&&b.z!==undefined)for(const key of ['z','vz'])result[key]=a[key]+(b[key]-a[key])*fraction;
    return result;
  }
  function createCache(maxPoints=MAX_POINTS){return {range:null,points:[],set(range,points){if(points.length>maxPoints)throw new Error('History point bound exceeded');this.range={...range};this.points=points;},contains(time){return !!this.range&&time>=this.points[0]?.elapsedSeconds&&time<=this.points[this.points.length-1]?.elapsedSeconds;},clear(){this.range=null;this.points=[];}};}
  function createTrail(maxPoints=6000){
    if(!Number.isSafeInteger(maxPoints)||maxPoints<2)throw new Error('Replay trail point bound must be at least two');
    let segments=[];
    const key=point=>Number.isSafeInteger(point.seq)?'s:'+point.seq:`t:${point.tick}:${point.elapsedSeconds}`;
    const mergePoints=(left,right)=>{
      const unique=new Map();for(const point of [...left,...right])unique.set(key(point),point);
      return [...unique.values()].sort((a,b)=>a.elapsedSeconds-b.elapsedSeconds||a.tick-b.tick);
    };
    const sample=(points,limit)=>{
      if(points.length<=limit)return points;if(limit===1)return [points.at(-1)];
      const result=[];for(let i=0;i<limit;i++)result.push(points[Math.round(i*(points.length-1)/(limit-1))]);return result;
    };
    const rebalance=()=>{
      let total=segments.reduce((sum,segment)=>sum+segment.points.length,0);
      while(total>maxPoints){
        const candidate=segments.reduce((best,segment)=>segment.points.length>(best?.points.length||2)?segment:best,null);
        if(!candidate){const removed=segments.shift();total-=removed.points.length;continue;}
        const target=Math.max(2,candidate.points.length-(total-maxPoints));candidate.points=sample(candidate.points,target);
        total=segments.reduce((sum,segment)=>sum+segment.points.length,0);
      }
    };
    return {
      add(range,points){
        if(!range||!Array.isArray(points)||!points.length)return;
        const incoming={fromTick:Number(range.fromTick),toTick:Number(range.toTick),points:mergePoints([],points)};
        const ordered=[...segments,incoming].sort((a,b)=>a.fromTick-b.fromTick),merged=[];
        for(const segment of ordered){const previous=merged.at(-1);if(previous&&segment.fromTick<=previous.toTick+1){previous.toTick=Math.max(previous.toTick,segment.toTick);previous.points=mergePoints(previous.points,segment.points);}else merged.push({...segment,points:[...segment.points]});}
        segments=merged;rebalance();
      },
      visible(time){
        const result=[];
        for(const segment of segments){const points=segment.points;if(!points.length||time<points[0].elapsedSeconds)continue;
          let lo=0,hi=points.length-1;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(points[mid].elapsedSeconds<=time)lo=mid;else hi=mid-1;}
          const visible=points.slice(0,lo+1);if(lo<points.length-1&&time>points[lo].elapsedSeconds){const point=interpolate([points[lo],points[lo+1]],time);if(point)visible.push(point);}result.push(visible);
        }return result;
      },
      clear(){segments=[];},
      get pointCount(){return segments.reduce((sum,segment)=>sum+segment.points.length,0);},
      get segmentCount(){return segments.length;}
    };
  }
  async function loadWindow(initialRange,fetchPage,{maxPoints=MAX_POINTS,targetTick=(initialRange.fromTick+initialRange.toTick)/2,cutoffSeq}={}){
    let range={...initialRange};
    for(;;){
      let cursor=null,points=[],seen=new Set(),overflow=false;
      do{
        const data=await fetchPage({...range,cursor,cutoffSeq,limit:Math.min(1000,maxPoints+1-points.length),boundaries:true});
        if(cutoffSeq===undefined){if(!Number.isSafeInteger(data.cutoffSeq))throw new Error('历史读取缺少固定截止标记');cutoffSeq=data.cutoffSeq;}
        const beforeCount=points.length;
        for(const point of data.points||[]){const key=point.seq===undefined?point.tick+':'+point.elapsedSeconds:point.seq;if(!seen.has(key)){seen.add(key);points.push(point);if(points.length>maxPoints)break;}}
        const nextCursor=data.nextCursor||null;
        if(nextCursor&&(nextCursor===cursor||points.length===beforeCount))throw new Error('History cursor did not advance');
        cursor=nextCursor;
        if(points.length>maxPoints||(points.length===maxPoints&&cursor)){overflow=true;break;}
      }while(cursor);
      if(!overflow){points.sort((a,b)=>a.elapsedSeconds-b.elapsedSeconds||a.tick-b.tick);return {range,points,cutoffSeq};}
      const span=range.toTick-range.fromTick;if(span<=1)throw new Error('历史采样过密，无法在内存上限内载入相邻采样点');
      const nextSpan=Math.max(1,Math.floor(span/2)),center=Math.min(range.toTick,Math.max(range.fromTick,targetTick));
      const fromTick=Math.max(range.fromTick,Math.min(range.toTick-nextSpan,Math.floor(center-nextSpan/2)));
      range={fromTick,toTick:fromTick+nextSpan};
    }
  }
  async function loadExact(fetchPage,{cutoffSeq,maxPoints=409600,pageSize=5000,signal,onPage=()=>{}}={}){
    if(!Number.isSafeInteger(cutoffSeq)||cutoffSeq<0)throw new Error('完整历史读取缺少固定截止标记');
    if(!Number.isSafeInteger(maxPoints)||maxPoints<1||maxPoints>409600)throw new Error('完整历史点上限无效');
    if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>5000)throw new Error('完整历史分页大小无效');
    let cursor=null,pointCount=0,lastSeq=null;const cursors=new Set();
    for(;;){
      if(signal?.aborted)throw new DOMException('历史读取已取消','AbortError');
      const remaining=maxPoints-pointCount;if(remaining<=0)throw new Error('完整历史超过 409600 点上限');
      const data=await fetchPage({cursor,cutoffSeq,limit:Math.min(pageSize,remaining),boundaries:false,signal});
      if(data.cutoffSeq!==cutoffSeq)throw new Error('完整历史截止标记发生变化');
      const points=data.points||[];
      for(const point of points){
        if(!Number.isSafeInteger(point.seq)||(lastSeq!==null&&point.seq<=lastSeq))throw new Error('完整历史序号必须严格递增');
        lastSeq=point.seq;
      }
      pointCount+=points.length;const nextCursor=data.nextCursor||null;
      onPage(points,{pointCount,cutoffSeq,nextCursor,trajectoryCoverage:data.trajectoryCoverage});
      if(!nextCursor)return {pointCount,cutoffSeq,lastCursor:null};
      if(nextCursor===cursor||cursors.has(nextCursor)||points.length===0)throw new Error('完整历史游标没有推进');
      cursors.add(nextCursor);cursor=nextCursor;
    }
  }
  function mergeSnapshot(old,incoming){return old?{...old,...incoming}:incoming.initial?incoming:null;}
  function samePositionAndVelocity(a,b){
    if(a.z===undefined&&b.z===undefined){
      return Math.hypot(a.x-b.x,a.y-b.y)<=1e-6&&Math.hypot(a.vx-b.vx,a.vy-b.vy)<=1e-6;
    }
    return Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)<=1e-6&&Math.hypot(a.vx-b.vx,a.vy-b.vy,a.vz-b.vz)<=1e-6;
  }
  // Reconstruct only short live intervals using the server's fixed-step dynamics.
  // A long offline catch-up cannot be inferred from two endpoints.
  function liveSegment(a,b,model){
    const ticks=b.tick-a.tick;
    if(!Number.isSafeInteger(ticks)||ticks<=0||ticks>model.MODEL.tickRate*2)return null;
    const state={...a,status:'active',escapeRadius:a.escapeRadius||1e30,continuousTracking:true},points=[{...a}];
    for(let i=0;i<ticks;i++){model.step(state);if(state.status!=='active')return null;points.push(model.snapshot(state));}
    if(!samePositionAndVelocity(state,b))return null;
    points[points.length-1]={...b};return points;
  }
  function createLiveObserver(model){
    let state=null,remainder=0;
    const copy=s=>({...s,status:s.status||'active',escapeRadius:s.escapeRadius||1e30,continuousTracking:true});
    return {
      get state(){return state;},
      accept(incoming,{recovering=false}={}){
        if(state&&recovering&&!['terminated','out_of_observable','error'].includes(incoming.status))return false;
        if(state&&incoming.status==='active'&&Math.abs(incoming.tick-state.tick)<=model.MODEL.tickRate*2){
          const earlier=copy(incoming.tick<state.tick?incoming:state),later=incoming.tick<state.tick?state:incoming;
          while(earlier.tick<later.tick&&earlier.status==='active')model.step(earlier);
          if(earlier.status===later.status&&samePositionAndVelocity(earlier,later))return false;
        }
        state=copy(incoming);remainder=0;return true;
      },
      advance(seconds,{collect=true}={}){
        if(state?.status!=='active')return [];
        // Bound work after a suspended tab: resume smoothly rather than replay a long frame.
        remainder+=Math.min(Math.max(0,seconds),.5)*model.MODEL.tickRate;
        const steps=Math.floor(remainder+1e-9);remainder-=steps;const points=[];
        for(let i=0;i<steps&&state.status==='active';i++){model.step(state);if(collect)points.push(model.snapshot(state));}
        return points;
      }
    };
  }
  function createBodyFrameObserver(){
    let target=null,from=null,receivedAt=0,duration=200,paused=false,segments=[];
    const position=(body,start,end,f)=>({...body,x:start.x+(end.x-start.x)*f,
      y:start.y+(end.y-start.y)*f,z:start.z+(end.z-start.z)*f});
    function displayTick(now){
      if(!from)return target?.tick;
      const f=Math.max(0,Math.min(1,(now-receivedAt)/duration));
      return from.tick+(target.tick-from.tick)*f;
    }
    function sampleAtTick(tick){
      if(!from||tick>=target.tick)return target;
      if(tick<=from.tick)return from;
      const bodies=[];
      for(const {body,start,end,birth,death,waypoints} of segments){
        if(tick<birth||tick>=death)continue;
        let left=start,right=end,begin=birth,finish=death;
        for(const point of waypoints){
          if(point.tick>=tick){right=point;finish=point.tick;break;}
          left=point;begin=point.tick;
        }
        const t=Math.max(0,Math.min(1,(tick-begin)/(finish-begin)));
        bodies.push(position(body,left,right,t));
      }
      return {tick,bodies};
    }
    function sample(now){return sampleAtTick(displayTick(now));}
    function reset(){target=from=null;segments=[];paused=false;}
    return {sample,sampleAtTick,displayTick,reset,accept(frame,now,{paused:freeze=false,path=[],fromTick}={}){
      if(target&&frame.tick<target.tick)return;
      if(!target||freeze){target=frame;from=null;segments=[];receivedAt=now;paused=freeze;return;}
      if(frame.tick===target.tick){if(paused){receivedAt=now;paused=false;}return;}
      from=Number.isFinite(fromTick)?sampleAtTick(fromTick):sample(now);
      duration=Math.max(75,Math.min(250,now-receivedAt));
      target=frame;receivedAt=now;paused=false;
      const previous=new Map(from.bodies.map(body=>[body.id,body]));
      const catalog=new Map(frame.catalog.map(body=>[body.id,body]));
      const paths=new Map();
      for(const {tick,positions} of path){
        if(tick<=from.tick||tick>=frame.tick)continue;
        for(const [id,x,y,z] of positions){
          let points=paths.get(id);
          if(!points){points=[];paths.set(id,points);}
          points.push({tick,x,y,z});
        }
      }
      segments=frame.bodies.map(body=>{
        const old=previous.get(body.id),event=catalog.get(body.id);
        previous.delete(body.id);
        const birth=old?from.tick:Math.max(from.tick,event?.birthTick??frame.tick);
        return {body,start:old??event?.mergeOrigin??body,end:body,birth,death:frame.tick,
          waypoints:paths.get(body.id)?.filter(point=>point.tick>birth)??[]};
      });
      for(const body of previous.values()){
        const event=catalog.get(body.id);
        const merge=frame.catalog.find(entry=>entry.continuedFrom===body.id||entry.absorbedFrom===body.id);
        const death=event?.endTick??frame.tick;
        segments.push({body,start:body,end:merge?.mergeOrigin??body,birth:from.tick,death,
          waypoints:paths.get(body.id)?.filter(point=>point.tick<death)??[]});
      }
    }};
  }
  return {MAX_POINTS,MAX_TICKS,lifecycle,windowRange,interpolate,createCache,createTrail,loadWindow,loadExact,mergeSnapshot,liveSegment,createLiveObserver,createBodyFrameObserver};
});
