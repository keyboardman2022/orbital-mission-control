const {test}=require('node:test');
const assert=require('node:assert/strict');
const V=require('../orbital-visuals.js');
test('satellite halo shrinks without a screen-size floor and fades below pixel resolution',()=>{
 const near=V.satelliteAppearance(.4,1),far=V.satelliteAppearance(.004,1),wide=V.satelliteAppearance(1e-7,3);
 assert.equal(near.radius,8);assert.equal(far.radius,.08);
 assert.ok(far.opacity<near.opacity/100);assert.ok(wide.radius<.00001&&wide.opacity<1e-9);
 assert.equal(V.satelliteAppearance(0,1).opacity,0);
});
function context(){const c={strokes:[],fills:[],save(){},restore(){},beginPath(){},moveTo(){},lineTo(){},
 stroke(){this.strokes.push({width:this.lineWidth,blend:this.globalCompositeOperation,opacity:this.globalAlpha});},
 fillRect(){this.fills.push({blend:this.globalCompositeOperation,opacity:this.globalAlpha});},
 createRadialGradient(){return {addColorStop(){}};}};return c;}
test('satellite and trail do not add brightness; unresolved far objects produce no luminous blob',()=>{
 const ctx=context();V.renderSatellite(ctx,{x:20,y:20},.4,1);
 assert.equal(ctx.fills[0].blend,'source-over');assert.ok(ctx.fills[0].opacity<1);
 V.renderSatellite(ctx,{x:20,y:20},1e-7,3);assert.equal(ctx.fills.length,1);
 const points=[{x:0,y:0},{x:1,y:0},{x:2,y:0}],project=(x,y)=>({x,y});
 V.renderTrail(ctx,points,project,1,.04);
 assert.ok(ctx.strokes.every(s=>s.blend==='source-over'&&s.width<.8&&s.opacity<.1));
 const count=ctx.strokes.length;V.renderTrail(ctx,points,project,3,1e-7);assert.equal(ctx.strokes.length,count);
});
test('orbiting star cores and physical glow both scale with zoom',()=>{
 const near=V.stellarAppearance(1,{collisionRadius:20}),far=V.stellarAppearance(.01,{collisionRadius:20});
 assert.equal(near.physicalRadius,20);assert.equal(far.physicalRadius,.2);
 assert.ok(Math.abs(near.radius/far.radius-100)<1e-10);
 assert.equal(near.markerRadius,near.radius);
 assert.ok(far.markerRadius>0&&far.markerRadius<5);
 const ctx=context(),arcs=[];ctx.arc=(x,y,r)=>arcs.push({x,y,r});ctx.fill=()=>{};
 V.renderStar(ctx,{x:40,y:50},far,{id:'aurora',color:'#fff0b8'},2);
 assert.ok(arcs.some(arc=>arc.x===40&&arc.y===50&&arc.r===far.markerRadius));
});
test('distant-map star markers preserve the underlying stellar size hierarchy',()=>{
 const compact=V.stellarAppearance(.0001,{collisionRadius:12});
 const supergiant=V.stellarAppearance(.0001,{collisionRadius:84});
 assert.ok(supergiant.markerRadius>compact.markerRadius);
 assert.ok(compact.markerRadius>0&&supergiant.markerRadius<2);
});
test('stellar markers respond continuously across successive zoom levels',()=>{
 const star={collisionRadius:52};
 const far=V.stellarAppearance(.002,star),middle=V.stellarAppearance(.008,star),near=V.stellarAppearance(.032,star);
 assert.ok(far.markerRadius<middle.markerRadius&&middle.markerRadius<near.markerRadius);
 assert.ok(middle.markerRadius>far.markerRadius*1.7);
 assert.ok(near.markerRadius>middle.markerRadius*1.7);
});
test('unresolved stellar light fades with its coverage and has no fixed-pixel ornaments',()=>{
 const ctx=context(),arcs=[];ctx.arc=(x,y,r)=>arcs.push({x,y,r});ctx.fill=()=>{};
 const appearance=V.stellarAppearance(.0001,{collisionRadius:84});
 V.renderStar(ctx,{x:40,y:50},appearance,{id:'colossus',color:'#ff5f67'},2);
 const offset=arc=>Math.hypot(arc.x-40,arc.y-50);
 assert.ok(appearance.opacity<.001);
 assert.ok(arcs.every(arc=>arc.r<=appearance.radius*2.8&&offset(arc)<=appearance.radius));
 assert.ok(ctx.strokes.every(stroke=>stroke.width<=appearance.radius*.05));
});
test('stellar close-up grows linearly instead of clamping the surface to a tiny marker',()=>{
 const star={collisionRadius:84};
 const near=V.stellarAppearance(1,star),extreme=V.stellarAppearance(100,star);
 assert.ok(Math.abs(extreme.markerRadius/near.markerRadius-100)<1e-10);
 assert.ok(extreme.markerRadius>1000);
});
test('all approved stellar sizes retain their preview ratio to the unchanged black-hole shadow',()=>{
 const stars=require('../shared/simulation.js').MODEL.stars;
 for(const star of stars)for(const scale of[1e-6,.01,1,64]){
   const appearance=V.stellarAppearance(scale,star),hole=66*1.65*scale;
   assert.ok(hole/appearance.radius>=4.8-1e-10&&hole/appearance.radius<=10.6);
 }
 assert.ok(Math.abs(V.stellarAppearance(1,stars.at(-1)).radius-22.6875)<1e-10);
});

