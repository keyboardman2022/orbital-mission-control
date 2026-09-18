'use strict';
(() => {
  const $ = id => document.getElementById(id), model = OrbitalModel, units=OrbitalUnits,scale=units.SCALE;
  const fields = ['name','x','y','massKg','speed','directionDeg'];
  const statusText = {queued:'排队中',active:'运行中',captured:'已捕获',escaped:'已逃逸',terminated:'已终止',error:'计算中断'};
  const canvas=$('universe'),ctx=canvas.getContext('2d'),visuals=OrbitalVisuals.create();
  const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
  let visualTime=0,liveTime=0,recovering=false,lastTelemetryTime=-1,impactWaves=[],seenCaptures=new Set(),replayCaptureShown=false;
  let mapWave=null,sweepBusy=false,sweepSending=false,sweepLastSend=-1,sweepEpoch=0;
  const sweptIds=new Set(),sweepPending=new Set();
  const visualMass=mass=>Math.max(1,Math.min(3,1+Math.log10(Math.max(1,mass)/1000+1)*.6));
  const MIN_ZOOM=1e-7,MAX_ZOOM=2;
  let width=0,height=0,zoom=1.2,view,draft=null,draftVisible=true,invalidCapture=false,preview=[],previewToken=0,previewTimer;
  let cameraOffset={x:0,y:0},lastPointer=null;
  let mapDrag=null,suppressMapClick=false,mapTool='pick',tracking=false;
  const holeMarker=$('blackHoleMarker'),holeIcon=holeMarker.querySelector('.origin-icon'),holeLabel=holeMarker.querySelector('.origin-label');
  let csrf='',online=false,sessionReady=false,stream=null,streamEpoch=0,connecting=false,identityEpoch=0,selectionEpoch=0,selectedId=null;
  let satellites=new Map(),trails=new Map(),displayStates=new Map(),liveObservers=new Map(),hiddenLive=false,paused=false,nextCursor=null;
  let historyPoints=[],historyMode=false,playing=false,replayElapsed=0,lastFrame=performance.now(),recoveryKey='',pendingLaunch=null,launchBusy=false;
  const history=OrbitalHistory,historyCache=history.createCache();
  let historySnapshot=null,historyCutoffSeq,historyVersion=0,historyController=null,historyLoading=false,historyResume=false;
  let exportTimer=null,exportEpoch=0,lastServerTick=-1,currentUserId=null,identityBusy=false;
  function identityLock(busy){identityBusy=busy;for(const id of ['reconnect','recover','rotateKey','logout'])$(id).disabled=busy;}
  const satelliteNodes=new Map();
  const worker=typeof Worker!=='undefined'?new Worker('preview-worker.js'):null;
  const stars=Array.from({length:310},(_,i)=>({x:((Math.sin(i*37.73+4)*43758.5453)%1+1)%1,y:((Math.sin(i*18.35+2)*17838.123)%1+1)%1,r:i%13===0?1.3:.55,a:.18+(i%9)*.06}));
  function message(text){$('notice').textContent=text;}
  function number(id){return $(id).value.trim()===''?NaN:Number($(id).value);}
  function readInput(){return {name:$('name').value.trim(),position:{x:number('x'),y:number('y')},massKg:number('massKg'),speed:number('speed'),directionDeg:number('directionDeg'),unitSystem:'si-km-v1',calibrationVersion:scale.version,modelVersion:model.MODEL.version,dynamicsVersion:model.MODEL.dynamics.version};}
  function worldPosition(){return {x:units.fromKm(number('x')),y:units.fromKm(number('y'))};}
  function normalize(input){const result=model.validateLaunch(input);if(result&&result.valid===false)throw new Error(result.error||result.message||'参数无效');return result.normalized||result.value||result;}
  function updateLaunch(){ $('launch').disabled=!draft||!online||!sessionReady||launchBusy||sweepBusy;$('sweepAll').disabled=!online||!sessionReady||sweepBusy||launchBusy; }
  function validate(){
    fields.forEach(id=>{$(id).removeAttribute('aria-invalid');const hint=$(id+'Error');if(hint){hint.hidden=true;hint.textContent='';}});draftVisible=true;draft=null;invalidCapture=false;preview=[];previewToken++;
    const input=readInput(), errors=[];
    const flag=(id,text)=>{$(id).setAttribute('aria-invalid','true');const hint=$(id+'Error');if(hint){hint.textContent=text;hint.hidden=false;}errors.push(text);};
    if(Array.from(input.name).length>64)flag('name','自定义名称最多64个字符，留空可自动命名');
    if(!Number.isFinite(input.position.x))flag('x','请输入有效 X 坐标');
    if(!Number.isFinite(input.position.y))flag('y','请输入有效 Y 坐标');
    const radius=units.fromKm(Math.hypot(input.position.x,input.position.y));
    if(Number.isFinite(radius)&&(radius<model.MODEL.limits.minRadius||radius>model.MODEL.limits.maxRadius)){flag('x',radius<=69.3?'位置在捕获面内，无法发射':`出生半径须在 ${units.formatKm(units.toKm(80))}–${units.formatKm(units.toKm(model.MODEL.limits.maxRadius))} 范围内`);$('y').setAttribute('aria-invalid','true');invalidCapture=radius<=69.3;}
    if(!Number.isFinite(input.massKg)||input.massKg<=0||input.massKg>model.MODEL.dynamics.maxMassKg)flag('massKg','质量须大于 0 且不超过 10³⁰ kg');
    if(!Number.isFinite(input.speed)||input.speed<0||input.speed>=units.C_KM_S)flag('speed','初速度须 ≥ 0 且小于光速 299792.458 km/s');
    if(!Number.isFinite(input.directionDeg))flag('directionDeg','请输入有限方向角度');
    if(!errors.length){try{draft=normalize(input);}catch(e){errors.push(e.message);}}
    $('validation').textContent=errors.join('；');
    $('references').textContent=Number.isFinite(radius)&&radius>69.3?`圆轨道参考 ≈ ${units.toKmS(model.circularSpeed(radius,model.effectiveMu(input.massKg))).toLocaleString('zh-CN',{maximumFractionDigits:2})} km/s · 逃逸参考 ≈ ${units.toKmS(model.escapeSpeed(radius,model.effectiveMu(input.massKg))).toLocaleString('zh-CN',{maximumFractionDigits:2})} km/s${radius<3*model.MODEL.rs?' · 此半径无稳定圆轨道':''}${input.speed>.1*units.C_KM_S?' · 高速区域需相对论修正':''}`:'';
    $('massEffect').textContent=Number.isFinite(input.massKg)&&input.massKg>0?`质量进入独立双体计算 · m/M = ${(input.massKg/units.centralMassKg).toExponential(2)}。${input.massKg/units.centralMassKg<1e-10?'普通卫星影响极微小；可用科学计数法输入大质量。':'有限质量伪牛顿近似，大质量近视界不等同于真实相对论结果。'}`:'';
    if(pendingLaunch&&!launchBusy){$('launchMessage').textContent='有一次发射结果尚未确认；再次发射将先重试原请求，避免重复创建。';}
    updateLaunch();clearTimeout(previewTimer);
    if(draft&&$('predict').checked&&worker){const token=previewToken,inputSnapshot=readInput();previewTimer=setTimeout(()=>worker.postMessage({token,input:inputSnapshot}),180);}
  }
  if(worker){worker.onmessage=({data})=>{if(data.token===previewToken){preview=data.points||[];if(data.error)$('launchMessage').textContent='预测暂不可用：'+data.error;}};worker.onerror=()=>{$('launchMessage').textContent='预测工作线程不可用；参数定位与正式发射仍可使用。';};}
  fields.forEach(id=>{const hint=document.createElement('span');hint.id=id+'Error';hint.className='field-error';hint.hidden=true;$(id).after(hint);$(id).setAttribute('aria-describedby',hint.id);});
  fields.forEach(id=>$(id).addEventListener('input',validate));$('predict').addEventListener('change',validate);
  document.querySelectorAll('[data-preset]').forEach(button=>button.addEventListener('click',()=>{const {x,y}=worldPosition(),r=Math.hypot(x,y);if(!Number.isFinite(r)||r<80||r>model.MODEL.limits.maxRadius)return;const radial=Math.atan2(y,x)*180/Math.PI;const mode=button.dataset.preset;$('speed').value=units.toKmS(mode==='escape'?model.escapeSpeed(r,model.effectiveMu(number('massKg')))*1.1:mode==='infall'?model.circularSpeed(r,model.effectiveMu(number('massKg')))*.45:model.circularSpeed(r,model.effectiveMu(number('massKg')))).toFixed(6);$('directionDeg').value=((radial+(mode==='escape'?20:mode==='infall'?150:90)+360)%360).toFixed(2);validate();}));
  function project(x,y){return OrbitalCamera.toScreen(x,-y,view);}
  function resize(){const bounds=canvas.getBoundingClientRect();width=bounds.width;height=bounds.height;lastPointer=null;const dpr=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);view=OrbitalCamera.view(width,height,zoom,cameraOffset);}
  new ResizeObserver(resize).observe(canvas);
  function setZoom(value,anchor=null,recenter=false){
    zoom=Math.max(MIN_ZOOM,Math.min(MAX_ZOOM,value));if(recenter)cameraOffset={x:0,y:0};
    const next=OrbitalCamera.view(width,height,zoom,cameraOffset);
    view=anchor&&view?.scale>0?OrbitalCamera.zoomAt(view,next.scale,anchor):next;
    cameraOffset={x:view.cx-width*.54,y:view.cy-height*.49};
    $('zoom').value=Math.round(Math.log(zoom/MIN_ZOOM)/Math.log(MAX_ZOOM/MIN_ZOOM)*1000);$('zoomValue').textContent=Number((zoom*100).toPrecision(3))+'%';
  }
  const pointerPosition=e=>{const rect=canvas.getBoundingClientRect();return {x:e.clientX-rect.left,y:e.clientY-rect.top};};
  canvas.addEventListener('mousemove',e=>{lastPointer=pointerPosition(e);});
  function panMap(dx,dy){
    if(!view)return;setTracking(false);$('follow').checked=false;view=OrbitalCamera.pan(view,dx,dy);
    cameraOffset={x:view.cx-width*.54,y:view.cy-height*.49};
  }
  canvas.addEventListener('pointerdown',e=>{
    if(!e.isPrimary||e.button!==0||mapDrag)return;
    suppressMapClick=false;mapDrag={id:e.pointerId,startX:e.clientX,startY:e.clientY,lastX:e.clientX,lastY:e.clientY,moved:false};
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove',e=>{
    if(!mapDrag||mapDrag.id!==e.pointerId)return;
    if(!mapDrag.moved&&Math.hypot(e.clientX-mapDrag.startX,e.clientY-mapDrag.startY)<6)return;
    const fromX=mapDrag.moved?mapDrag.lastX:mapDrag.startX,fromY=mapDrag.moved?mapDrag.lastY:mapDrag.startY;
    mapDrag.moved=true;if(mapTool==='pan'){canvas.classList.add('dragging');panMap(e.clientX-fromX,e.clientY-fromY);}
    mapDrag.lastX=e.clientX;mapDrag.lastY=e.clientY;lastPointer=pointerPosition(e);if(e.cancelable)e.preventDefault();
  });
  function endMapDrag(e){
    if(!mapDrag||mapDrag.id!==e.pointerId)return;
    suppressMapClick=mapDrag.moved;mapDrag=null;canvas.classList.remove('dragging');
    if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);
  }
  for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,endMapDrag);
  function setMapTool(tool){
    if(mapDrag)endMapDrag({pointerId:mapDrag.id});
    mapTool=tool;suppressMapClick=false;canvas.dataset.tool=tool;
    $('panTool').setAttribute('aria-pressed',String(tool==='pan'));
    $('pickTool').setAttribute('aria-pressed',String(tool==='pick'));
    $('toolHint').textContent=tool==='pan'?'按住拖动平移星图，滚轮缩放':'单击星图选择坐标，再在左侧正式发射';
    canvas.setAttribute('aria-label',tool==='pan'?'星图：拖动平移，滚轮缩放；方向键平移':'星图：单击选择发射坐标，滚轮缩放；方向键平移');
  }
  $('panTool').onclick=()=>setMapTool('pan');$('pickTool').onclick=()=>setMapTool('pick');
  canvas.addEventListener('keydown',e=>{
    const delta={ArrowLeft:[40,0],ArrowRight:[-40,0],ArrowUp:[0,40],ArrowDown:[0,-40]}[e.key];
    if(delta){e.preventDefault();panMap(delta[0]*(e.shiftKey?2:1),delta[1]*(e.shiftKey?2:1));}
  });
  $('zoom').addEventListener('input',()=>{$('follow').checked=false;setZoom(MIN_ZOOM*(MAX_ZOOM/MIN_ZOOM)**(number('zoom')/1000),tracking?{x:width*.5,y:height*.52}:lastPointer||{x:width/2,y:height/2});});
  canvas.addEventListener('wheel',e=>{if(!e.deltaY)return;e.preventDefault();$('follow').checked=false;lastPointer=pointerPosition(e);const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?height:1);setZoom(zoom*Math.exp(-delta*.001),tracking?{x:width*.5,y:height*.52}:lastPointer);},{passive:false});
  canvas.addEventListener('click',e=>{if(suppressMapClick){suppressMapClick=false;return;}
    if(!hiddenLive&&!historyMode){const click=pointerPosition(e);let hit=null,best=Infinity;
      for(const s of displayStates.values()){
        if(!['active','escaped'].includes(s.status)||!s.state||Math.hypot(s.state.x,s.state.y)<model.MODEL.rs)continue;
        const appearance=OrbitalVisuals.satelliteAppearance(view.scale,visualMass(s.massKg));if(appearance.opacity<.05)continue;
        const p=observedPosition(s.id),q=project(p.x,p.y),distance=Math.hypot(q.x-click.x,q.y-click.y);
        if(distance<Math.max(6,Math.min(14,appearance.radius*.3))&&distance<best){hit=s.id;best=distance;}
      }
      if(hit){selectSatellite(hit);return;}
    }
    if(mapTool!=='pick')return;const rect=canvas.getBoundingClientRect(),p=OrbitalCamera.toWorld(e.clientX-rect.left,e.clientY-rect.top,view);$('x').value=units.toKm(p.x).toFixed(6);$('y').value=units.toKm(-p.y).toFixed(6);validate();});
  function fitPosition(p){
    if(!p||![p.x,p.y].every(Number.isFinite)||!width||!height)return zoom;
    const base=OrbitalCamera.view(width,height,1),s=OrbitalCamera.toScreen(p.x,-p.y,base),dx=s.x-base.cx,dy=s.y-base.cy;
    const xRoom=dx>=0?width-100-base.cx:base.cx-35,yRoom=dy>=0?height-100-base.cy:base.cy-170;
    return Math.min(MAX_ZOOM,Math.max(1,xRoom)/Math.max(Math.abs(dx),1),Math.max(1,yRoom)/Math.max(Math.abs(dy),1));
  }
  $('locate').onclick=()=>{setTracking(false);setZoom(fitPosition(worldPosition()),null,true);};
  $('fitSelected').onclick=()=>{setTracking(false);const s=displayStates.get(selectedId)||satellites.get(selectedId);setZoom(fitPosition(historyMode?replayPoint(replayElapsed):s?.state),null,true);};
  $('resetView').onclick=()=>{setTracking(false);$('follow').checked=false;lastPointer=null;setZoom(1.2,null,true);};
  holeMarker.onclick=()=>{setTracking(false);$('follow').checked=false;setZoom(zoom,null,true);};
  function setTracking(enabled){
    tracking=Boolean(enabled&&selectedId);if(tracking)$('follow').checked=false;
    $('trackSelected').textContent=tracking?'退出跟踪':'跟踪卫星';
    $('trackSelected').setAttribute('aria-pressed',String(tracking));
  }
  $('trackSelected').onclick=()=>setTracking(!tracking);
  $('follow').addEventListener('change',()=>{if($('follow').checked)setTracking(false);});
  function observedPosition(id){
    if(sweptIds.has(id))return null;
    const s=displayStates.get(id)||satellites.get(id);if(!s?.state)return null;
    return {...(liveObservers.get(id)?.state||s.state)};
  }
  function updateHoleMarker(){
    const marker=OrbitalCamera.originMarker(view,width,height);
    holeMarker.style.left=marker.x+'px';holeMarker.style.top=marker.y+'px';
    holeMarker.classList.toggle('outside',!marker.inView);
    holeIcon.textContent=marker.inView?'':'➤';holeIcon.style.transform=marker.inView?'':`rotate(${marker.angle}rad)`;
    holeLabel.textContent=marker.inView?'黑洞中心':'黑洞方向';
    holeMarker.title=marker.inView?'黑洞中心 · 点击居中':'黑洞在此方向 · 点击定位';
  }
  function holeView(){const factor=model.MODEL.rs/171;return {...view,scale:view.scale*factor,size:view.size*factor};}
  function distanceGrid(){
    const km=units.niceDistance(units.toKm(150/view.scale)),r=units.fromKm(km);
    line([{x:-r*5,y:0},{x:r*5,y:0}],'#ffffff0b');line([{x:0,y:-r*5},{x:0,y:r*5}],'#ffffff0b');
    for(let i=1;i<=5;i++){ring(r*i,'#99aabb16');const q=project(r*i,0);if(q.x>20&&q.x<width-100&&q.y>150&&q.y<height-180){ctx.font='10px ui-monospace,monospace';ctx.fillStyle='#8eaaa8';ctx.fillText(units.formatKm(km*i),q.x+7,q.y-5);}}
    const rulerKm=units.niceDistance(units.toKm(120/view.scale)),length=units.fromKm(rulerKm)*view.scale;
    // A world-X segment is rotated but not foreshortened by the Y-axis tilt.
    ctx.save();ctx.translate(30,height-165);ctx.rotate(-.48);ctx.strokeStyle='#a4dba6';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,-4);ctx.lineTo(0,4);ctx.moveTo(0,0);ctx.lineTo(length,0);ctx.moveTo(length,-4);ctx.lineTo(length,4);ctx.stroke();ctx.restore();
    ctx.font='10px ui-monospace,monospace';ctx.fillStyle='#b4ccbc';ctx.fillText(units.formatKm(rulerKm)+' · 世界平面',30,height-141);
  }
  function line(points,color,lineWidth=1,dash=[]){if(!points.length)return;ctx.beginPath();points.forEach((p,i)=>{const q=project(p.x,p.y);i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y);});ctx.strokeStyle=color;ctx.lineWidth=lineWidth;ctx.setLineDash(dash);ctx.stroke();ctx.setLineDash([]);}
  function ring(r,color,lineWidth=1){const pts=[];for(let i=0;i<=180;i++){const a=i/180*Math.PI*2;pts.push({x:r*Math.cos(a),y:r*Math.sin(a)});}line(pts,color,lineWidth);}
  function draw(){
    if(!view)return;ctx.clearRect(0,0,width,height);ctx.fillStyle='#05070c';ctx.fillRect(0,0,width,height);
    stars.forEach(s=>{ctx.globalAlpha=s.a*(.8+.2*Math.sin(visualTime*.65+s.x*50));ctx.fillStyle='#c6d3ec';ctx.beginPath();ctx.arc(s.x*width,s.y*height,s.r,0,Math.PI*2);ctx.fill();});ctx.globalAlpha=1;
    if($('follow').checked){const s=displayStates.get(selectedId);const point=historyMode?replayPoint(replayElapsed):s?.state;if(point)setZoom(Math.min(zoom,fitPosition(point)),null,true);}
    if(tracking&&selectedId){const p=historyMode?replayPoint(replayElapsed):observedPosition(selectedId);if(p){
      view=OrbitalCamera.followAt(view,{x:p.x,y:-p.y},{x:width*.5,y:height*.52});
      cameraOffset={x:view.cx-width*.54,y:view.cy-height*.49};
    }}
    updateHoleMarker();
    visuals.blackhole(ctx,width,height,holeView(),visualTime);
    distanceGrid();
    if(view.scale*model.MODEL.rs>12){ring(model.MODEL.rs,'#a4dba650');const q=project(model.MODEL.rs,0);ctx.fillStyle='#a4dba6';ctx.font='10px ui-monospace,monospace';ctx.fillText('r_s = '+units.formatKm(scale.schwarzschildRadiusKm),q.x+8,q.y+14);}
    if(preview.length&&draftVisible&&!historyMode)line(preview,'#ffaa6680',1,[4,6]);
    if(historyMode&&historyPoints.length){const step=Math.max(1,Math.ceil(historyPoints.length/2200));const visibility=OrbitalVisuals.satelliteAppearance(view.scale).opacity;if(visibility>=.001)line(historyPoints.filter((_,i)=>i%step===0),`rgba(164,219,166,${visibility*.3})`,view.scale*2);const point=replayPoint(replayElapsed),last=historyPoints.at(-1);if(point&&!(last.kind==='captured'&&replayElapsed>=last.elapsedSeconds-1e-9))drawSatellite(point,'回放 / '+(satellites.get(selectedId)?.name||''),true,satellites.get(selectedId)?.massKg||1000);}
    else if(!hiddenLive&&!historyMode){for(const [id,s]of displayStates){
      if(!['active','captured','escaped'].includes(s.status))continue;
      if(s.status==='captured'&&!impactWaves.some(w=>w.id===id))continue;
      ctx.save();const radius=model.MODEL.rs*view.scale;
      // Clip in screen coordinates so moving the hole far offscreen cannot hide satellites.
      ctx.beginPath();ctx.rect(0,0,width,height);ctx.moveTo(view.cx+radius*Math.cos(-.48),view.cy+radius*Math.sin(-.48));ctx.ellipse(view.cx,view.cy,radius,radius*.66,-.48,0,Math.PI*2);ctx.clip('evenodd');
      const position=observedPosition(id);
      const tail=trails.get(id)||[],visibleTail=position?tail.filter(p=>p.elapsedSeconds<position.elapsedSeconds):tail;
      const stride=Math.max(1,Math.ceil(visibleTail.length/360)),drawTail=visibleTail.filter((_,i)=>i%stride===0);
      visuals.trail(ctx,position?[...drawTail,position]:drawTail,project,visualMass(s.massKg),view.scale);
      if(position&&['active','escaped'].includes(s.status))drawSatellite(position,s.name+(s.status==='escaped'?' / 最后位置':''),id===selectedId,s.massKg);ctx.restore();
    }}
    if(!hiddenLive)for(const wave of impactWaves)visuals.impact(ctx,holeView(),visualTime-wave.born,wave.mass,wave.angle);
    if(mapWave)visuals.mapImpact(ctx,mapWave);
    if(historyMode&&historyPoints.length){const last=historyPoints.at(-1);
      if(last.kind==='captured'&&replayElapsed>=last.elapsedSeconds-1e-9&&!replayCaptureShown){replayCaptureShown=true;impactWaves.push({born:visualTime,mass:visualMass(satellites.get(selectedId)?.massKg||1000),angle:Math.atan2(-last.y,last.x)});}
      if(replayElapsed<last.elapsedSeconds-1e-9)replayCaptureShown=false;
    }
    const raw=readInput(),p=draft?.position||(invalidCapture?worldPosition():null);
    let off=false;
    if(p&&draftVisible&&!historyMode){const q=project(p.x,p.y);off=q.x<25||q.x>width-25||q.y<150||q.y>height-65;const color=invalidCapture?'#ff6b64':'#ffb37c';ctx.save();ctx.strokeStyle=color;ctx.lineWidth=.75;ctx.globalAlpha=.65;ctx.setLineDash([2,3]);ctx.beginPath();ctx.moveTo(q.x-10,q.y);ctx.lineTo(q.x-3,q.y);ctx.moveTo(q.x+3,q.y);ctx.lineTo(q.x+10,q.y);ctx.moveTo(q.x,q.y-10);ctx.lineTo(q.x,q.y-3);ctx.moveTo(q.x,q.y+3);ctx.lineTo(q.x,q.y+10);ctx.stroke();ctx.beginPath();ctx.arc(q.x,q.y,4.5,0,Math.PI*2);ctx.stroke();ctx.restore();ctx.strokeStyle=color;ctx.lineWidth=.8;ctx.font='10px ui-monospace,monospace';ctx.fillStyle=color+'bb';const labelX=Math.min(Math.max(10,q.x+15),width-185),labelY=Math.max(160,q.y-22);ctx.fillText((invalidCapture?'无效位置':'待发射')+' / '+raw.name.slice(0,20),labelX,labelY);ctx.fillText(`(${units.toKm(p.x).toFixed(2)}, ${units.toKm(p.y).toFixed(2)}) km`,labelX,labelY+16);
      if(!invalidCapture&&raw.speed>0){const a=(((raw.directionDeg%360)+360)%360)*Math.PI/180,v=project(p.x+Math.cos(a),p.y+Math.sin(a)),dx=v.x-q.x,dy=v.y-q.y,len=Math.hypot(dx,dy),ux=dx/len,uy=dy/len,ex=q.x+ux*55,ey=q.y+uy*55;ctx.save();ctx.globalAlpha=.7;ctx.setLineDash([3,4]);ctx.beginPath();ctx.moveTo(q.x,q.y);ctx.lineTo(ex,ey);ctx.stroke();ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(ex-ux*8-uy*4,ey-uy*8+ux*4);ctx.lineTo(ex,ey);ctx.lineTo(ex-ux*8+uy*4,ey-uy*8-ux*4);ctx.stroke();ctx.restore();ctx.fillText(`${((raw.directionDeg%360)+360)%360}° · ${raw.speed.toLocaleString()} km/s`,Math.max(8,Math.min(width-140,ex+10)),ey+16);}else if(!invalidCapture)ctx.fillText('静止释放',labelX,labelY+32);
    }
    $('offscreen').hidden=!off;$('coordinateReadout').textContent='WORLD / km · +Y UP';
    const selected=displayStates.get(selectedId)||satellites.get(selectedId),state=historyMode?replayPoint(replayElapsed):observedPosition(selectedId);
    $('telemetryHud').hidden=!state||hiddenLive;
    if(state&&!hiddenLive){const t=units.telemetry(state,selected?.calibration||scale);$('telemetryHud').textContent=`${tracking?'跟踪 / ':''}${selected?.name||'卫星'} · ${units.formatSpeed(state,selected?.calibration||scale)} · 距中心 ${units.formatKm(t.radiusKm)}`;
      const q=project(state.x,state.y);if(q.x<15||q.x>width-15||q.y<140||q.y>height-110){const x=Math.max(18,Math.min(width-18,q.x)),y=Math.max(150,Math.min(height-165,q.y));ctx.save();ctx.translate(x,y);ctx.rotate(Math.atan2(q.y-y,q.x-x));ctx.fillStyle='#a4dba6';ctx.beginPath();ctx.moveTo(7,0);ctx.lineTo(-5,-5);ctx.lineTo(-5,5);ctx.closePath();ctx.fill();ctx.restore();}}
  }
  function drawSatellite(state,name,selected,massKg=1000){
    if(!Number.isFinite(state.x)||!Number.isFinite(state.y))return;
    const mass=visualMass(massKg),appearance=OrbitalVisuals.satelliteAppearance(view.scale,mass);
    if(appearance.opacity<.001)return;
    const q=project(state.x,state.y);visuals.satellite(ctx,q,view.scale,mass);
    if(selected){ctx.save();ctx.globalAlpha=appearance.opacity;ctx.strokeStyle='#ffe5ad88';ctx.lineWidth=Math.min(1,view.scale/.4);ctx.beginPath();ctx.arc(q.x,q.y,Math.min(9,appearance.radius*1.1),0,Math.PI*2);ctx.stroke();if(appearance.radius>=1.5){ctx.fillStyle='#fff0c7';ctx.font='11px ui-monospace,monospace';ctx.fillText(name.slice(0,24),q.x+14,q.y+4);}ctx.restore();}
  }
  function captureVisual(s){
    if(seenCaptures.has(s.id))return;seenCaptures.add(s.id);
    impactWaves.push({id:s.id,born:visualTime,mass:visualMass(s.massKg),angle:Math.atan2(-s.state.y,s.state.x)});
    if(impactWaves.length>12)impactWaves.shift();
    message(`「${s.name}」已被黑洞吞噬 · 存活 ${s.state.elapsedSeconds.toFixed(3)} 模拟秒`);
  }
  function replayPoint(time){return history.interpolate(historyPoints,time);}
  function clearHistory(){historyVersion++;historyController?.abort();historyController=null;historyLoading=false;historyResume=false;historySnapshot=null;historyCutoffSeq=undefined;historyCache.clear();historyPoints=[];$('history').disabled=false;$('play').textContent='播放';}
  function cachedHistory(time){const tick=Math.min(historySnapshot?.tick??0,time*model.MODEL.tickRate),range=historyCache.range;return !!range&&tick>=range.fromTick&&tick<=range.toTick&&historyCache.contains(time);}
  async function requestHistory(time,resume=false){
    if(!historySnapshot)return false;
    const id=selectedId,identity=identityEpoch,selection=selectionEpoch,version=++historyVersion;
    historyController?.abort();historyController=new AbortController();const signal=historyController.signal;
    replayElapsed=Math.min(history.lifecycle(historySnapshot,model.MODEL.tickRate).endSeconds,Math.max(0,time));$('timeline').value=replayElapsed;
    historyResume=resume;playing=false;$('play').textContent=resume?'暂停':'播放';
    if(cachedHistory(replayElapsed)){historyLoading=false;playing=resume;historyResume=false;$('history').disabled=false;updateReplayLabel();return true;}
    historyLoading=true;$('history').disabled=true;$('historyMessage').textContent='正在加载 '+replayElapsed.toFixed(2)+' 模拟秒附近的历史…';updateReplayLabel();
    const current=()=>version===historyVersion&&identity===identityEpoch&&selection===selectionEpoch&&id===selectedId&&!signal.aborted;
    try{
      const range=history.windowRange(replayElapsed,historySnapshot,model.MODEL.tickRate);
      const result=await history.loadWindow(range,async options=>{
        if(!current())throw new DOMException('History request replaced','AbortError');
        const params=new URLSearchParams({fromTick:String(options.fromTick),toTick:String(options.toTick),limit:String(options.limit),boundaries:'1'});
        if(options.cursor)params.set('cursor',options.cursor);if(options.cutoffSeq!==undefined)params.set('cutoffSeq',String(options.cutoffSeq));
        const data=await api('/api/satellites/'+encodeURIComponent(id)+'/trajectory?'+params,{signal});
        if(!current())throw new DOMException('History request replaced','AbortError');
        if(historyCutoffSeq===undefined){if(!Number.isSafeInteger(data.cutoffSeq))throw new Error('历史读取缺少固定截止标记');historyCutoffSeq=data.cutoffSeq;}
        return data;
      },{targetTick:replayElapsed*model.MODEL.tickRate,cutoffSeq:historyCutoffSeq});
      if(!current())return false;
      historyCutoffSeq=result.cutoffSeq;historyCache.set(result.range,result.points);historyPoints=historyCache.points;
      if(!historyCache.contains(replayElapsed))throw new Error('此时刻尚无可插值的已归档采样点，请稍后重新加载历史。');
      playing=historyResume;historyResume=false;$('play').textContent=playing?'暂停':'播放';
      $('historyMessage').textContent=`当前窗口 ${historyPoints.length} 个采样点 · 截止 tick ${historySnapshot.tick}。拖动完整时间轴按需读取历史，回放位置在相邻采样点间插值。`;updateReplayLabel();return true;
    }catch(e){if(current()){playing=false;historyResume=false;$('play').textContent='播放';$('historyMessage').textContent=e.message;}return false;}
    finally{if(current()){historyLoading=false;$('history').disabled=false;}}
  }
  function advanceLive(seconds){
    for(const [id,observer]of liveObservers){
      const points=observer.advance(seconds);if(!points.length)continue;
      trails.set(id,[...(trails.get(id)||[]),...points].slice(-1440));
      const s=displayStates.get(id);if(!s)continue;
      const shown={...s,state:{...observer.state},status:observer.state.status};displayStates.set(id,shown);
      if(shown.status==='captured'&&s.status==='active'&&!historyMode)captureVisual(shown);
    }
  }
  async function sendSweep(force=false){
    if(sweepSending||!sweepPending.size||(!force&&liveTime-sweepLastSend<.15))return;
    const ids=[...sweepPending].slice(0,250),epoch=sweepEpoch;ids.forEach(id=>sweepPending.delete(id));sweepSending=true;sweepLastSend=liveTime;
    try{const data=await api('/api/satellites/terminate-many',{method:'POST',body:JSON.stringify({ids})});if(epoch===sweepEpoch)ingest(data.satellites||[]);}
    catch(e){if(epoch===sweepEpoch){if(mapWave)mapWave.failures+=ids.length;for(const id of ids){sweptIds.delete(id);const s=satellites.get(id);if(s)setLiveRecord(s);}message('部分卫星清除失败，已恢复显示：'+e.message);}}
    finally{if(epoch===sweepEpoch){sweepSending=false;if(sweepPending.size)sendSweep(true);finishSweep();}}
  }
  function finishSweep(){if(mapWave?.done&&!sweepPending.size&&!sweepSending){const count=mapWave.total,failed=mapWave.failures;mapWave=null;sweepBusy=false;$('sweepAll').textContent='全图冲击波';$('viewMode').textContent=recovering?'服务器补算中 · 连续物理预演':'实时观察';updateLaunch();message(`冲击波已扫过全图 · 已清除 ${count-failed} 颗卫星，历史轨迹仍可回放与导出。${failed?` ${failed} 颗清除失败，已恢复显示，可重新尝试。`:''}`);}}
  function advanceSweep(seconds){
    if(!mapWave)return;mapWave.advance(seconds);
    const positions=new Map();for(const id of mapWave.remaining){const p=observedPosition(id);if(p)positions.set(id,project(p.x,p.y));}
    for(const id of mapWave.hits(positions)){
      const p=positions.get(id);if(p)mapWave.flares.push({...p,born:mapWave.age});
      sweptIds.add(id);sweepPending.add(id);displayStates.delete(id);liveObservers.delete(id);trails.delete(id);
    }
    mapWave.flares=mapWave.flares.filter(f=>mapWave.age-f.born<.5).slice(-100);
    sendSweep(mapWave.progress>=1);finishSweep();
  }
  $('sweepAll').onclick=async()=>{
    if(sweepBusy||!online||!sessionReady)return;sweepBusy=true;updateLaunch();const epoch=++sweepEpoch;$('sweepAll').textContent='正在蓄能…';
    try{
      const data=await api('/api/satellites/active');if(epoch!==sweepEpoch)return;
      const targets=(data.satellites||[]).filter(s=>['active','queued'].includes(s.status));
      clearHistory();historyMode=false;playing=false;hiddenLive=false;paused=false;$('pause').textContent='暂停观察';$('replay').hidden=true;
      for(const s of targets)satellites.set(s.id,s);
      const origin={x:Math.max(18,Math.min(width-18,view.cx)),y:Math.max(18,Math.min(height-18,view.cy))};
      mapWave=OrbitalSweep.create({ids:targets.map(s=>s.id),origin,width,height});mapWave.flares=[];mapWave.total=targets.length;mapWave.failures=0;
      $('sweepAll').textContent='冲击波扩散中…';$('viewMode').textContent='全图冲击波';message('冲击波正在扩散，扫过的卫星将终止运行；已有轨迹保留。');
    }catch(e){if(epoch===sweepEpoch){sweepBusy=false;$('sweepAll').textContent='全图冲击波';updateLaunch();message(e.message);}}
  };
  function frame(now){const elapsed=Math.max(0,(now-lastFrame)/1000),dt=Math.min(elapsed,.1);lastFrame=now;if(!paused){liveTime+=elapsed;if(!document.hidden){advanceLive(elapsed);advanceSweep(Math.min(elapsed,.1));}}if(!paused&&!document.hidden&&!reducedMotion.matches)visualTime+=dt*.3;impactWaves=impactWaves.filter(w=>visualTime-w.born<2.4);if(historyMode&&playing&&!historyLoading){const next=Math.min(Number($('timeline').max),replayElapsed+dt*number('rate'));if(!cachedHistory(next))requestHistory(next,true);else{replayElapsed=next;$('timeline').value=replayElapsed;if(replayElapsed>=Number($('timeline').max)){playing=false;$('play').textContent='播放';}updateReplayLabel();}}if(liveTime-lastTelemetryTime>=.1){renderList();renderDetail();lastTelemetryTime=liveTime;}draw();requestAnimationFrame(frame);}requestAnimationFrame(frame);
  async function api(path,options={}){if(options.method==='POST'&&options.body===undefined)options={...options,body:'{}'};const response=await fetch(path,{credentials:'same-origin',...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(options.method&&options.method!=='GET'?{'X-CSRF-Token':csrf}:{}),...options.headers}});let data;try{data=await response.json();}catch{throw new Error('服务返回了无法识别的数据，请确认通过 Node 服务打开页面。');}if(!response.ok){const e=new Error(data.error?.message||`请求失败 (${response.status})`);e.status=response.status;e.code=data.error?.code;throw e;}return data;}
  function setLiveRecord(s){
    if(sweptIds.has(s.id))return;
    let observer=liveObservers.get(s.id);if(!observer){observer=history.createLiveObserver(model);liveObservers.set(s.id,observer);}
    if(s.state){const reset=observer.accept({...s.state,status:s.status},{recovering});if(reset)trails.set(s.id,[{...observer.state}]);}
    displayStates.set(s.id,{...s,...(observer.state?{state:{...observer.state},status:observer.state.status}:{})});
  }
  function resetLiveDrawing(){liveObservers.clear();trails.clear();displayStates.clear();for(const s of Array.from(satellites.values()).slice(-100))setLiveRecord(s);const selected=satellites.get(selectedId);if(selected)setLiveRecord(selected);}
  function serverStatus(server){
    if(Number.isFinite(server?.tick)){if(server.tick<lastServerTick)return false;lastServerTick=server.tick;}
    online=true;const lag=Number(server?.lagSeconds||0),nextRecovering=server?.status==='recovering'||lag>2;
    if(recovering&&!nextRecovering&&!paused)resetLiveDrawing();recovering=nextRecovering;
    if(!historyMode&&!paused&&!hiddenLive&&!mapWave)$('viewMode').textContent=recovering?'服务器补算中 · 连续物理预演':'实时观察';
    $('connection').textContent=recovering?`服务已连接 · 正在补算离线轨迹 · 剩余 ${lag.toFixed(1)} 模拟秒`:`服务已连接 · ${server?.status||'running'}${lag>.2?' · 落后 '+lag.toFixed(1)+' 秒':''}`;updateLaunch();
  }
  function revealKey(key){recoveryKey=key||'';$('recoveryKey').textContent=recoveryKey;$('recoveryNotice').hidden=!recoveryKey;}
  function saveText(text,name,type='text/plain'){const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  $('copyKey').onclick=async()=>{try{await navigator.clipboard.writeText(recoveryKey);message('恢复密钥已复制，请保存在安全位置。');}catch{message('无法访问剪贴板，请使用下载密钥。');}};
  $('downloadKey').onclick=()=>saveText('ORBITAL 恢复密钥\n'+recoveryKey+'\n请私密保存。持有密钥可访问和控制此档案的卫星。','orbital-recovery-key.txt');$('dismissKey').onclick=()=>revealKey('');
  function resetIdentity(){sweepEpoch++;mapWave=null;sweepBusy=false;sweepSending=false;sweptIds.clear();sweepPending.clear();clearHistory();setTracking(false);currentUserId=null;impactWaves=[];seenCaptures.clear();lastServerTick=-1;paused=false;hiddenLive=false;$('pause').textContent='暂停观察';$('viewMode').textContent='实时观察';identityEpoch++;selectionEpoch++;exportEpoch++;clearTimeout(exportTimer);stream?.close();stream=null;satellites.clear();trails.clear();displayStates.clear();liveObservers.clear();selectedId=null;historyPoints=[];historyMode=false;playing=false;pendingLaunch=null;nextCursor=null;sessionReady=false;csrf='';revealKey('');$('detail').hidden=true;$('loadMore').hidden=true;$('replay').hidden=true;renderList();}
  async function connect(){if(connecting||identityBusy)return;connecting=true;identityLock(true);let epoch=identityEpoch;online=false;updateLaunch();$('connection').textContent='正在连接计算服务…';try{const session=await api('/api/session/guest',{method:'POST'});if(epoch!==identityEpoch)return;if(currentUserId&&currentUserId!==session.user.id){resetIdentity();epoch=identityEpoch;}currentUserId=session.user.id;csrf=session.csrfToken;sessionReady=true;$('identityLabel').textContent='档案 '+session.user.id;if(session.recoveryKey)revealKey(session.recoveryKey);const config=await api('/api/model');if(epoch!==identityEpoch)return;if((config.model.version||config.model.modelVersion)!==model.MODEL.version||config.model.calibration?.version!==scale.version||config.model.dynamics?.version!==model.MODEL.dynamics.version)throw new Error('浏览器模型或物理标定与服务器版本不一致，请刷新页面。');$('modelVersion').textContent=model.MODEL.dynamics.version;serverStatus(config.server);await loadList(false);if(epoch!==identityEpoch)return;openStream();}catch(e){online=false;$('connection').textContent='服务离线';message(e.message+' 请启动项目的 Node 服务后点击“重新连接”。');}finally{connecting=false;identityLock(false);updateLaunch();}}
  function openStream(){stream?.close();stream=new EventSource('/api/stream'+(selectedId?'?satelliteId='+encodeURIComponent(selectedId):''));const epoch=identityEpoch,subscription=++streamEpoch;stream.addEventListener('snapshot',event=>{if(epoch!==identityEpoch||subscription!==streamEpoch)return;try{const data=JSON.parse(event.data);if(serverStatus(data.server)===false)return;ingest(data.satellites||[]); }catch{message('实时快照无效，请重新连接。');}});stream.onerror=()=>{if(epoch!==identityEpoch||subscription!==streamEpoch)return;online=false;$('connection').textContent='实时连接中断 · 自动重连中';updateLaunch();};}
  function ingest(items){for(const incoming of items){const old=satellites.get(incoming.id),s=history.mergeSnapshot(old,incoming);if(!s)continue;const incomingTick=s.state?.tick??-1,oldTick=old?.state?.tick??-1;if(old&&(incomingTick<oldTick||(incomingTick===oldTick&&!['active','queued'].includes(old.status)&&['active','queued'].includes(s.status))))continue;if(s.status==='captured'&&old&&old.status==='active'&&!paused&&!historyMode&&!recovering)captureVisual(s);
      satellites.set(s.id,s);if(!paused)setLiveRecord(s);
      }while(displayStates.size>100){const oldest=Array.from(displayStates.keys()).find(id=>id!==selectedId);displayStates.delete(oldest);trails.delete(oldest);liveObservers.delete(oldest);}renderList();renderDetail();}
  async function loadList(more=false){const epoch=identityEpoch;message('正在读取卫星档案…');try{const data=await api('/api/satellites'+(more&&nextCursor?'?cursor='+encodeURIComponent(nextCursor):''));if(epoch!==identityEpoch)return;ingest(data.satellites||[]);nextCursor=data.nextCursor;$('loadMore').hidden=!nextCursor;serverStatus(data.server);message(satellites.size?'已载入 '+satellites.size+' 颗卫星。隐藏卫星不影响后台；全图冲击波会终止运行并保留历史轨迹。':'还没有卫星。填写参数，开启第一次发射。');}catch(e){if(epoch===identityEpoch)message(e.message);}}
  function renderList(){
    const container=$('satellites');
    for(const [id,node]of satelliteNodes){if(!satellites.has(id)){node.button.remove();satelliteNodes.delete(id);}}
    for(const s of satellites.values()){
      let node=satelliteNodes.get(s.id);
      if(!node){const button=document.createElement('button'),title=document.createElement('strong'),meta=document.createElement('span');button.type='button';button.append(title,meta);button.onclick=()=>selectSatellite(s.id);node={button,title,meta};satelliteNodes.set(s.id,node);container.append(button);}
      const className='satellite'+(s.id===selectedId?' selected':'');if(node.button.className!==className)node.button.className=className;
      if(node.title.textContent!==s.name)node.title.textContent=s.name;
      const state=observedPosition(s.id)||s.state,shown=displayStates.get(s.id)||s;
      const text=`${statusText[shown.status]||shown.status} · ${(state?.elapsedSeconds||0).toFixed(2)} 模拟秒 · ${['active','queued'].includes(shown.status)?'当前':'末态'}速度 ${units.formatSpeed(state,s.calibration||scale)}${recovering?' · 预演':''}`;if(node.meta.textContent!==text)node.meta.textContent=text;
    }
  }
  function renderDetail(){const s=satellites.get(selectedId);$('fitSelected').disabled=!s;$('trackSelected').disabled=!s;if(!s)return;$('detail').hidden=false;$('detailName').textContent=s.name;
    const state=observedPosition(selectedId)||s.state,t=units.telemetry(state,s.calibration||scale),shown=displayStates.get(selectedId)||s;
    $('detailMeta').textContent=`${s.id} · ${statusText[shown.status]||shown.status} · ${(state?.elapsedSeconds||0).toFixed(3)} 模拟秒 · 对应 ${t.physicalElapsedSeconds.toPrecision(4)} s 模型物理时间 · ${s.massKg} kg · ${s.initial.dynamicsVersion?'独立双体质量计算':'历史测试粒子模型'}${recovering?' · 补算期间的物理预演，正式记录以后台为准':''}`;
    $('detailSpeed').textContent=`初速度 ${units.toKmS(s.initial.speed,s.calibration||scale).toLocaleString('zh-CN',{maximumFractionDigits:2})} km/s · ${shown.status==='active'?'当前':'末态'}速度 ${units.formatSpeed(state,s.calibration||scale)}${t.physicalSpeedValid?` · vx ≈ ${t.vxKmS.toFixed(2)}，vy ≈ ${t.vyKmS.toFixed(2)} km/s · ${(t.fractionOfC*100).toFixed(2)}% c`:` · 模型给出 ${t.speedKmS.toFixed(2)} km/s，不能作为真实速度`}${s.calibrationInferred?' · 历史场景记录按示例质量换算':''}`;
    $('terminate').disabled=!['active','queued'].includes(s.status)||!online;}
  async function selectSatellite(id){clearHistory();selectedId=id;setTracking(true);selectionEpoch++;exportEpoch++;clearTimeout(exportTimer);historyPoints=[];historyMode=false;playing=false;impactWaves=[];replayCaptureShown=false;$('replay').hidden=true;$('downloadExport').hidden=true;$('historyMessage').textContent='';$('viewMode').textContent=paused?'观察已暂停 · 服务继续运行':'实时观察';hiddenLive=false;if(online&&sessionReady)openStream();renderList();renderDetail();const epoch=selectionEpoch;try{const data=await api('/api/satellites/'+encodeURIComponent(id));if(epoch===selectionEpoch)ingest([data.satellite]);}catch(e){if(epoch===selectionEpoch)message(e.message);}}
  $('launchForm').onsubmit=async e=>{e.preventDefault();if(launchBusy||!draft||!online||!sessionReady)return;const epoch=identityEpoch;launchBusy=true;if(!pendingLaunch)pendingLaunch={...readInput(),idempotencyKey:crypto.randomUUID()};updateLaunch();$('launchMessage').textContent='正在提交并保存出生档案…';try{const data=await api('/api/satellites',{method:'POST',body:JSON.stringify(pendingLaunch)});if(epoch!==identityEpoch)return;pendingLaunch=null;draftVisible=false;preview=[];previewToken++;ingest([data.satellite]);selectSatellite(data.satellite.id);$('launchMessage').textContent='发射已确认 · '+data.satellite.id;hiddenLive=false;}catch(error){if(epoch!==identityEpoch)return;if(error.status&&error.status<500&&error.status!==408&&error.status!==429)pendingLaunch=null;$('launchMessage').textContent=error.message+(pendingLaunch?' · 结果尚未确认，再次点击将安全重试同一发射。':'');}finally{launchBusy=false;updateLaunch();}};
  $('reconnect').onclick=connect;$('refresh').onclick=()=>loadList(false);$('loadMore').onclick=()=>loadList(true);
  $('pause').onclick=()=>{paused=!paused;$('pause').textContent=paused?'继续观察':'暂停观察';$('viewMode').textContent=paused?'观察已暂停 · 服务继续运行':'实时观察';if(!paused){for(const s of satellites.values()){const shown=displayStates.get(s.id);if(s.status==='captured'&&shown?.status==='active')captureVisual(s);}resetLiveDrawing();}};$('clear').onclick=()=>{clearHistory();$('replay').hidden=true;hiddenLive=true;historyMode=false;playing=false;$('viewMode').textContent='卫星已隐藏';message('已隐藏观察对象；没有停止计算或删除档案。');};$('showAll').onclick=()=>{clearHistory();$('replay').hidden=true;hiddenLive=false;historyMode=false;playing=false;$('viewMode').textContent=paused?'观察已暂停':'实时观察';};
  $('recover').onclick=async()=>{const key=$('recoverInput').value.trim();if(!key||identityBusy)return;identityLock(true);try{const data=await api('/api/session/recover',{method:'POST',body:JSON.stringify({recoveryKey:key})});resetIdentity();currentUserId=data.user.id;csrf=data.csrfToken;sessionReady=true;online=true;revealKey(data.recoveryKey);$('recoverInput').value='';$('identityLabel').textContent='档案 '+data.user.id;await loadList();openStream();message('档案已恢复，无需更换原密钥。');}catch(e){message(e.message);}finally{identityLock(false);updateLaunch();}};
  $('rotateKey').onclick=async()=>{if(identityBusy)return;if(!sessionReady){message('请先重新连接，或恢复已有档案。');return;}if(!confirm('生成新的恢复密钥后，旧密钥将立即失效。继续？'))return;identityLock(true);try{const data=await api('/api/session/recovery-key',{method:'POST',body:'{}'});revealKey(data.recoveryKey);message('恢复密钥已轮换。请立即保存新密钥。');}catch(e){message(e.message);}finally{identityLock(false);}};
  $('logout').onclick=async()=>{if(identityBusy)return;identityLock(true);try{await api('/api/session',{method:'DELETE'});resetIdentity();online=false;$('identityLabel').textContent='已退出档案';$('connection').textContent='已退出';message('已退出，服务器继续计算。点击重新连接可建立新访客档案，或恢复已有档案。');updateLaunch();}catch(e){message(e.message);}finally{identityLock(false);}};
  $('terminate').onclick=async()=>{const id=selectedId,epoch=selectionEpoch;if(!id)return;if(!confirm('终止这颗卫星的追踪？此操作不可恢复，已有轨迹仍会保留。'))return;$('terminate').disabled=true;try{const data=await api('/api/satellites/'+encodeURIComponent(id)+'/terminate',{method:'POST'});if(epoch===selectionEpoch){ingest([data.satellite]);message('追踪已终止，历史轨迹仍可回放和导出。');}}catch(e){if(epoch===selectionEpoch){message(e.message);renderDetail();}}};
  $('history').onclick=async()=>{
    const s=satellites.get(selectedId);if(!s)return;
    if(!Number.isFinite(s.state?.tick)){$('historyMessage').textContent='卫星尚未出生，请等待正式状态。';return;}
    clearHistory();selectionEpoch++;historySnapshot={...s.state};historyMode=true;hiddenLive=false;playing=false;impactWaves=[];replayCaptureShown=false;
    const life=history.lifecycle(historySnapshot,model.MODEL.tickRate);$('timeline').min=0;$('timeline').max=life.endSeconds;$('timeline').value=0;$('replay').hidden=false;$('viewMode').textContent='历史回放';
    await requestHistory(0);
  };
  function updateReplayLabel(){const point=replayPoint(replayElapsed);$('replayTime').textContent=replayElapsed.toFixed(2)+' 模拟秒'+(point?' · '+units.formatSpeed(point,satellites.get(selectedId)?.calibration||scale):'');}
  $('timeline').oninput=()=>{requestHistory(number('timeline'),playing||historyResume);};
  $('play').onclick=()=>{
    if(historyLoading){historyResume=!historyResume;$('play').textContent=historyResume?'暂停':'播放';return;}
    if(playing){playing=false;$('play').textContent='播放';return;}
    const target=replayElapsed>=Number($('timeline').max)?0:replayElapsed;
    requestHistory(target,true);
  };
  $('live').onclick=()=>{clearHistory();selectionEpoch++;historyMode=false;playing=false;hiddenLive=false;$('replay').hidden=true;$('viewMode').textContent=paused?'观察已暂停':'实时观察';};
  document.querySelectorAll('[data-export]').forEach(button=>button.onclick=async()=>{const id=selectedId,epoch=++exportEpoch;if(!id)return;$('downloadExport').hidden=true;$('historyMessage').textContent='正在创建导出任务…';try{const data=await api('/api/satellites/'+encodeURIComponent(id)+'/exports',{method:'POST',body:JSON.stringify({format:button.dataset.export})});if(epoch!==exportEpoch)return;pollExport(data.export,epoch);}catch(e){if(epoch===exportEpoch)$('historyMessage').textContent=e.message;}});
  async function pollExport(job,epoch){if(epoch!==exportEpoch)return;if(job.status==='ready'||job.status==='completed'){const link=$('downloadExport');link.href=job.downloadUrl||'/api/exports/'+encodeURIComponent(job.id)+'/download';link.textContent='下载 '+(job.format||'')+' 文件';link.hidden=false;$('historyMessage').textContent='完整记录导出已就绪 · 截止 tick '+job.cutoffTick;return;}if(job.status==='error'||job.status==='failed'){$('historyMessage').textContent='导出失败：'+(job.message||job.error||job.errorMessage||'请重试');return;}$('historyMessage').textContent='服务器正在生成完整记录导出…';exportTimer=setTimeout(async()=>{try{const data=await api('/api/exports/'+encodeURIComponent(job.id));pollExport(data.export,epoch);}catch(e){if(epoch===exportEpoch)$('historyMessage').textContent=e.message;}},1500);}
  $('physicalScale').textContent=`黑洞质量：10 M☉ · 视界半径 r_s = ${units.formatKm(scale.schwarzschildRadiusKm)}。1 现实秒推进约 ${scale.secondsPerUnit.toPrecision(5)} s 模型物理时间，相当于慢放约 ${(1/scale.secondsPerUnit).toFixed(0)} 倍。`;
  $('launchLimits').textContent=`当前模拟允许出生半径 ${units.formatKm(units.toKm(80))}–${units.formatKm(units.toKm(model.MODEL.limits.maxRadius))}；初速度小于 299792.458 km/s`;
  setZoom(zoom);validate();connect();
})();





