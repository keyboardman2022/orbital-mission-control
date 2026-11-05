'use strict';
importScripts('shared/units.js','shared/world-generator.js','shared/simulation.js');
let cachedWorldId=null, model=OrbitalModel;
self.onmessage = ({data}) => {
  try {
    if(data.worldId!==cachedWorldId){
      model=data.world?OrbitalModel.createRuntime(data.world):OrbitalModel;
      cachedWorldId=data.worldId;
    }
    const checked=model.validateLaunch(data.input), initial=checked.normalized||checked.value||checked;
    let state=model.createState(initial,{continuousTracking:true,fieldTick:data.fieldTick});
    const points=[{x:state.x,y:state.y}];
    for(let i=0;i<14400;i++){
      if(state.status&&state.status!=='active')break;
      const next=model.step(state);if(next)state=next;
      if(i%48===0)points.push({x:state.x,y:state.y});
    }
    points.push({x:state.x,y:state.y});
    self.postMessage({token:data.token,points});
  } catch(error){self.postMessage({token:data.token,error:error.message,points:[]});}
};
