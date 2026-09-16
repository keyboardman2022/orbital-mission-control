'use strict';
// Both interactions use elapsed time, so pauses never advance the simulation.
const orbitalSimulation=new OrbitalPhysics.Simulation();
const thrownStars=orbitalSimulation.particles, absorptionWaves=[];
let absorbedCount=0, escapedCount=0, pointerCharge=null;
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
const chargeIndicator=document.createElement('div');
chargeIndicator.className='charge-indicator';chargeIndicator.setAttribute('aria-hidden','true');
document.body.append(chargeIndicator);
function absorbStar(mass){
  absorbedCount++;
  absorptionWaves.push({born:t,mass});
  if(absorptionWaves.length>8)absorptionWaves.shift();
  updateOrbitStatus();
}
function updateOrbitStatus(){ $('#star-status').textContent=`轨道中 ${thrownStars.length} · 已吞噬 ${absorbedCount} · 已逃逸 ${escapedCount}`; }
function throwStar(x=.82,y=.28,mass=1){
  const {x:px,y:py}=OrbitalCamera.toWorld(x*w,y*h,OrbitalCamera.view(w,h,viewZoom));
  const particle=OrbitalPhysics.createParticle(px,py,$('#launch-mode').value,mass);
  if(particle.status==='captured'){absorbStar(mass);draw();return;}
  thrownStars.push(particle);updateOrbitStatus();
  if(paused)$('#star-status').textContent+=' · 已暂停';
  draw();
}
function advanceUserStars(elapsed){
  const removed=orbitalSimulation.advance(elapsed);
  for(const star of removed){if(star.status==='captured')absorbStar(star.mass);else escapedCount++;}
  if(removed.length)updateOrbitStatus();
  for(let i=absorptionWaves.length-1;i>=0;i--)if(t-absorptionWaves[i].born>2.4)absorptionWaves.splice(i,1);
}
function drawUserStars(context,cx,cy,scale,hue){
  context.save();context.translate(cx,cy);context.rotate(-.48);context.scale(scale,scale*.66);
  // Occlusion is visual only. Hidden particles still integrate down to the capture surface.
  const extent=Math.max(w,h)*3/scale;
  context.beginPath();context.rect(-extent,-extent,extent*2,extent*2);context.moveTo(171,0);context.arc(0,0,171,0,Math.PI*2);context.clip('evenodd');
  context.globalCompositeOperation='lighter';
  for(const star of thrownStars){
    for(let j=1;j<star.trail.length;j++){
      const a=star.trail[j-1],b=star.trail[j],strength=j/star.trail.length;
      context.beginPath();context.moveTo(...a);context.lineTo(...b);
      context.strokeStyle=`rgba(255,187,109,${strength*.85})`;context.lineWidth=Math.max(star.mass*2*strength,.8/scale);context.stroke();
    }
    const {x,y}=star,radius=Math.max(20*star.mass,8/scale),glow=context.createRadialGradient(x,y,0,x,y,radius);
    glow.addColorStop(0,'#fff9e8');glow.addColorStop(.1,'#ffe4ab');glow.addColorStop(.3,'#ff9e5377');glow.addColorStop(1,'transparent');
    context.fillStyle=glow;context.fillRect(x-radius,y-radius,radius*2,radius*2);
  }
  for(let i=absorptionWaves.length-1;i>=0;i--){
    const wave=absorptionWaves[i],age=t-wave.born;
    const radius=178+age*135,alpha=(1-age/2.4)*.65;
    context.beginPath();context.arc(0,0,radius,0,Math.PI*2);context.strokeStyle=`hsla(${hue},70%,82%,${alpha})`;
    context.lineWidth=2+wave.mass*2;context.stroke();
  }
  context.restore();
}
function cancelCharge(){pointerCharge=null;chargeIndicator.classList.remove('charging');}
canvas.addEventListener('contextmenu',event=>event.preventDefault());
canvas.addEventListener('pointerdown',event=>{
  if(!event.isPrimary||event.button!==0)return;
  pointerCharge={id:event.pointerId,x:event.clientX,y:event.clientY,start:performance.now()};
  canvas.setPointerCapture(event.pointerId);
  chargeIndicator.style.left=event.clientX+'px';chargeIndicator.style.top=event.clientY+'px';chargeIndicator.classList.add('charging');
});
canvas.addEventListener('pointermove',event=>{if(pointerCharge&&Math.hypot(event.clientX-pointerCharge.x,event.clientY-pointerCharge.y)>18)cancelCharge();});
canvas.addEventListener('pointerup',event=>{
  if(!pointerCharge||pointerCharge.id!==event.pointerId)return;
  const charge=pointerCharge,rect=canvas.getBoundingClientRect();cancelCharge();
  throwStar((charge.x-rect.left)/rect.width,(charge.y-rect.top)/rect.height,1+Math.min(2,(performance.now()-charge.start)/650));
});
canvas.addEventListener('pointercancel',cancelCharge);
canvas.addEventListener('lostpointercapture',cancelCharge);
window.addEventListener('blur',cancelCharge);
$('#throw-star').title='点击投星；按住 Shift 点击可投出巨星';
$('#throw-star').addEventListener('click',event=>throwStar(.67,.7,event.shiftKey?3:1));
$('#throw-star').addEventListener('keydown',event=>{
  if(event.shiftKey&&(event.key==='Enter'||event.key===' ')){event.preventDefault();if(!event.repeat)throwStar(.67,.7,3);}
});
$('#clear-stars').addEventListener('click',()=>{orbitalSimulation.clear();absorptionWaves.length=0;updateOrbitStatus();draw();});

