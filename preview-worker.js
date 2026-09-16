'use strict';
importScripts('shared/units.js','shared/simulation.js');
self.onmessage = ({data}) => {
  try {
    const checked=OrbitalModel.validateLaunch(data.input), initial=checked.normalized||checked.value||checked;
    let state=OrbitalModel.createState(initial,{continuousTracking:true});
    const points=[{x:state.x,y:state.y}];
    for(let i=0;i<14400;i++){
      if(state.status&&state.status!=='active')break;
      const next=OrbitalModel.step(state);if(next)state=next;
      if(i%48===0)points.push({x:state.x,y:state.y});
    }
    points.push({x:state.x,y:state.y});
    self.postMessage({token:data.token,points});
  } catch(error){self.postMessage({token:data.token,error:error.message,points:[]});}
};
