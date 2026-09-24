'use strict';
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.OrbitalHistoryGL=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const HARD_MAX_POINTS=409600;
  const finiteKeys=['tick','elapsedSeconds','x','y'];
  const ANGLE=-.48,TILT=.66,COS=Math.cos(ANGLE),SIN=Math.sin(ANGLE);
  const VERTEX=`attribute vec2 aHigh;attribute vec2 aLow;uniform vec2 uOriginHigh;uniform vec2 uOriginLow;uniform vec2 uViewport;uniform float uScale;const float C=0.8869949227792842;const float S=-0.4617791755414829;const float T=0.66;void main(){vec2 p=(aHigh-uOriginHigh)+(aLow-uOriginLow);vec2 screen=uViewport*.5+uScale*vec2(p.x*C-p.y*T*S,p.x*S+p.y*T*C);vec2 clip=screen/uViewport*2.0-1.0;gl_Position=vec4(clip.x,-clip.y,0.0,1.0);}`;
  const FRAGMENT=`precision mediump float;void main(){gl_FragColor=vec4(0.643,0.859,0.651,0.52);}`;

  function split64(value){
    const high=Math.fround(value);
    return {high,low:value-high};
  }

  function worldOrigin(view,width,height){
    const dx=width*.5-view.cx,dy=height*.5-view.cy;
    return {x:split64((dx*COS+dy*SIN)/view.scale),y:split64((-dx*SIN+dy*COS)/(view.scale*TILT))};
  }

  function projectSplit(point,view,width,height){
    const px=split64(point.x),py=split64(-point.y),origin=worldOrigin(view,width,height);
    const x=(px.high-origin.x.high)+(px.low-origin.x.low),y=(py.high-origin.y.high)+(py.low-origin.y.low);
    return {x:width*.5+view.scale*(x*COS-y*TILT*SIN),y:height*.5+view.scale*(x*SIN+y*TILT*COS)};
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

  function createRenderer(canvas,{maxPoints=HARD_MAX_POINTS,onStatus=()=>{}}={}){
    if(!Number.isSafeInteger(maxPoints)||maxPoints<1||maxPoints>HARD_MAX_POINTS)throw new Error('历史点上限无效');
    let gl=null,program=null,highBuffer=null,lowBuffer=null,locations=null,chunks=[],lost=false,destroyed=false,available=false;

    function disposeGPU(){
      if(gl){if(highBuffer)gl.deleteBuffer(highBuffer);if(lowBuffer)gl.deleteBuffer(lowBuffer);if(program)gl.deleteProgram(program);}
      highBuffer=null;lowBuffer=null;program=null;locations=null;
    }
    function shader(type,source){
      const out=gl.createShader(type);gl.shaderSource(out,source);gl.compileShader(out);
      if(!gl.getShaderParameter(out,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(out)||'轨迹着色器编译失败');
      return out;
    }
    function initialize(){
      gl=canvas.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:true,preserveDrawingBuffer:false});
      if(!gl)return false;
      const vertex=shader(gl.VERTEX_SHADER,VERTEX),fragment=shader(gl.FRAGMENT_SHADER,FRAGMENT),next=gl.createProgram();
      gl.attachShader(next,vertex);gl.attachShader(next,fragment);gl.linkProgram(next);
      if(!gl.getProgramParameter(next,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(next)||'轨迹着色器链接失败');
      program=next;locations={high:gl.getAttribLocation(program,'aHigh'),low:gl.getAttribLocation(program,'aLow'),originHigh:gl.getUniformLocation(program,'uOriginHigh'),originLow:gl.getUniformLocation(program,'uOriginLow'),viewport:gl.getUniformLocation(program,'uViewport'),scale:gl.getUniformLocation(program,'uScale')};
      gl.useProgram(program);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
      return true;
    }
    function ensureBuffers(){
      if(highBuffer&&lowBuffer)return;
      const bytes=maxPoints*2*Float32Array.BYTES_PER_ELEMENT;
      highBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,highBuffer);gl.bufferData(gl.ARRAY_BUFFER,bytes,gl.DYNAMIC_DRAW);
      lowBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,lowBuffer);gl.bufferData(gl.ARRAY_BUFFER,bytes,gl.DYNAMIC_DRAW);
    }
    function encoded(chunk){
      const high=new Float32Array(chunk.length*2),low=new Float32Array(chunk.length*2);
      for(let i=0;i<chunk.length;i++){
        const x=split64(chunk.x[i]),y=split64(-chunk.y[i]),at=i*2;
        high[at]=x.high;high[at+1]=y.high;low[at]=x.low;low[at+1]=y.low;
      }
      return {high,low};
    }
    function upload(chunk){
      ensureBuffers();const data=encoded(chunk),offset=chunk.base*2*Float32Array.BYTES_PER_ELEMENT;
      gl.bindBuffer(gl.ARRAY_BUFFER,highBuffer);gl.bufferSubData(gl.ARRAY_BUFFER,offset,data.high);
      gl.bindBuffer(gl.ARRAY_BUFFER,lowBuffer);gl.bufferSubData(gl.ARRAY_BUFFER,offset,data.low);
    }
    function restore(){
      if(destroyed)return;
      disposeGPU();gl=null;
      try{
        if(!initialize()){available=false;lost=false;onStatus('restore-failed');return;}
        lost=false;available=true;for(const chunk of chunks)upload(chunk);onStatus('restored');
      }catch{
        disposeGPU();available=false;lost=false;onStatus('restore-failed');
      }
    }
    function contextLost(event){event.preventDefault();lost=true;onStatus('lost');}
    canvas.addEventListener('webglcontextlost',contextLost);
    canvas.addEventListener('webglcontextrestored',restore);
    try{
      if(initialize())available=true;else onStatus('unavailable');
    }catch{
      disposeGPU();available=false;onStatus('error');
    }

    return {
      append(chunk){if(!chunk)return;if(chunk.base+chunk.length>maxPoints)throw new Error(`历史点超过 ${maxPoints} 上限`);chunks.push(chunk);if(available&&!lost)upload(chunk);},
      render({view,width,height,dpr=1,hidden=false,segments=[]}){
        if(destroyed||hidden||lost||!available||!view||width<=0||height<=0)return false;
        const pixelWidth=Math.max(1,Math.round(width*dpr)),pixelHeight=Math.max(1,Math.round(height*dpr));
        if(canvas.width!==pixelWidth)canvas.width=pixelWidth;if(canvas.height!==pixelHeight)canvas.height=pixelHeight;
        gl.viewport(0,0,pixelWidth,pixelHeight);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.useProgram(program);
        if(!highBuffer||!lowBuffer||!segments.some(segment=>segment.count>1))return true;
        const origin=worldOrigin(view,width,height);
        gl.uniform2f(locations.originHigh,origin.x.high,origin.y.high);gl.uniform2f(locations.originLow,origin.x.low,origin.y.low);gl.uniform2f(locations.viewport,width,height);gl.uniform1f(locations.scale,view.scale);
        gl.bindBuffer(gl.ARRAY_BUFFER,highBuffer);gl.enableVertexAttribArray(locations.high);gl.vertexAttribPointer(locations.high,2,gl.FLOAT,false,0,0);
        gl.bindBuffer(gl.ARRAY_BUFFER,lowBuffer);gl.enableVertexAttribArray(locations.low);gl.vertexAttribPointer(locations.low,2,gl.FLOAT,false,0,0);
        for(const segment of segments)if(segment.count>1)gl.drawArrays(gl.LINE_STRIP,segment.start,segment.count);
        return true;
      },
      clear(){chunks=[];if(gl){if(highBuffer)gl.deleteBuffer(highBuffer);if(lowBuffer)gl.deleteBuffer(lowBuffer);}highBuffer=null;lowBuffer=null;},
      destroy(){if(destroyed)return;destroyed=true;canvas.removeEventListener('webglcontextlost',contextLost);canvas.removeEventListener('webglcontextrestored',restore);disposeGPU();chunks=[];available=false;},
      get available(){return available&&!destroyed;}
    };
  }

  return {HARD_MAX_POINTS,split64,projectSplit,createStore,createRenderer};
});