test('black-hole appearance enlarges only the rendered view',()=>{
 const physical={cx:420,cy:240,size:300,scale:.5};
 const visual=V.blackHoleAppearance(physical);
 assert.deepEqual({cx:visual.cx,cy:visual.cy},{cx:420,cy:240});
 assert.equal(visual.scale,.825);assert.equal(visual.size,495);
 assert.deepEqual(physical,{cx:420,cy:240,size:300,scale:.5});
});
test('the Canvas fallback draws a stellar disc without orbiting decorative particles',()=>{
 const ctx=context(),arcs=[];ctx.arc=(x,y,r)=>arcs.push({x,y,r});ctx.fill=()=>{};
 const appearance=V.stellarAppearance(.5,{collisionRadius:20});
 V.renderStar(ctx,{x:40,y:50},appearance,{id:'ember',color:'#ffd39a'},3);
 const particles=arcs.filter(arc=>Math.hypot(arc.x-40,arc.y-50)>appearance.markerRadius);
 assert.equal(particles.length,0);
 assert.ok(arcs.some(arc=>arc.r===appearance.radius));
});
test('map impact uses camera projection so zooming out shrinks its radius and thickness',()=>{
 const ctx=context(),arcs=[];ctx.arc=(x,y,r)=>arcs.push({x,y,r});ctx.fill=()=>{};
 const transforms=[];ctx.translate=()=>{};ctx.rotate=()=>{};ctx.scale=(x,y)=>transforms.push({x,y});
 const wave=require('../shared/map-sweep.js').create({ids:[],origin:{x:250,y:200},width:1000,height:800});wave.flares=[];wave.advance(1.2);
 V.renderMapImpact(ctx,wave,{cx:500,cy:400,scale:1});
 assert.ok(arcs.some(a=>a.x===250&&a.y===200&&Math.abs(a.r-wave.radius)<1e-9));
 assert.ok(ctx.strokes.some(s=>s.opacity>0&&s.width>=1));
 const radius=arcs[0].r;V.renderMapImpact(ctx,wave,{cx:500,cy:400,scale:.1});
 assert.equal(transforms[0].x,1);assert.equal(transforms[1].x,.1);assert.equal(arcs[0].r,radius);
 assert.equal(transforms[1].y,.066);
});
test('a wave spanning the minimum-zoom viewport remains visible instead of fading below pixel size',()=>{
 const ctx=context(),arcs=[];ctx.arc=(x,y,r)=>arcs.push(r);ctx.fill=()=>{};ctx.translate=()=>{};ctx.rotate=()=>{};ctx.scale=()=>{};
 const C=require('../camera.js'),S=require('../shared/map-sweep.js'),view=C.view(1000,800,1e-7),wave=S.create({ids:[],origin:{x:0,y:0},extent:1e10});wave.flares=[];wave.advance(wave.duration/2);
 V.renderMapImpact(ctx,wave,view);
 assert.ok(arcs.length>0);assert.ok(ctx.strokes.some(s=>s.opacity>.1&&s.width*view.scale>=1));
});
