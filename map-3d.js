'use strict';

(async () => {
  const $ = id => document.getElementById(id);
  const canvas = $('scene'), ctx = canvas.getContext('2d');
  const worldId = new URLSearchParams(location.search).get('worldId');
  const units=OrbitalUnits,camera=OrbitalCamera;
  const worldQuery=worldId?'worldId='+encodeURIComponent(worldId):'';
  if(worldId){
    $('back-to-2d').href='mission.html?'+worldQuery;
    $('seed-3d').href='seed-preview.html?dimension=3&'+worldQuery;
    $('classic-3d').hidden=false;
  }
  let config, csrfToken='', stream, worker, previewTimer, previewToken=0, pendingLaunch;
  let connecting=false, sending=false, pageActive=true, online=false, userId='', identityBusy=false;
  async function api(path,body,{method=body===undefined?'GET':'POST',signal}={}){
    const response=await fetch(path,{
      method,signal,
      headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),
        ...(method==='GET'?{}:{'X-CSRF-Token':csrfToken})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})
    });
    const data=await response.json();
    if(!response.ok)throw Object.assign(new Error(data.error?.message||'计算服务暂不可用'),{status:response.status});
    return data;
  }
  try{config=await api('/api/model'+(worldId?'?'+worldQuery:''));}
  catch{
    $('map-context').textContent='星图加载失败';
    $('launch-status').textContent='请确认计算服务已启动，再重新连接。';
    $('reconnect-3d').hidden=false;
    $('reconnect-3d').onclick=()=>location.reload();
    return;
  }
  if (!ctx) {
    $('map-context').textContent = '当前浏览器无法绘制星图。';
    return;
  }

  const model=config.world?OrbitalModel.createRuntime(config.world):OrbitalModel;
  const classicHole={id:'black-hole',kind:'blackHole',x:0,y:0,rs:model.MODEL.rs};
  const world=config.world??{seed:'经典地图',radius:model.MODEL.observation.radius,systems:[{
    id:'classic',x:0,y:0,extent:9500,bodies:[classicHole]
  }]};
  const selector = $('system-select'), flightSelect=$('satellite-select'), form=$('launch-form');
  const spaceQuery=new URLSearchParams(worldQuery);
  spaceQuery.set('dimension','3');
  const satellites=new Map();
  const removedFlights=new Set();
  const visuals=OrbitalVisuals.create();
  const starDisplayScale=1.5,starMarkerRadius=.85;
  const stellarCanvas=document.createElement('canvas'),stellarRenderer=OrbitalStellar.createRenderer(stellarCanvas);
  const historyCanvas=document.createElement('canvas');
  const historyStore=OrbitalHistoryGL.createStore({spatial:true});
  let historyRenderer;
  const exactHistory={
    start(){
      historyRenderer??=OrbitalHistoryGL.createRenderer(historyCanvas,{spatial:true});
      return historyRenderer.available;
    },
    append:points=>historyRenderer.append(historyStore.append(points)),
    clear(){historyStore.clear();historyRenderer?.clear();}
  };
  const planetRadii=new Map();
  for(const system of config.world?.systems??[]){
    const stars=system.bodies.filter(body=>body.kind==='star');
    const smallest=Math.min(...stars.map(body=>OrbitalVisuals.stellarAppearance(1,body).radius));
    for(const body of system.bodies){
      if(body.kind==='planet')planetRadii.set(body.id,OrbitalVisuals.planetDisplayRadius(body.radius,smallest));
      if(body.kind==='moon')planetRadii.set(body.id,planetRadii.get(body.orbit.parentId)*.28);
    }
  }
  const systemBodies=new Map(world.systems.map(system=>[system.id,new Set(system.bodies.map(body=>body.id))]));
  let selectedFlight='', predicted=[], tracking=false, cameraTarget=null, lastLaunchedId='';
  let hiddenFlights=false, focusedBody='', mapTool='pan', launchDraft=null, launchPosition=null;
  let launchVisible=true, lastTelemetry=0;
  const impacts=[];
  const liveTrail=[];
  let trailTick=-1;
  const systemLabels = new Map(world.systems.map((system, index) => [
    system.id, config.world?`S0${index + 1} · ${system.binary ? '双星' : '黑洞伴星'}`:'经典星系'
  ]));
  selector.add(new Option('全图', 'map'));
  for (const [id, label] of systemLabels) selector.add(new Option(label, id));
  const launchSystem = world.systems.find(system => !system.binary) ?? world.systems[0];
  const overviewLabel = `星系全图 · ${world.systems.length} 个星系`;
  let selected = config.world ? undefined : launchSystem;
  selector.value = selected?.id ?? 'map';
  selector.disabled = false;
  const totals = {blackHole:0,star:0,planet:0,moon:0};
  for (const system of world.systems) for (const body of system.bodies) totals[body.kind]++;
  $('map-context').textContent = config.world
    ? `当前种子 ${world.seed} · ${world.systems.length} 个星系 · ${totals.blackHole} 个黑洞 · ${totals.star} 颗恒星 · ${totals.planet} 颗行星${totals.moon?' · '+totals.moon+' 颗天然卫星':''}`
    : '经典地图 · 三维飞行';

  const TAU = 2 * Math.PI, radians = Math.PI / 180;
  const background = Array.from({length:160}, (_, index) => ({
    x: ((index * 337 + 29) % 997) / 997, y: ((index * 153 + 97) % 991) / 991,
    size: index % 9 === 0 ? 1.5 : 1, alpha: index % 7 === 0 ? .6 : .22
  }));
  const defaultPitch=41,defaultYaw=-.38;
  let width=0,height=0,yaw=defaultYaw,pitch=defaultPitch,zoom=1,minZoom=1;
  let cameraOffset={x:0,y:0},visualTime=0;
  const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
  let playing = true, frame = null, lastFrame = null, drag = null;
  let serverTick=config.server?.tick??0, tickSeen=performance.now(), frozenTick=serverTick;
  let frozenFlights=new Map();
  const currentTick=()=>serverTick+Math.max(0,performance.now()-tickSeen)/1000*model.MODEL.tickRate;
  const activeScope=()=>selected??{x:0,y:0,extent:world.radius};
  const observed=id=>playing?satellites.get(id)?.observer.state:frozenFlights.get(id);
  const flightState=()=>controls.replay?controls.replay.point:observed(selectedFlight);
  const fieldTick=()=>controls.replay
    ? controls.replay.birthTick+controls.replay.time*model.MODEL.tickRate
    : playing?currentTick():frozenTick;
  const bodiesAt=tick=>config.world?model.stellarBodiesAtTick(tick,true):[classicHole,...model.stellarBodiesAtTick(tick,true)];
  const labels={star:'恒星',planet:'行星',moon:'天然卫星',blackHole:'黑洞','black-hole':'黑洞'};
  const bodyCount={};
  const blackHoleLabels=new Map();
  for(const body of bodiesAt(0)){
    const kind=body.kind??'star';
    bodyCount[kind]=(bodyCount[kind]??0)+1;
    const profile=OrbitalWorldGenerator.BODY_PROFILES[body.bodyClass];
    const label=labels[kind]+' '+bodyCount[kind]+(profile&&profile.label!==labels[kind]?' · '+profile.label:'');
    $('body-focus').add(new Option(label,body.id));
    if(kind==='blackHole')blackHoleLabels.set(body.id,label);
  }
  function getSweepSource(){
    const holes=bodiesAt(currentTick()).filter(body=>blackHoleLabels.has(body.id));
    const scope=activeScope();
    const distance=body=>Math.hypot(body.x-scope.x,body.y-scope.y,(body.z??0)-(scope.z??0));
    const hole=holes.find(body=>body.id===focusedBody)??holes.reduce(
      (nearest,body)=>!nearest||distance(body)<distance(nearest)?body:nearest,null);
    if(!hole)return null;
    return {origin:{x:hole.x,y:hole.y,z:hole.z??0},label:blackHoleLabels.get(hole.id)};
  }
  const {statuses}=OrbitalFlightControls3D;
  const controls=OrbitalFlightControls3D.create({
    api,spaceQuery,worldId,model,getFlight:()=>satellites.get(selectedFlight),getState:observed,
    getSweepSource,hasSweepSource:blackHoleLabels.size>0,
    frameSweep:origin=>{
      selector.value='map';
      selector.onchange();
      cameraTarget=origin;
      if(config.world)zoom=minZoom;
      updateCamera();
    },
    receive,remove:removeFlight,observeClock,draw,exactHistory,ensureVisible:()=>{hiddenFlights=false;},
    resumeLive:()=>setPlaying(true),wake:requestFrame,isLivePlaying:()=>playing,isHidden:()=>hiddenFlights,
    isOnline:()=>online&&!identityBusy,isSending:()=>sending,updateLaunch
  });

  function projection(atZoom=zoom) {
    const scope=activeScope(),{extent}=scope,center=cameraTarget??scope;
    const azimuthSin = Math.sin(yaw), azimuthCos = Math.cos(yaw);
    const elevationSin = Math.sin(pitch * radians), elevationCos = Math.cos(pitch * radians);
    const view=camera.view(width,height,atZoom,cameraOffset);
    const cameraSpace=point=>{
      const x=(point.x-center.x)/extent,y=(point.y-center.y)/extent;
      const z=((point.z??0)-(center.z??0))/extent;
      const horizontal = x * azimuthCos - y * azimuthSin;
      const forward = x * azimuthSin + y * azimuthCos;
      const depth = forward * elevationCos + z * elevationSin;
      return {horizontal,vertical:forward*elevationSin-z*elevationCos,distance:3.6-depth};
    };
    const toScreen=point=>{
      const {horizontal,vertical,distance}=cameraSpace(point);
      if(distance<.06)return null;
      const scale=view.scale*3.6/distance;
      return {x:view.cx+horizontal*extent*scale,
        y:view.cy+vertical*extent*scale,scale,depth:3.6-distance};
    };
    function onPlane(px,py,heightKm){
      const z=(units.fromKm(heightKm)-(center.z??0))/extent;
      const u=(px-view.cx)/(extent*view.scale*3.6),v=(py-view.cy)/(extent*view.scale*3.6);
      const denominator=v*elevationCos+elevationSin;
      if(Math.abs(denominator)<1e-7)return null;
      const distance=(3.6*elevationSin-z)/denominator;
      if(!Number.isFinite(distance)||distance<.06)return null;
      const horizontal=u*distance,forward=v*distance*elevationSin+(3.6-distance)*elevationCos;
      return {x:center.x+extent*(horizontal*azimuthCos+forward*azimuthSin),
        y:center.y+extent*(forward*azimuthCos-horizontal*azimuthSin)};
    }
    const sphere=(origin,radius)=>camera.sphereSilhouette(cameraSpace(origin),radius/extent,view,3.6*extent*view.scale);
    function atFocalDepth(px,py){
      const horizontal=(px-view.cx)/view.scale,vertical=(py-view.cy)/view.scale;
      const forward=vertical*elevationSin;
      return {x:center.x+horizontal*azimuthCos+forward*azimuthSin,
        y:center.y+forward*azimuthCos-horizontal*azimuthSin,z:(center.z??0)-vertical*elevationCos};
    }
    return {toScreen,onPlane,sphere,atFocalDepth,view:{...view,center,extent,
      azimuth:[azimuthSin,azimuthCos],elevation:[elevationSin,elevationCos]}};
  }

  function path(points, color, lineWidth = 1) {
    ctx.beginPath();
    let connected=false;
    for(const point of points){
      if(!point){connected=false;continue;}
      if(connected)ctx.lineTo(point.x,point.y);else ctx.moveTo(point.x,point.y);
      connected=true;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }

  function drawSatellite(point,flight,selectedName){
    if(!point)return;
    const mass=OrbitalVisuals.satelliteVisualMass(flight.massKg);
    const {radius}=OrbitalVisuals.satelliteAppearance(point.scale,mass);
    const reach=radius+(selectedName===undefined?0:170);
    if(point.x+reach<0||point.x-reach>width||point.y+radius<0||point.y-radius>height)return;
    visuals.satellite(ctx,point,point.scale,mass,selectedName);
  }

  function dot(point,radius,color){
    ctx.beginPath();
    ctx.arc(point.x,point.y,radius,0,TAU);
    ctx.fillStyle=color;
    ctx.fill();
  }

  function drawDraft(toScreen){
    const point=launchPosition&&toScreen(launchPosition);
    if(!point)return;
    const color=launchDraft?'#ffb37c':'#ff756b';
    const {x,y}=point;
    path([{x:x-10,y},{x:x+10,y}],color);
    path([{x,y:y-10},{x,y:y+10}],color);
    ctx.font='11px ui-monospace,monospace';
    ctx.fillStyle=color;
    ctx.fillText(launchDraft?'待发射':'无效发射位置',x+14,y-12);
    if(!launchDraft||launchDraft.speed<=0)return;
    const heading=launchDraft.directionDeg*radians, elevation=launchDraft.pitchDeg*radians;
    const next=toScreen({x:launchPosition.x+Math.cos(heading)*Math.cos(elevation),
      y:launchPosition.y+Math.sin(heading)*Math.cos(elevation),z:launchPosition.z+Math.sin(elevation)});
    if(!next)return;
    const length=Math.hypot(next.x-x,next.y-y);
    if(length<1e-7)return;
    const dx=(next.x-x)/length,dy=(next.y-y)/length,end={x:x+dx*48,y:y+dy*48};
    path([point,end],color);
    path([{x:end.x-dx*8-dy*4,y:end.y-dy*8+dx*4},end,
      {x:end.x-dx*8+dy*4,y:end.y-dy*8-dx*4}],color);
  }

  function drawWave(projectSphere){
    const wave=controls.wave;
    if(!wave||wave.cancelled||!wave.radius)return;
    const outline=projectSphere(wave.origin,wave.radius);
    if(!outline)return;
    ctx.save();
    ctx.fillStyle='#69f4d51c';
    if(outline.inside)ctx.fillRect(0,0,width,height);
    else{
      ctx.beginPath();
      ctx.ellipse(outline.x,outline.y,outline.along,outline.across,outline.angle,0,TAU);
      ctx.fill();
      ctx.lineWidth=2;
      ctx.strokeStyle='#80ffdebd';
      ctx.stroke();
    }
    ctx.restore();
  }

  function draw() {
    if (!width || !height) return;
    const scope=activeScope(),replay=controls.replay;
    const flight=satellites.get(selectedFlight);
    const shown=flightState(),tick=fieldTick(),field=bodiesAt(tick);
    const liveVisible=shown&&['active','escaped'].includes(shown.status);
    const followed=focusedBody?field.find(body=>body.id===focusedBody):tracking&&!hiddenFlights&&(replay||liveVisible)?shown:null;
    if(followed)cameraTarget={x:followed.x,y:followed.y,z:followed.z??0};
    const pivot=drag?.moved&&drag.pivot;
    if(pivot?.id){
      const body=field.find(item=>item.id===pivot.id);
      if(body){
        const center=cameraTarget??scope;
        cameraTarget={x:center.x+body.x-pivot.x,y:center.y+body.y-pivot.y,
          z:(center.z??0)+(body.z??0)-(pivot.z??0)};
        drag.pivot=body;
      }
    }
    let {toScreen,sphere,view:spatialView}=projection();
    if($('auto-fit').checked&&shown&&!hiddenFlights){
      const point=toScreen(shown);
      if(point){
        const view=camera.view(width,height,zoom,cameraOffset);
        const scale=Math.min(1,width*.40/Math.max(Math.abs(point.x-view.cx),1),
          height*.35/Math.max(Math.abs(point.y-view.cy),1));
        const nextZoom=Math.max(minZoom,zoom*scale);
        if(nextZoom<zoom){zoom=nextZoom;syncZoom();({toScreen,sphere,view:spatialView}=projection());}
        if(scale<1&&nextZoom===minZoom){cameraTarget=shown;({toScreen,sphere,view:spatialView}=projection());}
      }else{cameraTarget=shown;({toScreen,sphere,view:spatialView}=projection());}
    }
    const plane=(x,y)=>toScreen({x:scope.x+x*scope.extent,y:scope.y+y*scope.extent,z:scope.z??0});
    ctx.fillStyle = '#070c17';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#afc7e6';
    for (const star of background) {
      ctx.globalAlpha = star.alpha;
      ctx.fillRect(star.x * width, star.y * height, star.size, star.size);
    }
    ctx.globalAlpha = 1;
    for (let index = -5; index <= 5; index++) {
      const value = index / 5, color = index === 0 ? '#5373928c' : '#30496957';
      path([plane(value,-1),plane(value,1)],color);
      path([plane(-1,value),plane(1,value)],color);
    }

    const stars=[],markers=[];
    const positions=config.world
      ? selected?field.filter(body=>systemBodies.get(selected.id).has(body.id)):field
      : field;
    if (!selected) {
      for (const system of world.systems) {
        const point=toScreen(system);
        if(!point)continue;
        if(system.z){
          const foot=toScreen({...system,z:0});
          ctx.setLineDash([2,4]);
          path([foot,point],'#5373928c');
          ctx.setLineDash([]);
        }
        ctx.font = '12px system-ui';
        ctx.fillStyle = '#d4e4f6';
        ctx.fillText(systemLabels.get(system.id), point.x + 15, point.y - 7);
      }
    }
    for(const body of positions){
      const point=toScreen(body);
      if(!point)continue;
      if(body.kind==='blackHole'){
        const radius=body.rs*1.65*point.scale,reach=radius*4;
        if(point.x+reach<0||point.x-reach>width||point.y+reach<0||point.y-reach>height)continue;
        if(radius>=.65){
          const scale=point.scale*body.rs/171;
          // Project the center in 3D and use the shared 2D disk orientation on screen.
          const view=OrbitalVisuals.blackHoleAppearance({cx:point.x,cy:point.y,scale,size:1100*scale});
          visuals.blackhole(ctx,width,height,view,visualTime,body.color);
        }
        if(radius<3)markers.push({point,radius:2,color:body.color??'#a4dba6',opacity:1});
      }else{
        const appearance=planetRadii.has(body.id)?null:OrbitalVisuals.stellarAppearance(point.scale,body,starDisplayScale);
        const radius=appearance?.radius??planetRadii.get(body.id)*point.scale;
        if(appearance)stars.push({...point,radius,appearance,star:body});
        else if(radius>=.65)dot(point,radius,body.color);
        const markerRadius=body.kind==='moon'?.75:body.kind==='planet'?1.1:starMarkerRadius;
        const visibility=body.kind==='moon'?Math.min(1,(point.scale/.12)**2):1;
        if(radius<markerRadius)markers.push({point,radius:markerRadius,color:body.color,opacity:visibility*(1-(radius/markerRadius)**2)});
      }
    }
    stars.sort((a,b)=>a.depth-b.depth);
    const surfaceTime=reducedMotion.matches?0:visualTime;
    if(stars.length&&stellarRenderer.render({bodies:stars,width,height,dpr:Math.min(devicePixelRatio||1,2),time:12+surfaceTime/.3})){
      ctx.drawImage(stellarCanvas,0,0,stellarCanvas.width,stellarCanvas.height,0,0,width,height);
    }else for(const star of stars)visuals.star(ctx,star,star.appearance,star.star,surfaceTime);
    for(const marker of markers){ctx.globalAlpha=marker.opacity;dot(marker.point,marker.radius,marker.color);}
    ctx.globalAlpha=1;
    if(!replay&&launchVisible){
      ctx.fillStyle='#ffbe85b3';
      for(let index=0;index<predicted.length;index+=4){
        const point=toScreen(predicted[index]);
        if(point)ctx.fillRect(point.x-1,point.y-1,2,2);
      }
      drawDraft(toScreen);
    }
    if(replay){
      const exact=historyStore.pointCount>0&&historyRenderer.render({view:spatialView,width,height,
        dpr:Math.min(devicePixelRatio||1,2),segments:historyStore.visibleRanges(replay.time)});
      if(exact)ctx.drawImage(historyCanvas,0,0,historyCanvas.width,historyCanvas.height,0,0,width,height);
      else{
        ctx.fillStyle='#80eadd9c';
        for(const sample of replay.overview){
          if(sample.elapsedSeconds>replay.time)break;
          const point=toScreen(sample);
          if(point&&point.x>=0&&point.x<=width&&point.y>=0&&point.y<=height)ctx.fillRect(point.x,point.y,1.5,1.5);
        }
      }
    }else if(!hiddenFlights){
      if(liveVisible){
        OrbitalVisuals.renderTrailPoints(ctx,liveTrail,sample=>{
          const point=toScreen(sample);
          return point&&point.x>=0&&point.x<=width&&point.y>=0&&point.y<=height?point:null;
        },OrbitalVisuals.satelliteVisualMass(flight.massKg));
      }
      for(const [id,record] of satellites){
        if(id===selectedFlight)continue;
        const state=observed(id);
        if(!state||!['active','escaped'].includes(state.status))continue;
        drawSatellite(toScreen(state),record);
      }
      for(const impact of impacts){
        const point=toScreen(impact.origin);
        if(point)visuals.impact(ctx,{cx:point.x,cy:point.y,scale:point.scale*impact.radius/171},
          visualTime-impact.born,impact.mass,impact.angle);
      }
    }
    drawWave(sphere);
    if(flight&&shown&&!hiddenFlights&&(replay||liveVisible)){
      drawSatellite(toScreen(shown),flight,replay?'回放 / '+flight.name:flight.name);
    }
    const overlay=$('stage-flight');
    overlay.hidden=!flight||hiddenFlights;
    const label=replay?'回放 · '+(flight?.name??'')+' · '+replay.time.toFixed(2)+' 模拟秒'
      :flight?[flight.id===lastLaunchedId?'已发射 '+flight.name:flight.name,statuses[shown?.status??flight.status],
        shown&&units.formatSpeed(shown,flight.calibration),shown&&'Z '+units.formatKm(units.toKm(shown.z))]
        .filter(Boolean).join(' · '):'';
    if((!playing||performance.now()-lastTelemetry>=100)&&overlay.textContent!==label)overlay.textContent=label;
  }

  function resize() {
    const firstLayout=!width||!height;
    ({width,height} = canvas.getBoundingClientRect());
    const scale = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    ctx.setTransform(scale,0,0,scale,0,0);
    if(!width||!height)return;
    const base=camera.view(width,height,1).scale;
    const overviewMinimum=Math.min(width*.36,height*.33)/(world.radius*base*(3.6/2.6));
    minZoom=Math.min(camera.MAX_ZOOM,config.world?overviewMinimum:camera.minimumZoom(width,height,world.radius));
    if(firstLayout)zoom=fitZoom();
    updateCamera();
  }
  function stopFrame() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    lastFrame=null;
  }
  function animate(now) {
    frame=null;
    if(lastFrame!==null){
      const seconds=(now-lastFrame)/1000,dt=Math.min(seconds,.1);
      if(playing){
        for(const flight of satellites.values())flight.observer.advance(seconds,{collect:false});
        const observedFlight=observed(selectedFlight);
        if(observedFlight?.status==='active'&&observedFlight.tick-trailTick>=12){
          trailTick=observedFlight.tick;
          liveTrail.push({x:observedFlight.x,y:observedFlight.y,z:observedFlight.z});
          if(liveTrail.length>180)liveTrail.shift();
        }
        visualTime+=dt*.3;
        while(impacts.length&&visualTime-impacts[0].born>=2.4)impacts.shift();
      }
      controls.advance(dt);
    }
    lastFrame=now;
    draw();
    if(now-lastTelemetry>=100){controls.render();lastTelemetry=now;}
    requestFrame();
  }
  function requestFrame(){
    if(frame!==null||!pageActive||document.hidden)return;
    if(playing||controls.replay?.playing||controls.sweeping)frame=requestAnimationFrame(animate);
    else lastFrame=null;
  }
  function updatePlayback() {
    stopFrame();
    $('play').textContent = playing ? '暂停画面' : '继续画面';
    requestFrame();
  }
  function syncZoom(){
    $('zoom').value = camera.zoomToSlider(zoom,minZoom);
    $('zoom-value').textContent = Number((zoom*100).toPrecision(3))+'%';
    const scale=camera.view(width,height,zoom).scale;
    if(scale>0)$('map-scale').textContent=units.formatKm(units.toKm(90/scale))+' / 90 px（视图中心）';
  }
  function updateCamera() {
    if(pitch<-180||pitch>180)pitch=((pitch+180)%360+360)%360-180;
    zoom = Math.max(minZoom,Math.min(camera.MAX_ZOOM,zoom));
    $('pitch').value = Math.round(pitch);
    $('pitch-value').textContent = Math.round(pitch) + '°';
    syncZoom();
    draw();
  }
  function fitZoom(){
    if(selected)return config.world?camera.minimumZoom(width,height,selected.extent)*.68:1.2;
    if(!config.world||!width||!height)return minZoom;
    const {sphere,view}=projection(1);
    return Math.min(...world.systems.map(system=>{
      const outline=sphere(system,system.extent);
      const cos=Math.cos(outline.angle),sin=Math.sin(outline.angle);
      const horizontal=Math.abs(outline.x-view.cx)+Math.hypot(outline.along*cos,outline.across*sin);
      const vertical=Math.abs(outline.y-view.cy)+Math.hypot(outline.along*sin,outline.across*cos);
      return Math.min(width*.36/horizontal,height*.33/vertical);
    }));
  }
  function setZoom(value,anchor){
    const nextZoom=Math.max(minZoom,Math.min(camera.MAX_ZOOM,value));
    // Tracking already projects the target at the view origin, so keep that origin fixed.
    if(anchor&&!tracking&&!focusedBody&&width&&height){
      const view=camera.view(width,height,zoom,cameraOffset);
      const changed=camera.zoomAt(view,view.scale*nextZoom/zoom,anchor);
      const base=camera.view(width,height,nextZoom);
      cameraOffset={x:changed.cx-base.cx,y:changed.cy-base.cy};
    }
    zoom=nextZoom;
    updateCamera();
  }
  selector.onchange = () => {
    selected = world.systems.find(system => system.id === selector.value);
    $('stage-label').textContent = selected ? systemLabels.get(selected.id) : overviewLabel;
    setTracking(false);
    clearBodyFocus();
    $('auto-fit').checked=false;
    cameraTarget=null;
    cameraOffset={x:0,y:0};zoom=fitZoom();
    updateCamera();
  };
  $('stage-label').textContent = selected ? systemLabels.get(selected.id) : overviewLabel;
  function setPlaying(value){
    if(value===playing)return;
    if(!value){
      frozenTick=currentTick();
      frozenFlights=new Map([...satellites].map(([id,flight])=>[id,{...flight.observer.state}]));
    }else{
      for(const flight of satellites.values())flight.observer.accept({...flight.state,status:flight.status});
    }
    playing=value;updatePlayback();controls.render();draw();
  }
  $('play').onclick = () => setPlaying(!playing);
  $('reset').onclick = () => {
    if(config.world)selector.value='map';
    yaw=defaultYaw;pitch=defaultPitch;selector.onchange();
  };
  $('pitch').oninput = event => {pitch = Number(event.target.value); updateCamera();};
  $('zoom').oninput = event => {$('auto-fit').checked=false;setZoom(camera.zoomFromSlider(Number(event.target.value),minZoom));};
  function setMapTool(tool){
    mapTool=tool;
    for(const button of document.querySelectorAll('[data-map-tool]'))button.setAttribute('aria-pressed',String(button.dataset.mapTool===tool));
    canvas.dataset.tool=tool;
    const touchOnly=matchMedia('(hover: none)').matches;
    $('map-hint').textContent=tool==='pick'?'点选当前 Z 平面上的发射点'
      :tool==='rotate'?'拖动旋转 · 点「平移」返回默认操作'
      :touchOnly?'拖动平移 · 点「旋转」切换视角':'左键平移 · 右键旋转 · 滚轮缩放';
  }
  for(const button of document.querySelectorAll('[data-map-tool]'))button.onclick=()=>setMapTool(button.dataset.mapTool);
  setMapTool(mapTool);
  function screenPoint(event){
    const bounds=canvas.getBoundingClientRect();
    return {x:event.clientX-bounds.left,y:event.clientY-bounds.top};
  }
  function rotationPivot(pointer){
    if(focusedBody||tracking)return null;
    const {toScreen,atFocalDepth}=projection();
    const screenCenter={x:width/2,y:height/2};
    let underPointer,nearCenter;
    let pointerDistance=Infinity,centerDistance=Infinity;
    const centerSearchRadius=Math.min(width,height)*.24;
    for(const body of bodiesAt(fieldTick())){
      if(config.world&&selected&&!systemBodies.get(selected.id).has(body.id))continue;
      const point=toScreen(body);
      if(!point)continue;
      // The disk extends past the shadow and can still fill the view with its center offscreen.
      const visualRadius=body.rs?body.rs*1.65*point.scale*3:planetRadii.has(body.id)
        ? planetRadii.get(body.id)*point.scale:OrbitalVisuals.stellarAppearance(point.scale,body,starDisplayScale).radius;
      const reach=body.rs?visualRadius:0;
      if(point.x+reach<0||point.x-reach>width||point.y+reach<0||point.y-reach>height)continue;
      const gap=Math.hypot(point.x-pointer.x,point.y-pointer.y);
      if(gap<Math.max(12,visualRadius)&&gap<pointerDistance){underPointer=body;pointerDistance=gap;}
      const fromCenter=Math.hypot(point.x-screenCenter.x,point.y-screenCenter.y);
      if(fromCenter<Math.max(centerSearchRadius,visualRadius)&&fromCenter<centerDistance){
        nearCenter=body;centerDistance=fromCenter;
      }
    }
    return underPointer??nearCenter??atFocalDepth(screenCenter.x,screenCenter.y);
  }
  canvas.addEventListener('pointerdown', event => {
    if(drag||![0,1,2].includes(event.button))return;
    const primary=event.button===0&&!event.shiftKey;
    drag = {id:event.pointerId,x:event.clientX,y:event.clientY,
      primary,pan:event.button!==2&&(!primary||mapTool==='pan'),pick:primary&&mapTool==='pick',moved:false};
    if(!drag.pan&&!drag.pick)drag.pivot=rotationPivot(screenPoint(event));
    if(event.button!==0)event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
    if(Math.abs(dx)+Math.abs(dy)>0)drag.moved=true;
    if(drag.pick)return;
    if(drag.pan){setTracking(false);clearBodyFocus();$('auto-fit').checked=false;cameraOffset.x+=dx;cameraOffset.y+=dy;}
    else if(dx||dy){
      const nextYaw=yaw+dx*.009,nextPitch=pitch+dy*.28;
      $('auto-fit').checked=false;
      if(drag.pivot){
        cameraTarget=camera.orbitTarget(cameraTarget??activeScope(),drag.pivot,
          {yaw,pitch:pitch*radians},{yaw:nextYaw,pitch:nextPitch*radians});
      }
      yaw=nextYaw;
      pitch=nextPitch;
    }
    drag.x = event.clientX;
    drag.y = event.clientY;
    updateCamera();
  });
  canvas.addEventListener('pointerup',event=>{
    if(drag?.id!==event.pointerId||!drag.primary||drag.moved)return;
    const {x,y}=screenPoint(event),{toScreen,onPlane}=projection();
    if(drag.pick){
      const height=form.elements.z.valueAsNumber;
      const point=Number.isFinite(height)&&onPlane(x,y,height);
      if(!point){$('launch-status').textContent='该位置无法投影到当前 Z 平面。请填写 Z 或调整相机俯角。';return;}
      form.elements.x.value=units.toKm(point.x).toFixed(6);
      form.elements.y.value=units.toKm(point.y).toFixed(6);
      schedulePreview();
      return;
    }
    if(hiddenFlights||controls.replay)return;
    let closest='',distance=14;
    for(const [id,flight] of satellites){
      const state=observed(id);
      if(!state||!['active','escaped'].includes(state.status))continue;
      const point=toScreen(state);
      if(!point)continue;
      const appearance=OrbitalVisuals.satelliteAppearance(point.scale,OrbitalVisuals.satelliteVisualMass(flight.massKg));
      if(appearance.opacity<.05)continue;
      const gap=Math.hypot(point.x-x,point.y-y);
      if(gap<Math.min(distance,Math.max(6,appearance.radius*.3))){distance=gap;closest=id;}
    }
    if(closest)focusFlight(closest);
  });
  canvas.addEventListener('lostpointercapture', () => {drag = null;});
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    $('auto-fit').checked=false;
    setZoom(camera.wheelZoom(zoom,event.deltaY,event.deltaMode,height),screenPoint(event));
  }, {passive:false});
  canvas.addEventListener('keydown', event => {
    switch (event.key) {
      case 'ArrowLeft': yaw -= .15; break;
      case 'ArrowRight': yaw += .15; break;
      case 'ArrowUp': pitch += 6; break;
      case 'ArrowDown': pitch -= 6; break;
      case '+': case '=': $('auto-fit').checked=false;zoom *= 1.1; break;
      case '-': $('auto-fit').checked=false;zoom /= 1.1; break;
      default: return;
    }
    event.preventDefault();
    updateCamera();
  });

  function receive(records){
    for(const incoming of records){
      if(removedFlights.has(incoming.id))continue;
      const old=satellites.get(incoming.id),record=OrbitalHistory.mergeSnapshot(old,incoming);
      if(!record?.state||old&&record.state.tick<old.state.tick)continue;
      if(old&&old.state.tick===record.state.tick&&!['active','queued'].includes(old.status)&&['active','queued'].includes(record.status))continue;
      if(!old)flightSelect.add(new Option(record.name,record.id));
      const observer=old?.observer??OrbitalHistory.createLiveObserver(model);
      if(record.status==='captured'&&old?.status==='active'&&playing&&!reducedMotion.matches){
        const state=record.state,event=state.event;
        const origin={x:event?.bodyX??0,y:event?.bodyY??0,z:event?.bodyZ??0};
        const body=bodiesAt(state.fieldTick).find(body=>body.id===event?.bodyId);
        impacts.push({born:visualTime,origin,radius:body?.rs||body?.radius||model.MODEL.rs,
          mass:Math.max(.4,Math.min(3,Math.cbrt(record.massKg/1000))),
          angle:Math.atan2(state.y-origin.y,state.x-origin.x)});
        if(impacts.length>12)impacts.shift();
      }
      if(playing||!old)observer.accept({...record.state,status:record.status});
      satellites.set(record.id,{...record,observer});
      if(!playing&&!frozenFlights.has(record.id))frozenFlights.set(record.id,{...record.state,status:record.status});
    }
    if(!playing){controls.render();draw();}
  }
  function removeFlight(id){
    removedFlights.add(id);
    satellites.delete(id);frozenFlights.delete(id);
    [...flightSelect.options].find(option=>option.value===id)?.remove();
    if(selectedFlight===id)focusFlight('');
  }
  function observeClock(server){
    if(!Number.isFinite(server?.tick)||server.tick<serverTick)return;
    serverTick=server.tick;
    tickSeen=performance.now();
  }
  function subscribe(){
    if(!pageActive)return;
    stream?.close();
    const query=new URLSearchParams(spaceQuery);
    if(selectedFlight)query.set('satelliteId',selectedFlight);
    const connection=new EventSource('/api/stream?'+query);
    stream=connection;
    connection.addEventListener('snapshot',event=>{
      if(!pageActive||stream!==connection)return;
      try{
        const snapshot=JSON.parse(event.data);
        const healthy=snapshot.server?.status!=='clock_error';
        if(healthy!==online){
          online=healthy;$('reconnect-3d').hidden=healthy;
          $('launch-status').textContent=healthy?'已连接，可发射':'计算服务暂停 · 请重新连接';
          updateLaunch();
        }
        observeClock(snapshot.server);
        receive(snapshot.satellites);
      }catch(error){$('records-status').textContent=error.message;}
    });
    connection.onerror=()=>{
      if(!pageActive||stream!==connection)return;
      online=false;
      $('launch-status').textContent='实时连接中断 · 正在重连';
      $('reconnect-3d').hidden=false;
      updateLaunch();
    };
  }
  function focusFlight(id){
    selectedFlight=id;
    flightSelect.value=id;
    const flight=satellites.get(id);
    liveTrail.length=0;trailTick=-12;
    lastTelemetry=0;
    hiddenFlights=false;
    controls.clearSelection();
    if(online||stream)subscribe();
    $('follow-flight').disabled=!flight;
    if(!flight){setTracking(false);cameraTarget=null;updateCamera();return;}
    locateFlight(observed(id)??flight.state,true);
    const identity=userId;
    api('/api/satellites/'+encodeURIComponent(id)).then(({satellite})=>{
      if(pageActive&&userId===identity&&selectedFlight===id)receive([satellite]);
    }).catch(error=>{
      if(pageActive&&userId===identity&&selectedFlight===id)$('records-status').textContent=error.message;
    });
  }
  function clearBodyFocus(){
    focusedBody='';
    $('body-focus').value='';
  }
  function setTracking(value){
    tracking=Boolean(value&&selectedFlight);
    if(tracking){clearBodyFocus();$('auto-fit').checked=false;}
    const button=$('follow-flight');
    button.setAttribute('aria-pressed',String(tracking));
    button.textContent=tracking?'停止跟踪':'跟踪所选卫星';
  }
  function locateFlight(state,follow=false){
    if(!state)return;
    const distance=system=>Math.hypot(state.x-system.x,state.y-system.y,(state.z??0)-(system.z??0));
    const nearby=world.systems.find(system=>distance(system)<=system.extent);
    selector.value=nearby?.id??'map';
    selector.onchange();
    const radius=nearby?Math.max(1400,2.2*distance(nearby)):world.radius/5;
    if(width&&height)zoom=Math.max(zoom,camera.minimumZoom(width,height,radius)*.75);
    cameraTarget=state;
    setTracking(follow);
    updateCamera();
  }
  $('follow-flight').onclick=()=>{
    if(tracking)setTracking(false);
    else if(flightState()){
      hiddenFlights=false;
      locateFlight(flightState(),true);canvas.scrollIntoView({block:'nearest'});
    }
  };
  $('locate-flight').onclick=()=>{
    hiddenFlights=false;locateFlight(flightState());canvas.scrollIntoView({block:'nearest'});
  };
  $('body-focus').onchange=event=>{
    const id=event.target.value,body=bodiesAt(fieldTick()).find(candidate=>candidate.id===id);
    if(!body){clearBodyFocus();return;}
    const system=world.systems.find(candidate=>systemBodies.get(candidate.id).has(id));
    selector.value=system?.id??(config.world?'map':'classic');
    selector.onchange();
    focusedBody=id;
    event.target.value=id;
    const radius=body.rs?body.rs*1.65:planetRadii.get(id)??OrbitalVisuals.stellarAppearance(1,body,starDisplayScale).radius;
    const base=camera.view(width,height,1).scale;
    const moonReach=Math.max(0,...(system?.bodies??[]).filter(item=>item.kind==='moon'&&item.orbit.parentId===id)
      .map(item=>item.orbit.radius+planetRadii.get(item.id)));
    if(radius>0&&base>0){
      zoom=moonReach?Math.min(width,height)*.32/(moonReach*base):Math.min(125,width*.14,height*.18)/(radius*base);
    }
    updateCamera();canvas.scrollIntoView({block:'nearest'});
  };
  $('auto-fit').onchange=()=>{
    if($('auto-fit').checked){setTracking(false);clearBodyFocus();cameraTarget=null;cameraOffset={x:0,y:0};}
    draw();
  };
  $('hide-flights').onclick=()=>{hiddenFlights=true;controls.leaveReplay();};
  $('show-flights').onclick=()=>{hiddenFlights=false;controls.leaveReplay();};
  $('locate-launch').onclick=()=>{
    if(!launchPosition)return;
    launchVisible=true;
    locateFlight(launchPosition);canvas.scrollIntoView({block:'nearest'});
  };
  flightSelect.onchange=()=>focusFlight(flightSelect.value);
  function launchInput(){
    const fields=new FormData(form);
    const number=key=>fields.get(key).trim()===''?NaN:Number(fields.get(key));
    return {name:fields.get('name'),dimension:3,position:{x:number('x'),y:number('y'),z:number('z')},
      massKg:number('mass'),speed:number('speed'),directionDeg:number('direction'),pitchDeg:number('pitch'),
      unitSystem:'si-km-v1',calibrationVersion:units.SCALE.version,modelVersion:model.MODEL.version,
      dynamicsVersion:model.MODEL.dynamics.version,...(worldId?{worldId}:{})};
  }
  function referenceFor(input){
    const {x,y,z}=input.position;
    const position={x:units.fromKm(x),y:units.fromKm(y),z:units.fromKm(z)};
    return {position,reference:model.orbitReference(position,input.massKg,currentTick())};
  }
  for(const button of form.querySelectorAll('[data-preset]')){
    button.onclick=()=>{
      const {position,reference}=referenceFor(launchInput());
      const preset=model.launchPreset(position,reference,button.dataset.preset);
      if(!preset)return;
      form.elements.speed.value=units.toKmS(preset.speed).toFixed(6);
      form.elements.direction.value=preset.directionDeg.toFixed(2);
      form.elements.pitch.value=preset.pitchDeg.toFixed(2);
      schedulePreview();
    };
  }
  function schedulePreview(){
    clearTimeout(previewTimer);
    const token=++previewToken;
    predicted=[];
    const input=launchInput();
    const {position,reference}=referenceFor(input);
    launchVisible=true;
    launchPosition=Object.values(position).every(Number.isFinite)?position:null;
    launchDraft=null;
    let errorText='';
    try{launchDraft=model.validateLaunch(input);}
    catch(error){errorText=error.message;}
    $('validation-3d').textContent=errorText;
    $('locate-launch').disabled=!launchPosition;
    const name=reference?.kind==='blackHole'?reference.name:labels[reference?.kind]??reference?.name;
    const format=value=>units.toKmS(value).toLocaleString('zh-CN',{maximumFractionDigits:2});
    $('speed-reference').textContent=reference?`按${name}单体估算 · 圆轨道 ≈ ${format(reference.circular)} km/s · 逃逸 ≈ ${format(reference.escape)} km/s${reference.radius<3*reference.rs?' · 此半径无稳定圆轨道':''}${input.speed>.1*units.C_KM_S?' · 高速读数需相对论修正':''}`:'';
    updateLaunch();
    if(!playing)draw();
    if(!pageActive||!worker||!launchDraft||!$('predict-3d').checked)return;
    previewTimer=setTimeout(()=>worker.postMessage({token,input,worldId,world:config.world,fieldTick:currentTick()}),180);
  }
  function updateLaunch(){
    const busy=identityBusy||connecting||sending||controls.sweeping;
    $('launch-3d').disabled=!online||busy||(!launchDraft&&!pendingLaunch);
    $('reconnect-3d').disabled=busy;
    $('restore-3d').disabled=busy;
    $('rotate-key-3d').disabled=busy||!csrfToken;
    $('logout-3d').disabled=busy||!csrfToken;
    controls.render();
  }
  function revealKey(key){
    $('recovery-key-3d').textContent=key??'';
    $('recovery-3d').hidden=!key;
    $('recovery-3d').open=!!key;
  }
  function adoptSession(session){
    if(userId!==session.user.id){
      stream?.close();stream=null;
      pendingLaunch=null;selectedFlight='';lastLaunchedId='';
      liveTrail.length=0;trailTick=-12;
      satellites.clear();frozenFlights.clear();removedFlights.clear();impacts.length=0;
      flightSelect.options.length=1;
      hiddenFlights=false;setTracking(false);cameraTarget=null;
      revealKey();controls.reset();
    }
    csrfToken=session.csrfToken;
    userId=session.user.id;
    $('identity-3d').textContent='档案 '+userId;
    if(session.recoveryKey)revealKey(session.recoveryKey);
  }
  async function loadSessionFlights(){
    await controls.loadList(false,{quiet:true});
    if(!pageActive)return;
    online=true;subscribe();schedulePreview();
    $('reconnect-3d').hidden=true;
    $('launch-status').textContent='已连接，可发射';
  }
  async function connect(){
    if(connecting||identityBusy||!pageActive)return;
    connecting=true;online=false;updateLaunch();
    stream?.close();stream=null;
    try{
      const session=await api('/api/session/guest',{});
      if(!pageActive)return;
      adoptSession(session);
      await loadSessionFlights();
    }catch(error){
      $('launch-status').textContent=error.message;
      $('reconnect-3d').hidden=false;
    }finally{connecting=false;updateLaunch();}
  }
  $('reconnect-3d').onclick=connect;
  async function manageIdentity(action){
    if(identityBusy||connecting||sending||controls.sweeping)return;
    identityBusy=true;updateLaunch();
    const notice=$('identity-status');
    try{await action(notice);}
    catch(error){notice.textContent=error.message;}
    finally{identityBusy=false;updateLaunch();}
  }
  $('recover-form-3d').onsubmit=event=>{
    event.preventDefault();
    const input=$('recover-key-3d'),key=input.value.trim();
    if(!key)return;
    void manageIdentity(async notice=>{
      if(!csrfToken)adoptSession(await api('/api/session/guest',{}));
      let session;
      try{session=await api('/api/session/recover',{recoveryKey:key});}
      catch(error){
        if(error.status!==401||online)throw error;
        adoptSession(await api('/api/session/guest',{}));
        session=await api('/api/session/recover',{recoveryKey:key});
      }
      if(!pageActive)return;
      adoptSession(session);input.value='';
      await loadSessionFlights();
      notice.textContent='档案已恢复，可以继续查看原有卫星。';
    });
  };
  $('rotate-key-3d').onclick=()=>{
    if(!confirm('生成新的恢复密钥后，旧密钥将立即失效。继续？'))return;
    void manageIdentity(async notice=>{
      const {recoveryKey}=await api('/api/session/recovery-key',{});
      revealKey(recoveryKey);notice.textContent='密钥已轮换，请保存新密钥。';
    });
  };
  $('logout-3d').onclick=()=>void manageIdentity(async notice=>{
    await api('/api/session',undefined,{method:'DELETE'});
    online=false;
    adoptSession({user:{id:''},csrfToken:''});
    $('identity-3d').textContent='已退出档案';
    $('launch-status').textContent='已退出 · 可重新连接或恢复档案';
    $('reconnect-3d').hidden=false;
    notice.textContent='已退出，服务继续计算已发射的卫星。';
  });
  $('copy-key-3d').onclick=async()=>{
    try{
      await navigator.clipboard.writeText($('recovery-key-3d').textContent);
      $('identity-status').textContent='恢复密钥已复制。';
    }catch{$('identity-status').textContent='复制失败，可以下载密钥文件。';}
  };
  $('save-key-3d').onclick=()=>{
    const url=URL.createObjectURL(new Blob([$('recovery-key-3d').textContent+'\n'],{type:'text/plain'}));
    const link=document.createElement('a');
    link.href=url;link.download='orbital-recovery-key.txt';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  $('dismiss-key-3d').onclick=()=>revealKey();
  form.addEventListener('input',schedulePreview);
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if($('launch-3d').disabled)return;
    if(!pendingLaunch){
      const input=launchInput();
      try{model.validateLaunch(input);}
      catch(error){$('launch-status').textContent=error.message;return;}
      pendingLaunch={...input,idempotencyKey:crypto.randomUUID()};
    }
    sending=true;updateLaunch();
    $('launch-status').textContent='正在发射…';
    try{
      const {satellite}=await api('/api/satellites',pendingLaunch);
      if(!pageActive)return;
      pendingLaunch=null;predicted=[];previewToken++;launchVisible=false;
      clearTimeout(previewTimer);
      receive([satellite]);
      lastLaunchedId=satellite.id;
      focusFlight(satellite.id);
      $('launch-status').textContent='已发射 '+satellite.name;
      canvas.scrollIntoView({block:'nearest'});
    }catch(error){
      if(error.status>=400&&error.status<500&&![408,429].includes(error.status))pendingLaunch=null;
      if(error.status===401){online=false;$('reconnect-3d').hidden=false;}
      $('launch-status').textContent=error.message+(pendingLaunch?'。再次发射将重试同一组参数。':'');
    }finally{sending=false;updateLaunch();}
  });
  const start=launchSystem;
  form.elements.x.value=units.toKm(start.x+1200).toFixed(2);
  form.elements.y.value=units.toKm(start.y).toFixed(2);
  form.elements.z.value=units.toKm((start.z??0)+150).toFixed(2);
  const observation=model.MODEL.observation;
  $('observation-3d').textContent='模型 '+model.MODEL.dynamics.version+' · 可观测区域半径 '+units.formatKm(units.toKm(observation.radius))+
    ' · 卫星越界后归档，可回放和导出。'+(blackHoleLabels.size
      ? '冲击波以黑洞为中心。可通过天体定位选定黑洞，也可直接使用离当前观察范围中心最近的黑洞。'
      : '这张地图没有黑洞，无法启动冲击波。');
  if(typeof Worker!=='undefined'){
    worker=new Worker('preview-worker.js');
    worker.onmessage=({data})=>{
      if(data.token!==previewToken)return;
      predicted=data.points??[];
      if(data.error)$('launch-status').textContent='预测暂不可用 · '+data.error;
      if(!playing)draw();
    };
    worker.onerror=()=>{$('launch-status').textContent='预测暂不可用，仍可正式发射。';};
  }
  new ResizeObserver(resize).observe(canvas);
  document.addEventListener('visibilitychange', updatePlayback);
  addEventListener('pagehide',()=>{
    pageActive=false;
    stopFrame();
    clearTimeout(previewTimer);
    worker?.terminate();
    stream?.close();
    controls.reset();
    historyRenderer?.destroy();
    stellarRenderer.destroy();
  });
  addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
  schedulePreview();
  updatePlayback();
  connect();
})();
