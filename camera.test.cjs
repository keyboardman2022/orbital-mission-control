const test=require('node:test');
const assert=require('node:assert/strict');
const Camera=require('./camera.js');
const P=require('./physics.js');

test('projected positions round-trip at desktop/mobile sizes and every zoom limit',()=>{
  for(const [w,h] of [[1100,700],[500,500]])for(const zoom of [.1,.5,1,2]){
    const view=Camera.view(w,h,zoom);
    for(const point of [{x:0,y:0},{x:330,y:-420},{x:3500,y:1200}]){
      const screen=Camera.toScreen(point.x,point.y,view);
      const world=Camera.toWorld(screen.x,screen.y,view);
      assert.ok(Math.hypot(world.x-point.x,world.y-point.y)<1e-8);
    }
  }
});
test('zooming out tenfold expands the launch distance tenfold',()=>{
  const near=Camera.toWorld(800,500,Camera.view(1000,700,1));
  const far=Camera.toWorld(800,500,Camera.view(1000,700,.1));
  assert.ok(Math.abs(Math.hypot(far.x,far.y)/Math.hypot(near.x,near.y)-10)<1e-10);
});
test('changing the view preserves existing particle state and allows distant circular launches',()=>{
  const view=Camera.view(1000,700,.1),point=Camera.toWorld(800,500,view);
  const particle=P.createParticle(point.x,point.y,'orbit'),before=JSON.stringify(particle);
  for(const zoom of [.1,2,1])Camera.toScreen(particle.x,particle.y,Camera.view(1000,700,zoom));
  assert.equal(JSON.stringify(particle),before);
  const r=Math.hypot(particle.x,particle.y);
  for(let i=0;i<24000;i++)P.step(particle);
  assert.equal(particle.status,'active');
  assert.ok(Math.abs(Math.hypot(particle.x,particle.y)/r-1)<.0001);
});
test('cursor-centered zoom keeps the same world position under an off-center pointer',()=>{
 for(const [w,h] of [[1100,700],[375,520]])for(const zoom of [1e-7,.5,2]){
  const view=Camera.view(w,h,zoom,{x:63,y:-47}),pointer={x:w*.23,y:h*.71};
  const world=Camera.toWorld(pointer.x,pointer.y,view);
  for(const factor of [.1,2,10]){
   const changed=Camera.zoomAt(view,view.scale*factor,pointer),screen=Camera.toScreen(world.x,world.y,changed);
   assert.ok(Math.hypot(screen.x-pointer.x,screen.y-pointer.y)<1e-7);
   assert.ok(Math.abs(changed.size/view.size-factor)<1e-12);
  }
 }
});
test('camera translation is shared by forward and inverse projection',()=>{
 const base=Camera.view(1000,620,.8),moved=Camera.view(1000,620,.8,{x:200,y:-90});
 assert.equal(moved.cx-base.cx,200);assert.equal(moved.cy-base.cy,-90);
 const point={x:1100,y:700},screen=Camera.toScreen(point.x,point.y,moved),back=Camera.toWorld(screen.x,screen.y,moved);
 assert.ok(Math.hypot(back.x-point.x,back.y-point.y)<1e-8);
});
test('dragging shifts projected positions by the pointer delta without changing scale',()=>{
 const view=Camera.view(1000,620,.2),point={x:1700,y:-800},before=Camera.toScreen(point.x,point.y,view);
 const moved=Camera.pan(view,137,-82),after=Camera.toScreen(point.x,point.y,moved);
 assert.ok(Math.abs(after.x-before.x-137)<1e-9);assert.ok(Math.abs(after.y-before.y+82)<1e-9);
 assert.equal(moved.scale,view.scale);assert.equal(moved.size,view.size);
 const back=Camera.toWorld(after.x,after.y,moved);assert.ok(Math.hypot(back.x-point.x,back.y-point.y)<1e-8);
 const anchor={x:300,y:210},world=Camera.toWorld(anchor.x,anchor.y,moved),zoomed=Camera.zoomAt(moved,moved.scale*2,anchor);
 assert.ok(Math.hypot(Camera.toScreen(world.x,world.y,zoomed).x-anchor.x,Camera.toScreen(world.x,world.y,zoomed).y-anchor.y)<1e-8);
});
test('black hole origin indicator stays in the map at every zoom, including when the hole is offscreen',()=>{
 for(const [w,h]of [[375,520],[1100,700]])for(const zoom of [1e-7,2]){
  const view=Camera.view(w,h,zoom),origin=Camera.originMarker(view,w,h);
  assert.equal(origin.x,view.cx);assert.equal(origin.y,view.cy);assert.equal(origin.inView,true);
  for(const dx of [-1e6,1e6]){
   const moved=Camera.pan(view,dx,-1e6),marker=Camera.originMarker(moved,w,h);
   assert.ok(marker.x>=0&&marker.x<w&&marker.y>=0&&marker.y<h);assert.equal(marker.inView,false);
   assert.equal(Math.sign(Math.cos(marker.angle)),Math.sign(dx));assert.ok(Math.sin(marker.angle)<0);
  }
 }
});
