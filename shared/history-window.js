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
    return result;
  }
  function createCache(maxPoints=MAX_POINTS){return {range:null,points:[],set(range,points){if(points.length>maxPoints)throw new Error('History point bound exceeded');this.range={...range};this.points=points;},contains(time){return !!this.range&&time>=this.points[0]?.elapsedSeconds&&time<=this.points[this.points.length-1]?.elapsedSeconds;},clear(){this.range=null;this.points=[];}};}
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
  function mergeSnapshot(old,incoming){return old?{...old,...incoming}:incoming.initial?incoming:null;}
  // Reconstruct only short live intervals using the server's fixed-step dynamics.
  // A long offline catch-up cannot be inferred from two endpoints.
  function liveSegment(a,b,model){
    const ticks=b.tick-a.tick;
    if(!Number.isSafeInteger(ticks)||ticks<=0||ticks>model.MODEL.tickRate*2)return null;
    const state={...a,status:'active',escapeRadius:a.escapeRadius||1e30,continuousTracking:true},points=[{...a}];
    for(let i=0;i<ticks;i++){model.step(state);if(state.status!=='active')return null;points.push(model.snapshot(state));}
    if(Math.hypot(state.x-b.x,state.y-b.y)>1e-6||Math.hypot(state.vx-b.vx,state.vy-b.vy)>1e-6)return null;
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
          if(earlier.status===later.status&&Math.hypot(earlier.x-later.x,earlier.y-later.y)<1e-6&&Math.hypot(earlier.vx-later.vx,earlier.vy-later.vy)<1e-6)return false;
        }
        state=copy(incoming);remainder=0;return true;
      },
      advance(seconds){
        if(state?.status!=='active')return [];
        // Bound work after a suspended tab: resume smoothly rather than replay a long frame.
        remainder+=Math.min(Math.max(0,seconds),.5)*model.MODEL.tickRate;
        const steps=Math.floor(remainder+1e-9);remainder-=steps;const points=[];
        for(let i=0;i<steps&&state.status==='active';i++){model.step(state);points.push(model.snapshot(state));}
        return points;
      }
    };
  }
  return {MAX_POINTS,MAX_TICKS,lifecycle,windowRange,interpolate,createCache,loadWindow,mergeSnapshot,liveSegment,createLiveObserver};
});
