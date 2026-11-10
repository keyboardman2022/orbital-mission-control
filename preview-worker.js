'use strict';
importScripts('shared/units.js','shared/world-generator.js','shared/simulation.js','shared/nbody.js');
let cachedWorldId=null, model=OrbitalModel;
function dynamicRuntime(world,frame){
  const rate=OrbitalModel.MODEL.tickRate;
  let tick=frame.tick;
  const sim=OrbitalNBody.createSimulation(frame.bodies,{gravity:OrbitalWorldGenerator.MU_PER_SOLAR_MASS,
    softening:OrbitalWorldGenerator.N_BODY_SOFTENING,startTime:tick/rate,nextId:frame.nextId,mergeId:id=>`merged-${id}`});
  const frames=new Map([[tick,frame.bodies]]);
  return OrbitalModel.createRuntime(world,time=>{
    const wanted=Math.floor(time);
    while(tick<wanted){
      sim.step(1/rate);frames.set(++tick,sim.bodies.map(body=>({...body})));
      if(frames.size>4)frames.delete(frames.keys().next().value);
    }
    return frames.get(wanted)??frames.get(tick);
  });
}
self.onmessage = ({data}) => {
  try {
    if(data.worldId!==cachedWorldId){
      model=data.world?OrbitalModel.createRuntime(data.world):OrbitalModel;
      cachedWorldId=data.worldId;
    }
    const runtime=data.bodyField?dynamicRuntime(data.world,data.bodyField):model;
    const fieldTick=data.bodyField?Math.max(data.bodyField.tick,Math.floor(data.fieldTick)):data.fieldTick;
    const input=runtime.resolveLaunch(data.input,fieldTick);
    const checked=runtime.validateLaunch(input), initial=checked.normalized||checked.value||checked;
    let state=runtime.createState(initial,{continuousTracking:true,fieldTick});
    const point=()=>({x:state.x,y:state.y,...(state.z!==undefined?{z:state.z}:{})});
    const points=[point()];
    for(let i=0;i<(data.bodyField?2400:14400);i++){
      if(state.status&&state.status!=='active')break;
      const next=runtime.step(state);if(next)state=next;
      if(i%48===0)points.push(point());
    }
    points.push(point());
    self.postMessage({token:data.token,points});
  } catch(error){self.postMessage({token:data.token,error:error.message,points:[]});}
};
