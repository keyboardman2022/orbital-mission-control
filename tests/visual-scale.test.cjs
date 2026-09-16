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
