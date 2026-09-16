'use strict';
const $ = (s) => document.querySelector(s);
const destinations = [
  { code: 'KEPLER — 186F', short: 'KEPLER', name: '开普勒 · 翡翠回响', place: '翡翠回响', distance: '492', hue: 135 },
  { code: 'SATURN — TITAN', short: 'TITAN', name: '泰坦 · 琥珀之海', place: '琥珀之海', distance: '0.00013', hue: 34 },
  { code: 'TRAPPIST — 1E', short: 'TRAPPIST', name: '特拉比斯特 · 永夜来信', place: '永夜来信', distance: '39.5', hue: 210 }
];
let selected = 0, speed = .3, viewZoom = 1, paused = matchMedia('(prefers-reduced-motion: reduce)').matches;
let noticeTimer;
function notify(message) { const openDialog=document.querySelector('dialog[open]');let target=$('#notice');if(openDialog){target=openDialog.querySelector('.dialog-notice');if(!target){target=document.createElement('p');target.className='dialog-notice';target.setAttribute('role','status');openDialog.append(target);}}target.textContent=message;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>{document.querySelectorAll('#notice,.dialog-notice').forEach(el=>{el.textContent='';});},3500); }
const canvas = $('#universe'), ctx = canvas.getContext('2d');
// Bake the dust once; rotate each band independently before projecting the disk.
const diskLayers = [
  { inner: 177, outer: 233 },
  { inner: 230, outer: 321 },
  { inner: 318, outer: 438 }
].map(band => {
  const texture = document.createElement('canvas');
  texture.width = texture.height = 1100;
  return { ...band, velocity:OrbitalPhysics.angularSpeed((band.inner+band.outer)/2)*.55, texture, context: texture.getContext('2d') };
});
let seed = 1234;
function random() { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; }
function makeRing(hue) {
  seed = 2186;
  diskLayers.forEach((band, layer) => {
    const tx = band.context;
    tx.clearRect(0, 0, 1100, 1100);
    tx.save(); tx.translate(550, 550);
    for (let i = 0; i < 28500; i++) {
      const angle = random() * Math.PI * 2;
      const r = band.inner + random() * (band.outer - band.inner);
      const edge = Math.min(1, (r - band.inner) / 7, (band.outer - r) / 12);
      const turbulence = .45 + .55 * Math.pow(Math.sin(angle * 3 + r * .037), 2);
      const filaments = .35 + .65 * Math.pow(Math.sin(r * .62 + angle * 6), 2);
      const alpha = (.24 + random() * .64) * turbulence * filaments * edge;
      tx.fillStyle = `hsla(${hue + random() * 28 - 14},${24 + random() * 25}%,${84 - layer * 12 + random() * 12}%,${alpha})`;
      const size = .4 + random() * 1.5;
      tx.fillRect(Math.cos(angle) * r, Math.sin(angle) * r, size * 1.7, size);
    }
    // Spiral filaments provide recognizable features to follow as the disk turns.
    for (let i = 0; i < 65; i++) {
      const start = random() * Math.PI * 2, radius = band.inner + random() * (band.outer - band.inner);
      tx.beginPath();
      for (let j = 0; j <= 24; j++) {
        const angle = start + j * .018, r = radius + j * .16;
        const x = Math.cos(angle) * r, y = Math.sin(angle) * r;
        if (!j) tx.moveTo(x, y); else tx.lineTo(x, y);
      }
      tx.strokeStyle = `hsla(${hue},35%,86%,${.06 + random() * .16})`;
      tx.lineWidth = .4 + random(); tx.stroke();
    }
    tx.restore();
  });
}
let w = 0, h = 0, t = 0, last = 0, frameId = 0, visible = true;
const stars = Array.from({length:190}, () => ({x:random(),y:random(),r:random()*1.1+.2,a:random()*.5+.15}));
const plasma = Array.from({length:180}, () => ({angle:random()*Math.PI*2,radius:184+random()*235,length:.03+random()*.16,alpha:.2+random()*.65}));
const infall = Array.from({length:75}, () => ({angle:random()*Math.PI*2,phase:random(),size:.4+random()*.9}));
function resize() { const rect=canvas.getBoundingClientRect(); w=rect.width;h=rect.height; const dpr=Math.min(devicePixelRatio||1,1.5);canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);draw(); }
function draw() {
  ctx.clearRect(0,0,w,h);
  for(const star of stars){const shimmer=.8+.2*Math.sin(t*.65+star.x*50);ctx.fillStyle=`rgba(208,221,213,${star.a*shimmer})`;ctx.beginPath();ctx.arc(star.x*w,star.y*h,star.r,0,Math.PI*2);ctx.fill();}
  const {size,cx,cy,scale}=OrbitalCamera.view(w,h,viewZoom);
  const hue=destinations[selected].hue;
  const halo=ctx.createRadialGradient(cx,cy,size*.09,cx,cy,size*.47);
  halo.addColorStop(0,`hsla(${hue},45%,45%,.03)`);
  halo.addColorStop(.28,`hsla(${hue},45%,48%,.17)`);
  halo.addColorStop(1,'transparent');ctx.fillStyle=halo;ctx.fillRect(0,0,w,h);
  ctx.save();ctx.translate(cx,cy);ctx.rotate(-.48);ctx.scale(scale,scale*.66);
  const corona=ctx.createRadialGradient(0,0,164,0,0,400);
  corona.addColorStop(0,'transparent');corona.addColorStop(.055,`hsla(${hue},40%,83%,.7)`);
  corona.addColorStop(.16,`hsla(${hue},52%,62%,.27)`);corona.addColorStop(.55,`hsla(${hue},38%,50%,.06)`);corona.addColorStop(1,'transparent');
  ctx.fillStyle=corona;ctx.fillRect(-500,-500,1000,1000);
  for(const band of diskLayers){ctx.save();ctx.rotate(t*band.velocity);ctx.drawImage(band.texture,-550,-550);ctx.restore();}
  ctx.globalCompositeOperation='lighter';
  // Faster inner orbits and long luminous tails make angular motion immediately legible.
  for(const p of plasma){
    const a=p.angle+t*OrbitalPhysics.angularSpeed(p.radius)*.55;
    const brightness=p.alpha*(.6+.4*Math.sin(a+.8));
    for(let tail=0;tail<3;tail++){
      ctx.beginPath();ctx.arc(0,0,p.radius,a-p.length*(tail+1),a-p.length*tail);
      ctx.strokeStyle=`hsla(${hue},36%,${90-tail*9}%,${brightness/(tail+1)})`;
      ctx.lineWidth=tail===0?1.4:.8;ctx.stroke();
    }
  }
  for(const p of infall){
    const progress=(p.phase+t*.075)%1,r=520-progress*344,a=p.angle+progress*2.8;
    ctx.beginPath();ctx.arc(0,0,r,a-.028-progress*.04,a);
    ctx.strokeStyle=`hsla(${hue},36%,83%,${Math.sin(progress*Math.PI)*.52})`;ctx.lineWidth=p.size;ctx.stroke();
  }
  // Narrow photon rings stay anchored while bright knots race along them.
  for(let i=0;i<4;i++){
    ctx.beginPath();ctx.arc(0,0,173+i*2.3,0,Math.PI*2);
    ctx.strokeStyle=`hsla(${hue},32%,91%,${.64-i*.14})`;ctx.lineWidth=i===0?1.7:.8;ctx.stroke();
  }
  for(let i=0;i<3;i++){
    const a=t*OrbitalPhysics.angularSpeed(200+i*12)*.55+i*2.094;
    ctx.beginPath();ctx.arc(0,0,177+i*3,a,a+.55);
    ctx.strokeStyle=`hsla(${hue},28%,93%,.65)`;ctx.lineWidth=2.8;ctx.shadowColor=`hsl(${hue},55%,76%)`;ctx.shadowBlur=12;ctx.stroke();
  }
  ctx.shadowBlur=0;ctx.globalCompositeOperation='source-over';
  const core=ctx.createRadialGradient(-24,-24,0,0,0,171);
  core.addColorStop(0,'#020403');core.addColorStop(.92,'#030605');core.addColorStop(1,`hsl(${hue},18%,5%)`);
  ctx.beginPath();ctx.arc(0,0,171,0,Math.PI*2);ctx.fillStyle=core;ctx.fill();
  ctx.restore();
  // Anamorphic light glints follow hot spots without obscuring the event horizon.
  ctx.save();ctx.translate(cx,cy);ctx.rotate(-.48);
  for(let i=0;i<2;i++){
    const a=t*OrbitalPhysics.angularSpeed(200)*.55+i*Math.PI,r=181*scale,x=Math.cos(a)*r,y=Math.sin(a)*r*.66;
    const glint=ctx.createRadialGradient(x,y,0,x,y,36*scale);
    glint.addColorStop(0,'rgba(239,255,242,.75)');glint.addColorStop(.12,`hsla(${hue},50%,80%,.38)`);glint.addColorStop(1,'transparent');
    ctx.fillStyle=glint;ctx.fillRect(x-40*scale,y-40*scale,80*scale,80*scale);
    const flare=ctx.createLinearGradient(x-76*scale,y,x+76*scale,y);flare.addColorStop(0,'transparent');flare.addColorStop(.5,`hsla(${hue},30%,93%,.42)`);flare.addColorStop(1,'transparent');
    ctx.fillStyle=flare;ctx.fillRect(x-76*scale,y-.5,152*scale,1);
  }
  ctx.restore();
  if(typeof drawUserStars==='function')drawUserStars(ctx,cx,cy,scale,hue);
}
function loop(now){frameId=0;if(paused||!visible||document.hidden||document.querySelector('#journey[open]'))return;const dt=last?Math.min((now-last)/1000,.05):0;last=now;const elapsed=dt*speed;t+=elapsed;if(typeof advanceUserStars==='function')advanceUserStars(elapsed);draw();frameId=requestAnimationFrame(loop);}
function resume(){last=0;if(!frameId&&!paused&&visible&&!document.hidden)frameId=requestAnimationFrame(loop);}
function syncPause(){ $('#pause').textContent=paused?'▷':'Ⅱ';$('#pause').setAttribute('aria-label',paused?'播放宇宙动画':'暂停宇宙动画');$('#pause').setAttribute('aria-pressed',String(paused)); if(paused){cancelAnimationFrame(frameId);frameId=0;}else resume(); }
$('#pause').addEventListener('click',()=>{paused=!paused;syncPause();});
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',e=>{paused=e.matches;syncPause();});
$('#speed').addEventListener('input',e=>{speed=Number(e.target.value);$('#speed-value').value=speed.toFixed(1)+'×';});
function setViewZoom(value){
  viewZoom=Math.max(.1,Math.min(2,Math.round(value*100)/100));
  $('#view-zoom').value=Math.round(viewZoom*100);
  $('#zoom-value').value=Math.round(viewZoom*100)+'%';
  $('#view-zoom').setAttribute('aria-valuetext',Math.round(viewZoom*100)+'%，投放距离范围为原来的 '+(1/viewZoom).toFixed(1)+' 倍');
  $('#zoom-hint').textContent=`投放距离范围 ${(1/viewZoom).toFixed(1)} 倍 · 缩小后可从更远处投星`;
  $('#zoom-out').disabled=viewZoom<=.1;$('#zoom-in').disabled=viewZoom>=2;
  if(typeof cancelCharge==='function')cancelCharge();
  draw();
}
$('#view-zoom').addEventListener('input',event=>setViewZoom(Number(event.target.value)/100));
$('#zoom-out').addEventListener('click',()=>setViewZoom(viewZoom/1.25));
$('#zoom-in').addEventListener('click',()=>setViewZoom(viewZoom*1.25));
$('#zoom-reset').addEventListener('click',()=>setViewZoom(1));
document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(frameId);frameId=0;}else resume();});
new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;if(!visible){cancelAnimationFrame(frameId);frameId=0;}else resume();}).observe(canvas);
document.querySelectorAll('[data-destination]').forEach(button=>button.addEventListener('click',()=>{
  selected=Number(button.dataset.destination);const d=destinations[selected];$('#object-code').textContent=d.code;$('#object-name').textContent=d.name;$('#distance').textContent=d.distance;
  document.querySelectorAll('[data-destination]').forEach((b,i)=>{b.classList.toggle('selected',i===selected);b.setAttribute('aria-pressed',String(i===selected));b.querySelector('.selection-label').textContent=i===selected?'已选航线':'选择航线 ↗';});
  makeRing(d.hue);draw();notify(`已切换至「${d.place}」航线，引力环已更新。`);
}));
function openBoarding(){ $('#boarding-form').hidden=false;$('#ticket-result').hidden=true;$('#boarding').showModal();$('#traveler').focus(); }
document.querySelectorAll('[data-launch]').forEach(button=>button.addEventListener('click',()=>{if(button.classList.contains('nav-cta'))openBoarding();else startJourney();}));
$('#about-open').addEventListener('click',()=>$('#about').showModal());
document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}}));
let traveler='';
$('#boarding-form').addEventListener('submit',e=>{e.preventDefault();traveler=$('#traveler').value.trim();if(!traveler){$('#traveler').setCustomValidity('请输入旅客称呼');$('#traveler').reportValidity();return;}const d=destinations[selected];$('#ticket-name').textContent=traveler;$('#ticket-code').firstChild.textContent=d.short;$('#ticket-place').textContent=d.place;$('#boarding-form').hidden=true;$('#ticket-result').hidden=false;$('#download').focus();});
$('#traveler').addEventListener('input',()=>$('#traveler').setCustomValidity(''));
$('#edit-name').addEventListener('click',()=>{$('#boarding-form').hidden=false;$('#ticket-result').hidden=true;$('#traveler').focus();});
$('#download').addEventListener('click',()=>{
  const c=document.createElement('canvas');c.width=1200;c.height=660;const p=c.getContext('2d'),d=destinations[selected];
  p.fillStyle='#dce3d5';p.fillRect(0,0,1200,660);p.strokeStyle='#738772';p.lineWidth=2;p.strokeRect(24,24,1152,612);
  p.fillStyle='#16271b';p.font='bold 38px Arial';p.fillText('ORBITAL®',62,89);p.font='18px monospace';p.fillText('INTERSTELLAR BOARDING PASS',775,83);
  p.font='74px monospace';p.fillText('EARTH',62,228);p.fillText(d.short,620,228);p.fillStyle='#b5461c';p.fillText('→',440,228);p.fillStyle='#455b48';p.font='22px "Microsoft YaHei",sans-serif';p.fillText('地球 · 出发地',65,274);p.fillText(d.place+' · 目的地',625,274);
  p.setLineDash([8,6]);p.beginPath();p.moveTo(62,322);p.lineTo(1138,322);p.stroke();p.setLineDash([]);
  p.font='17px monospace';p.fillText('PASSENGER / 旅客',62,375);p.fillText('SEAT / 舷窗',925,375);p.fillStyle='#16271b';p.font='36px "Microsoft YaHei",sans-serif';p.fillText(traveler,62,431,770);p.fillText('01—A',925,431);
  p.font='16px monospace';p.fillText("DEPARTURE: WHEN YOU'RE READY",62,547);p.fillText('YEAR 2186',980,547);
  p.fillStyle='#455b48';p.font='16px "Microsoft YaHei",sans-serif';p.fillText('一张通往未知的想象航行纪念卡 · 非真实票据',62,593);
  c.toBlob(blob=>{if(!blob){notify('保存失败，请重试。');return;}const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`ORBITAL-${d.short}-boarding-pass.png`;a.click();setTimeout(()=>URL.revokeObjectURL(url),15000);notify('登舰卡已生成，愿好奇心与你同航。');},'image/png');
});
let audioContext, audioOn=false, gain;
$('#sound').addEventListener('click',async()=>{try{
  if(!audioContext){const AudioContext=window.AudioContext||window.webkitAudioContext;if(!AudioContext){notify('当前浏览器不支持环境音。');return;}audioContext=new AudioContext();gain=audioContext.createGain();gain.gain.value=0;gain.connect(audioContext.destination);[55,82.41,110,164.81].forEach((frequency,i)=>{const osc=audioContext.createOscillator(),g=audioContext.createGain();osc.type='sine';osc.frequency.value=frequency;g.gain.value=.1/(i+1);osc.connect(g);g.connect(gain);osc.start();});}
  await audioContext.resume();audioOn=!audioOn;gain.gain.cancelScheduledValues(audioContext.currentTime);gain.gain.setTargetAtTime(audioOn?.45:0,audioContext.currentTime,.4);$('#sound').setAttribute('aria-pressed',String(audioOn));$('#sound').setAttribute('aria-label',audioOn?'关闭环境音':'开启环境音');notify(audioOn?'环境音已开启':'环境音已关闭');
}catch{notify('环境音暂不可用，请稍后重试。');}});
makeRing(destinations[0].hue);new ResizeObserver(resize).observe(canvas);syncPause();