const journey=$('#journey'),warpCanvas=$('#warp-canvas'),warpContext=warpCanvas.getContext('2d');
let warpFrame=0,warpElapsed=0,warpLast=0,journeyDestination=0;
const warpStars=Array.from({length:240},(_,i)=>({angle:i*2.399963,depth:(i*.618034)%1,spread:.35+((i*37)%100)/100}));
const arrivalDescriptions=[
  '双重日落照亮森林。你已抵达，翡翠回响。',
  '金色云层在舷窗之外缓缓散开。欢迎来到，琥珀之海。',
  '白昼与永夜在这里相遇。远方的来信，终于有了回音。'
];
function resizeWarp(){
  const rect=journey.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,1.5);
  warpCanvas.width=Math.round(rect.width*dpr);warpCanvas.height=Math.round(rect.height*dpr);
  warpContext.setTransform(dpr,0,0,dpr,0,0);
  renderWarp(Math.min(1,warpElapsed/4800));
}
function renderWarp(progress){
  const width=journey.clientWidth,height=journey.clientHeight,cx=width/2,cy=height*.46;
  const hue=destinations[journeyDestination].hue;
  warpContext.fillStyle='#030807';warpContext.fillRect(0,0,width,height);
  const nebula=warpContext.createRadialGradient(cx,cy,0,cx,cy,Math.max(width,height)*.7);
  nebula.addColorStop(0,`hsla(${hue},60%,35%,.4)`);nebula.addColorStop(1,'transparent');warpContext.fillStyle=nebula;warpContext.fillRect(0,0,width,height);
  const traveling=journey.dataset.stage==='warp';
  for(const star of warpStars){
    const depth=(star.depth+progress*(.2+progress*1.8))%1;
    const radius=(.03+depth*depth)*Math.max(width,height)*star.spread;
    const tail=traveling?8+progress*progress*radius*.55:1;
    const x=cx+Math.cos(star.angle)*radius,y=cy+Math.sin(star.angle)*radius;
    warpContext.beginPath();warpContext.moveTo(x,y);warpContext.lineTo(x+Math.cos(star.angle)*tail,y+Math.sin(star.angle)*tail);
    warpContext.strokeStyle=`hsla(${hue},35%,88%,${.2+depth*.65})`;warpContext.lineWidth=.6+depth*1.4;warpContext.stroke();
  }
  if(traveling){
    const radius=35+Math.pow(progress,2.8)*Math.max(width,height);
    for(let i=0;i<6;i++){warpContext.beginPath();warpContext.ellipse(cx,cy,radius+i*7,(radius+i*7)*.8,-.25,0,Math.PI*2);warpContext.strokeStyle=`hsla(${hue},50%,78%,${(.35-i*.05)*(1-progress)})`;warpContext.lineWidth=2;warpContext.stroke();}
  }
}
function arrive(){
  cancelAnimationFrame(warpFrame);warpFrame=0;
  journey.dataset.stage='arrival';const destination=destinations[journeyDestination];
  $('#journey-title').textContent=destination.place;$('#journey-description').textContent=arrivalDescriptions[journeyDestination];
  $('#journey-phase').textContent='ARRIVAL CONFIRMED / 已抵达';$('#journey-progress').value=100;
  $('#journey-boarding').hidden=false;$('#journey-skip').hidden=true;
  renderWarp(1);$('#journey-boarding').focus({preventScroll:true});
}
function journeyTick(now){
  warpFrame=0;if(!journey.open||journey.dataset.stage!=='warp'||document.hidden)return;
  if(warpLast)warpElapsed+=Math.min(now-warpLast,80);warpLast=now;
  const progress=Math.min(1,warpElapsed/4800);$('#journey-progress').value=Math.round(progress*100);
  const phase=progress<.33?'EARTH → EVENT HORIZON':progress<.8?'WARP DRIVE / 曲速航行':'APPROACHING / 接近目的地';
  $('#journey-phase').textContent=phase;renderWarp(progress);
  if(progress>=1)arrive();else warpFrame=requestAnimationFrame(journeyTick);
}
function startJourney(){
  if(journey.open)return;
  journeyDestination=selected;warpElapsed=0;warpLast=0;
  journey.dataset.stage='warp';journey.style.setProperty('--journey-hue',destinations[selected].hue);
  $('#journey-code').textContent='EARTH → '+destinations[selected].code;
  $('#journey-title').textContent='正在折叠时空';$('#journey-description').textContent='把熟悉的世界留在身后。';
  $('#journey-boarding').hidden=true;$('#journey-skip').hidden=false;$('#journey-progress').value=0;
  cancelCharge();journey.showModal();cancelAnimationFrame(frameId);frameId=0;resizeWarp();
  if(reducedMotion.matches||paused)arrive();else{warpFrame=requestAnimationFrame(journeyTick);$('#journey-skip').focus();}
}
$('#journey-skip').addEventListener('click',arrive);
$('#journey-close').addEventListener('click',()=>journey.close());
$('#journey-boarding').addEventListener('click',()=>{journey.close();openBoarding();});
journey.addEventListener('close',()=>{cancelAnimationFrame(warpFrame);warpFrame=0;warpLast=0;resume();});
document.addEventListener('visibilitychange',()=>{
  cancelCharge();
  if(document.hidden){cancelAnimationFrame(warpFrame);warpFrame=0;warpLast=0;}
  else if(journey.open&&journey.dataset.stage==='warp'&&!warpFrame)warpFrame=requestAnimationFrame(journeyTick);
});
reducedMotion.addEventListener('change',event=>{if(event.matches&&journey.open&&journey.dataset.stage==='warp')arrive();});
new ResizeObserver(()=>{if(journey.open)resizeWarp();}).observe(journey);
