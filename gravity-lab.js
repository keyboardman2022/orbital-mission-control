'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const {STEP,SPAWN_RADIUS,MAX_BODIES,TYPES,generateBodies,createSimulation} = OrbitalNBody;
  const canvas=$('scene'),ctx=canvas.getContext('2d');
  const seedInput=$('lab-seed'),countInput=$('lab-count'),play=$('lab-play'),singleStep=$('lab-step');
  const log=$('lab-log'),error=$('lab-error'),url=new URL(location.href);
  const back=new URL('seed-preview.html',url);
  const worldId=url.searchParams.get('worldId');
  if (/^[a-f0-9]{64}$/.test(worldId)) back.searchParams.set('worldId',worldId);
  else if (url.searchParams.get('from')==='classic') back.searchParams.set('from','classic');
  $('lab-return').href=back.href;
  if (!ctx) {error.hidden=false;error.textContent='当前浏览器无法绘制实验星图。';return;}

  const sky=Array.from({length:160},(_,i)=>({x:((i*337+29)%997)/997,y:((i*153+97)%991)/991,bright:i%8===0}));
  const touch=matchMedia('(hover: none)').matches;
  const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('lab-hint').textContent=touch?'单指旋转 · 双指缩放':'左键平移 · 右键旋转 · 滚轮缩放';
  let sim,playing=!reducedMotion,frame=null,last=null,accumulator=0,seen=0,nextTrail=0;
  let width=0,height=0,yaw=-.42,pitch=.52,zoom=1,panX=0,panY=0,drag,vectorSeconds;
  const trails=new Map();

  function makeSeed() {
    const parts=crypto.getRandomValues(new Uint32Array(2));
    return `LAB-${Array.from(parts,value=>value.toString(36)).join('-')}`;
  }
  function start(seed,count) {
    try {sim=createSimulation(generateBodies(seed,count));}
    catch(failure){error.textContent=failure.message;error.hidden=false;return;}
    error.hidden=true;
    seedInput.value=seed.trim().normalize('NFC');
    url.searchParams.set('seed',seedInput.value);url.searchParams.set('count',String(count));
    history.replaceState(history.state,'',url);
    seen=0;nextTrail=0;last=null;accumulator=0;
    trails.clear();log.replaceChildren();
    const speeds=sim.bodies.map(body=>Math.hypot(body.vx,body.vy,body.vz));
    const maxSpeed=Math.max(...speeds);
    vectorSeconds=SPAWN_RADIUS*.18/maxSpeed;
    $('lab-initial-speed').textContent=`初速范围 ${Math.min(...speeds).toFixed(0)}–${maxSpeed.toFixed(0)} 场景单位/模拟秒`;
    yaw=-.42;pitch=.52;fit();
    updateLegend();updateReadout();sampleTrails();draw();schedule();
  }
  function updateLegend() {
    const counts=new Map();
    for(const body of sim.bodies)counts.set(body.kind,(counts.get(body.kind)??0)+1);
    const items=Object.entries(TYPES).map(([kind,type])=>{
      const item=document.createElement('li'),swatch=document.createElement('i');
      swatch.style.backgroundColor=type.color;swatch.setAttribute('aria-hidden','true');
      item.append(swatch,`${type.label} ${counts.get(kind)??0}`);
      return item;
    });
    $('lab-legend').replaceChildren(...items);
  }
  function updateReadout() {
    const label=sim.time.toFixed(2);
    if ($('lab-time').textContent!==label) $('lab-time').textContent=label;
    $('lab-population').textContent=sim.bodies.length;
    $('lab-merges').textContent=sim.collisions.length;
    $('lab-empty').hidden=sim.collisions.length>0;
  }
  function sampleTrails() {
    if(sim.time<nextTrail)return;
    nextTrail=sim.time+.12;
    for(const body of sim.bodies){
      const points=trails.get(body.id)??[];
      points.push({x:body.x,y:body.y,z:body.z});
      if(points.length>42)points.shift();
      trails.set(body.id,points);
    }
  }
  function reportCollisions() {
    if(seen===sim.collisions.length)return;
    const name=body=>`${TYPES[body.kind].label} #${body.id}`;
    for(const {first,second,result,time} of sim.collisions.slice(seen)){
      const row=document.createElement('li');
      row.textContent=`${time.toFixed(2)} 秒 · ${name(first)} + ${name(second)} → ${name(result)}`;
      log.prepend(row);
      if(log.children.length>8)log.lastElementChild.remove();
      trails.delete(first.id);trails.delete(second.id);
    }
    seen=sim.collisions.length;updateLegend();
  }
  function advance() {sim.step();sampleTrails();}
  function schedule(){if(frame===null&&playing&&sim&&!document.hidden)frame=requestAnimationFrame(animate);}
  function animate(now) {
    frame=null;
    if(!playing||document.hidden)return;
    if(last!==null)accumulator+=Math.min(.05,(now-last)/1000)*Number($('lab-speed').value);
    last=now;
    while(accumulator>=STEP){advance();accumulator-=STEP;}
    reportCollisions();updateReadout();draw();schedule();
  }
  function setPlaying(value) {
    playing=value;last=null;accumulator=0;
    if(frame!==null){cancelAnimationFrame(frame);frame=null;}
    play.textContent=playing?'暂停模拟':'继续模拟';
    $('lab-mode').textContent=playing?'模拟中':'已暂停';
    singleStep.disabled=playing;
    schedule();
  }

  function fit() {
    const reach=Math.max(SPAWN_RADIUS,...sim.bodies.map(body=>Math.hypot(body.x,body.y,body.z)+body.radius));
    zoom=SPAWN_RADIUS/reach;panX=0;panY=0;
    draw();
  }
  function draw() {
    if(!sim||!width||!height)return;
    const scale=Math.min(width,height)*.42/SPAWN_RADIUS*zoom;
    const sinYaw=Math.sin(yaw),cosYaw=Math.cos(yaw),sinPitch=Math.sin(pitch),cosPitch=Math.cos(pitch);
    const project=({x,y,z})=>{
      const forward=x*sinYaw+y*cosYaw;
      return {x:width/2+panX+scale*(x*cosYaw-y*sinYaw),y:height/2+panY+scale*(forward*sinPitch-z*cosPitch),
        depth:forward*cosPitch+z*sinPitch};
    };
    ctx.fillStyle='#070c17';ctx.fillRect(0,0,width,height);
    for(const star of sky){ctx.fillStyle=star.bright?'#627c9a':'#26394e';ctx.fillRect(star.x*width,star.y*height,1,1);}
    function line(points,color,opacity) {
      ctx.beginPath();
      points.forEach((point,i)=>{const p=project(point);if(i)ctx.lineTo(p.x,p.y);else ctx.moveTo(p.x,p.y);});
      ctx.globalAlpha=opacity;ctx.strokeStyle=color;ctx.lineWidth=1;ctx.stroke();ctx.globalAlpha=1;
    }
    line([{x:-75,y:0,z:0},{x:75,y:0,z:0}],'#e49194',.18);
    line([{x:0,y:-75,z:0},{x:0,y:75,z:0}],'#76ddad',.18);
    line([{x:0,y:0,z:-75},{x:0,y:0,z:75}],'#7ab7ff',.18);
    if($('lab-trails').checked)for(const body of sim.bodies){
      const trace=trails.get(body.id);
      if(trace?.length>1)line([...trace,body],body.color,.29);
    }
    const visible=sim.bodies.map(body=>({body,...project(body)})).sort((a,b)=>a.depth-b.depth);
    if($('lab-vectors').checked)for(const {body,x,y} of visible){
      const duration=Math.min(vectorSeconds,SPAWN_RADIUS*.24/Math.hypot(body.vx,body.vy,body.vz));
      const end=project({x:body.x+body.vx*duration,y:body.y+body.vy*duration,z:body.z+body.vz*duration});
      const dx=end.x-x,dy=end.y-y;
      if(Math.hypot(dx,dy)<2.5)continue;
      const angle=Math.atan2(dy,dx);
      ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(end.x,end.y);
      for(const side of [-.5,.5]){
        ctx.moveTo(end.x,end.y);
        ctx.lineTo(end.x-4*Math.cos(angle+side),end.y-4*Math.sin(angle+side));
      }
      ctx.strokeStyle=body.color;ctx.lineWidth=1;ctx.globalAlpha=.72;ctx.stroke();ctx.globalAlpha=1;
    }
    for(const {body,x,y} of visible){
      const r=Math.max(1.15,body.radius*scale),glow=r*2.6;
      if(x+glow<0||y+glow<0||x-glow>width||y-glow>height)continue;
      const gradient=ctx.createRadialGradient(x,y,r*.55,x,y,glow);
      gradient.addColorStop(0,body.color+'79');gradient.addColorStop(1,body.color+'00');
      ctx.fillStyle=gradient;ctx.beginPath();ctx.arc(x,y,glow,0,Math.PI*2);ctx.fill();
      ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);
      ctx.fillStyle=body.kind==='blackHole'?'#04060d':body.color;ctx.fill();
      if(body.kind==='blackHole'){ctx.strokeStyle=body.color;ctx.lineWidth=Math.max(1,r*.12);ctx.stroke();}
    }
    if(!reducedMotion)for(const collision of sim.collisions.slice(-10)){
      const age=Math.max(0,(sim.time-collision.time)/2);
      if(age>=1)continue;
      const {x,y}=project(collision.result);
      ctx.beginPath();ctx.arc(x,y,Math.max(4,scale*(collision.result.radius+55*age)),0,Math.PI*2);
      ctx.globalAlpha=1-age;ctx.strokeStyle='#ffdba1';ctx.lineWidth=1.6;ctx.stroke();ctx.globalAlpha=1;
    }
  }
  function resize() {
    ({width,height}=canvas.getBoundingClientRect());
    const dpr=Math.min(devicePixelRatio||1,2);
    canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);draw();
  }
  function zoomAt(value,point={x:width/2,y:height/2}){
    const next=Math.max(.02,Math.min(16,value)),factor=next/zoom;
    panX=point.x+(width/2+panX-point.x)*factor-width/2;
    panY=point.y+(height/2+panY-point.y)*factor-height/2;
    zoom=next;draw();
  }
  function pointer(event){const rect=canvas.getBoundingClientRect();return {x:event.clientX-rect.left,y:event.clientY-rect.top};}
  const pinch=OrbitalCamera.createPinchGesture({start(){drag=null;},zoom(factor,event){zoomAt(zoom*factor,pointer(event));}});
  canvas.addEventListener('contextmenu',event=>event.preventDefault());
  canvas.addEventListener('wheel',event=>{
    event.preventDefault();zoomAt(OrbitalCamera.wheelZoom(zoom,event.deltaY,event.deltaMode,height),pointer(event));
  },{passive:false});
  canvas.addEventListener('pointerdown',event=>{
    if(pinch.down(event)){canvas.setPointerCapture(event.pointerId);return;}
    if(drag||![0,2].includes(event.button))return;
    drag={id:event.pointerId,x:event.clientX,y:event.clientY,rotate:event.button===2||event.pointerType==='touch'};
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove',event=>{
    if(pinch.move(event)||drag?.id!==event.pointerId)return;
    const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
    if(drag.rotate){yaw+=dx*.008;pitch+=dy*.008;}else{panX+=dx;panY+=dy;}
    drag.x=event.clientX;drag.y=event.clientY;draw();
  });
  for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,event=>{
    pinch.end(event);if(drag?.id===event.pointerId)drag=null;
  });
  canvas.addEventListener('keydown',event=>{
    switch(event.key){
      case ' ': setPlaying(!playing);break;
      case 'ArrowLeft': yaw-=.12;break;
      case 'ArrowRight': yaw+=.12;break;
      case 'ArrowUp': pitch-=.12;break;
      case 'ArrowDown': pitch+=.12;break;
      case '+': case '=': zoomAt(zoom*1.15);break;
      case '-': zoomAt(zoom/1.15);break;
      case '0': fit();break;
      default:return;
    }
    event.preventDefault();draw();
  });

  const form=$('lab-form');
  form.addEventListener('submit',event=>{event.preventDefault();start(seedInput.value,Number(countInput.value));});
  $('lab-random').onclick=()=>{if(countInput.reportValidity())start(makeSeed(),Number(countInput.value));};
  $('lab-fit').onclick=fit;
  $('lab-trails').onchange=draw;
  $('lab-vectors').onchange=draw;
  play.onclick=()=>setPlaying(!playing);
  singleStep.onclick=()=>{if(!playing){advance();reportCollisions();updateReadout();draw();}};
  document.addEventListener('visibilitychange',()=>{
    if(frame!==null){cancelAnimationFrame(frame);frame=null;}
    last=null;accumulator=0;schedule();
  });
  const requestedSeed=url.searchParams.get('seed')?.trim();
  const requestedCount=Number(url.searchParams.get('count'));
  if(Number.isInteger(requestedCount)&&requestedCount>=2&&requestedCount<=MAX_BODIES)countInput.value=requestedCount;
  new ResizeObserver(resize).observe(canvas);
  start(requestedSeed&&requestedSeed.length<=64?requestedSeed:makeSeed(),Number(countInput.value));
  setPlaying(playing);
})();
