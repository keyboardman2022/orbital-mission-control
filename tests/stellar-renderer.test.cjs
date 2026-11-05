const {test}=require('node:test');
const assert=require('node:assert/strict');
const S=require('../stellar-renderer.js');
function harness({compile=true}={}){
 const handlers={},draws=[],scissors=[],uniforms=[];let lost=false,programs=0;
 const gl=new Proxy({
   createShader:()=>({}),shaderSource(){},compileShader(){},getShaderParameter:()=>compile,getShaderInfoLog:()=> 'compile failed',
   createProgram:()=>({id:++programs}),attachShader(){},linkProgram(){},getProgramParameter:()=>true,
   createBuffer:()=>({}),getAttribLocation:()=>0,getUniformLocation:(_p,name)=>name,
   uniform1f:(name,value)=>uniforms.push({name,value}),uniform2f:(name,...value)=>uniforms.push({name,value}),uniform3fv:(name,value)=>uniforms.push({name,value:[...value]}),
   drawArrays:()=>draws.push(true),scissor:(...args)=>scissors.push(args),isContextLost:()=>lost
 },{get:(target,key)=>key in target?target[key]:key===key.toUpperCase()?1:()=>{}});
 const canvas={width:0,height:0,getContext:()=>gl,addEventListener:(name,fn)=>{handlers[name]=fn;},removeEventListener:name=>{delete handlers[name];}};
 return {canvas,gl,handlers,draws,scissors,uniforms,get programs(){return programs;},setLost:value=>{lost=value;}};
}
const bodies=[{x:50,y:40,radius:12,star:{id:'aurora'}},{x:1000,y:40,radius:8,star:{id:'cyan'}}];
test('stellar renderer skips unavailable graphics without breaking the 2D scene',()=>{
 const r=S.createRenderer({getContext:()=>null});assert.equal(r.available,false);assert.equal(r.render({bodies,width:100,height:80,dpr:1,time:0}),false);r.destroy();
 const h=harness({compile:false}),failed=S.createRenderer(h.canvas);assert.equal(failed.available,false);failed.destroy();
});
test('stellar renderer batches visible bodies, clips GPU work and renders detail at the current pixel size',()=>{
 const h=harness(),r=S.createRenderer(h.canvas);
 assert.equal(r.render({bodies,width:100,height:80,dpr:2,time:12}),true);
 assert.equal(h.draws.length,1);assert.equal(h.canvas.width,200);assert.equal(h.canvas.height,160);
 assert.ok(h.uniforms.some(u=>u.name==='radius'&&u.value===24));
 assert.ok(h.uniforms.some(u=>u.name==='time'&&u.value===12));
 assert.ok(h.scissors.every(([x,y,w,height])=>x>=0&&y>=0&&x+w<=200&&y+height<=160));
 assert.equal(r.render({bodies:[{...bodies[0],radius:120}],width:100,height:80,dpr:2,time:13}),true);
 assert.ok(h.uniforms.some(u=>u.name==='radius'&&u.value===240));
 r.destroy();assert.equal(r.available,false);
});
test('stellar renderer falls back during context loss and rebuilds after restore',()=>{
 const h=harness(),r=S.createRenderer(h.canvas);let prevented=false;
 h.setLost(true);h.handlers.webglcontextlost({preventDefault(){prevented=true;}});
 assert.equal(prevented,true);assert.equal(r.available,false);assert.equal(r.render({bodies,width:100,height:80,dpr:1,time:0}),false);
 h.setLost(false);h.handlers.webglcontextrestored();assert.equal(r.available,true);assert.equal(h.programs,2);
 assert.equal(r.render({bodies,width:100,height:80,dpr:1,time:1}),true);assert.equal(h.draws.length,1);r.destroy();
});
test('stellar profiles preserve the accepted warm, blue and red appearance families',()=>{
 assert.deepEqual(S.profile('aurora'),{color:[1,.61,.20],kind:0});
 assert.deepEqual(S.profile('sapphire'),{color:[.37,.59,1],kind:1});
 assert.deepEqual(S.profile('colossus'),{color:[1,.18,.055],kind:2});
});
