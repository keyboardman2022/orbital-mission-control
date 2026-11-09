'use strict';
importScripts('shared/units.js','shared/world-generator.js','shared/simulation.js');
let cachedWorldId=null, model=OrbitalModel;
self.onmessage = ({data}) => {
  try {
    if(data.worldId!==cachedWorldId){
      model=data.world?OrbitalModel.createRuntime(data.world):OrbitalModel;
      cachedWorldId=data.worldId;
    }
    const input=model.resolveLaunch(data.input,data.fieldTick);
    const checked=model.validateLaunch(input), initial=checked.normalized||checked.value||checked;
    let state=model.createState(initial,{continuousTracking:true,fieldTick:data.fieldTick});
    const point=()=>({x:state.x,y:state.y,...(state.z!==undefined?{z:state.z}:{})});
    const points=[point()];
    for(let i=0;i<14400;i++){
      if(state.status&&state.status!=='active')break;
      const next=model.step(state);if(next)state=next;
      if(i%48===0)points.push(point());
    }
    points.push(point());
    self.postMessage({token:data.token,points});
  } catch(error){self.postMessage({token:data.token,error:error.message,points:[]});}
};
