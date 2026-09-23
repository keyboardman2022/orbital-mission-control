'use strict';
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.OrbitalHistoryGL=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const HARD_MAX_POINTS=409600;
  const finiteKeys=['tick','elapsedSeconds','x','y'];

  function split64(value){
    const high=Math.fround(value);
    return {high,low:value-high};
  }

  function createStore({maxPoints=HARD_MAX_POINTS}={}){
    if(!Number.isSafeInteger(maxPoints)||maxPoints<1||maxPoints>HARD_MAX_POINTS)throw new Error('历史点上限无效');
    let chunks=[],segments=[],pointCount=0,lastSeq=null;

    function locate(index){
      if(!Number.isSafeInteger(index)||index<0||index>=pointCount)return null;
      let lo=0,hi=chunks.length-1;
      while(lo<=hi){
        const mid=(lo+hi)>>1,chunk=chunks[mid];
        if(index<chunk.base)hi=mid-1;
        else if(index>=chunk.base+chunk.length)lo=mid+1;
        else return {chunk,offset:index-chunk.base};
      }
      return null;
    }

    const store={
      append(points){
        if(!Array.isArray(points)||!points.length)return null;
        if(pointCount+points.length>maxPoints)throw new Error(`历史点超过 ${maxPoints} 上限`);
        let previous=lastSeq;
        for(const p of points){
          if(!Number.isSafeInteger(p.seq)||p.seq<0||finiteKeys.some(key=>!Number.isFinite(p[key])))throw new Error('历史页包含无效点');
          if(previous!==null&&p.seq<=previous)throw new Error('历史序号必须严格递增');
          previous=p.seq;
        }
        const length=points.length,x=new Float64Array(length),y=new Float64Array(length),elapsedSeconds=new Float64Array(length),tick=new Float64Array(length),seq=new Uint32Array(length);
        for(let i=0;i<length;i++){
          const p=points[i];x[i]=p.x;y[i]=p.y;elapsedSeconds[i]=p.elapsedSeconds;tick[i]=p.tick;seq[i]=p.seq;
        }
        const base=pointCount;
        for(let i=0;i<length;i++){
          const prior=i?seq[i-1]:lastSeq;
          if(prior===null||seq[i]!==prior+1)segments.push({start:base+i,count:1});
          else segments.at(-1).count++;
        }
        const chunk={base,length,x,y,elapsedSeconds,tick,seq};
        chunks.push(chunk);pointCount+=length;lastSeq=seq[length-1];
        return chunk;
      },
      pointAt(index){
        const found=locate(index);if(!found)return null;
        const {chunk,offset}=found;
        return {x:chunk.x[offset],y:chunk.y[offset],elapsedSeconds:chunk.elapsedSeconds[offset],tick:chunk.tick[offset],seq:chunk.seq[offset]};
      },
      visibleRanges(time){
        if(!Number.isFinite(time))return [];
        const ranges=[];
        for(const segment of segments){
          let lo=segment.start,hi=segment.start+segment.count-1;
          if(store.pointAt(lo).elapsedSeconds>time)continue;
          while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(store.pointAt(mid).elapsedSeconds<=time)lo=mid;else hi=mid-1;}
          const count=lo-segment.start+1;if(count>1)ranges.push({start:segment.start,count});
        }
        return ranges;
      },
      clear(){chunks=[];segments=[];pointCount=0;lastSeq=null;},
      get chunks(){return chunks;},
      get segments(){return segments.map(segment=>({...segment}));},
      get pointCount(){return pointCount;},
      get lastSeq(){return lastSeq;}
    };
    return store;
  }

  return {HARD_MAX_POINTS,split64,createStore};
});
