'use strict';
// Reuse the original ORBITAL dust textures, rotating bands, infall and photon glints.
const OrbitalVisuals=(()=>{
  function satelliteAppearance(scale,mass=1){
    const radius=Number.isFinite(scale)&&scale>0?20*Math.max(0,mass)*scale:0;
    // Subpixel coverage fades out; there is no minimum screen-space marker size.
    return {radius,opacity:.85*Math.min(1,(radius/2)**2)};
  }
  function renderSatellite(ctx,p,scale,mass=1){
    const {radius:r,opacity}=satelliteAppearance(scale,mass);
    if(opacity<.001)return;
    ctx.save();ctx.globalCompositeOperation='source-over';ctx.globalAlpha=opacity;
    const glow=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,r);
    glow.addColorStop(0,'#fff9e8');glow.addColorStop(.1,'#ffe4ab');glow.addColorStop(.3,'#ff9e5377');glow.addColorStop(1,'transparent');
    ctx.fillStyle=glow;ctx.fillRect(p.x-r,p.y-r,r*2,r*2);ctx.restore();
  }
  function renderTrail(ctx,points,project,mass=1,scale=.4){
    const opacity=.8*Math.min(1,(Math.max(0,scale)/.18)**2);
    if(opacity<.001)return;
    ctx.save();ctx.globalCompositeOperation='source-over';ctx.globalAlpha=opacity;
    for(let i=1;i<points.length;i++){
      const a=project(points[i-1].x,points[i-1].y),b=project(points[i].x,points[i].y),strength=i/points.length;
      ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);
      ctx.strokeStyle=`rgba(255,187,109,${strength*.85})`;ctx.lineWidth=mass*1.5*strength*scale/.4;ctx.stroke();
    }
    ctx.restore();
  }
  function create(){
    const angularSpeed=r=>OrbitalModel.circularSpeed(r)/r;
const diskLayers = [
  { inner: 177, outer: 233 },
  { inner: 230, outer: 321 },
  { inner: 318, outer: 438 }
].map(band => {
  const texture = document.createElement('canvas');
  texture.width = texture.height = 1100;
  return { ...band, velocity:angularSpeed((band.inner+band.outer)/2)*.55, texture, context: texture.getContext('2d') };
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
const plasma = Array.from({length:180}, () => ({angle:random()*Math.PI*2,radius:184+random()*235,length:.03+random()*.16,alpha:.2+random()*.65}));
const infall = Array.from({length:75}, () => ({angle:random()*Math.PI*2,phase:random(),size:.4+random()*.9}));

    makeRing(135);
    function blackhole(ctx,w,h,view,t){
      const {size,cx,cy,scale}=view;
  const hue=135;
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
    const a=p.angle+t*angularSpeed(p.radius)*.55;
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
    const a=t*angularSpeed(200+i*12)*.55+i*2.094;
    ctx.beginPath();ctx.arc(0,0,177+i*3,a,a+.55);
    ctx.strokeStyle=`hsla(${hue},28%,93%,.65)`;ctx.lineWidth=2.8;ctx.shadowColor=`hsl(${hue},55%,76%)`;ctx.shadowBlur=12*Math.min(1,scale/.16);ctx.stroke();
  }
  ctx.shadowBlur=0;ctx.globalCompositeOperation='source-over';
  const core=ctx.createRadialGradient(-24,-24,0,0,0,171);
  core.addColorStop(0,'#020403');core.addColorStop(.92,'#030605');core.addColorStop(1,`hsl(${hue},18%,5%)`);
  ctx.beginPath();ctx.arc(0,0,171,0,Math.PI*2);ctx.fillStyle=core;ctx.fill();
  ctx.restore();
  // Anamorphic light glints follow hot spots without obscuring the event horizon.
  ctx.save();ctx.translate(cx,cy);ctx.rotate(-.48);
  for(let i=0;i<2;i++){
    const a=t*angularSpeed(200)*.55+i*Math.PI,r=181*scale,x=Math.cos(a)*r,y=Math.sin(a)*r*.66;
    const glint=ctx.createRadialGradient(x,y,0,x,y,36*scale);
    glint.addColorStop(0,'rgba(239,255,242,.75)');glint.addColorStop(.12,`hsla(${hue},50%,80%,.38)`);glint.addColorStop(1,'transparent');
    ctx.fillStyle=glint;ctx.fillRect(x-40*scale,y-40*scale,80*scale,80*scale);
    const flare=ctx.createLinearGradient(x-76*scale,y,x+76*scale,y);flare.addColorStop(0,'transparent');flare.addColorStop(.5,`hsla(${hue},30%,93%,.42)`);flare.addColorStop(1,'transparent');
    ctx.fillStyle=flare;ctx.fillRect(x-76*scale,y-.5,152*scale,1);
  }
  ctx.restore();

    }
    function impact(ctx,view,age,mass=1,angle=0){
      if(age<0||age>2.4)return;
      const visibility=Math.min(1,(view.scale/.08)**2);if(visibility<.001)return;
      const alpha=(1-age/2.4)*.65;
      ctx.save();ctx.translate(view.cx,view.cy);ctx.rotate(-.48);ctx.scale(view.scale,view.scale*.66);ctx.globalCompositeOperation='source-over';ctx.globalAlpha=visibility;
      for(let i=0;i<3;i++){
        ctx.beginPath();ctx.arc(0,0,178+age*(135+i*35),0,Math.PI*2);
        ctx.strokeStyle=`rgba(198,255,210,${alpha/(i+1)})`;ctx.lineWidth=(2+mass*2)/(i+1);ctx.stroke();
      }
      const x=Math.cos(angle)*178,y=Math.sin(angle)*178,r=Math.max(24,90*(1-age/2.4))*mass;
      const glow=ctx.createRadialGradient(x,y,0,x,y,r);glow.addColorStop(0,`rgba(255,249,224,${alpha})`);glow.addColorStop(.2,`rgba(255,183,109,${alpha*.7})`);glow.addColorStop(1,'transparent');
      ctx.fillStyle=glow;ctx.fillRect(x-r,y-r,r*2,r*2);
      for(let i=0;i<22;i++){
        const a=angle+(i-11)*.13,rad=180+age*(80+(i%5)*25);
        ctx.beginPath();ctx.arc(Math.cos(a)*rad,Math.sin(a)*rad,Math.max(.6,(1-age/2.4)*2.3),0,Math.PI*2);ctx.fillStyle=`rgba(255,219,157,${alpha})`;ctx.fill();
      }
      ctx.restore();
    }
    return {blackhole,trail:renderTrail,satellite:renderSatellite,impact};
  }
  return {create,satelliteAppearance,renderSatellite,renderTrail};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=OrbitalVisuals;
