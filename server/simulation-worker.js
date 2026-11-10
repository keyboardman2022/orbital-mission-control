'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const {Engine}=require('./engine.js');
const {purgeFlatMaps}=require('./purge-flat-maps.js');
const M=require('../shared/simulation.js');
purgeFlatMaps(workerData.filename);
const wallOrigin=Date.now(),monoOrigin=performance.now();
const engine=new Engine({filename:workerData.filename,now:()=>wallOrigin+performance.now()-monoOrigin,maxActive:workerData.maxActive,velocityRelativeTolerance:workerData.velocityRelativeTolerance});
engine.interruptExports();
let lastCommit=performance.now(),lastArchive=performance.now(),lastMono=performance.now();
const timer=setInterval(()=>{
  try{
    const mono=performance.now(),elapsed=Math.max(0,(mono-lastMono)/1000);lastMono=mono;
    engine.advanceRealtime(elapsed,{budgetMs:12});
    if(mono-lastCommit>=1000||engine.pending.length>=10000){engine.checkpoint();lastCommit=mono;}
    if(mono-lastArchive>=1000&&engine.tick>=86400*M.MODEL.tickRate){engine.archive();lastArchive=performance.now();}
  }catch(error){parentPort.postMessage({type:'fatal',message:error.message});clearInterval(timer);}
},25);
parentPort.on('message',({id,method,args=[]})=>{
  try{
    let result;
    if(method==='close'){clearInterval(timer);engine.close();result={ok:true};}
    else {
      const allowed=['modelInfo','registerWorld','guest','authenticate','recover','rotateRecovery','logout','launch','get','list','active','trajectory','bodyTrajectory','bodyFrame','terminate','terminateMany','deleteSatellite','switchMap','pendingMapSwitches','finishMapSwitch','prepareExport','getExport','finishExport','health','setSpatialPaused','setSpatialRate'];
      if(!allowed.includes(method))throw new Error('未知内部指令');
      result=engine[method](...args);
    }
    parentPort.postMessage({id,result});
  }catch(error){parentPort.postMessage({id,error:{message:error.message,status:error.status||500}});}
});
parentPort.postMessage({type:'ready'});
