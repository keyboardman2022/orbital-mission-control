'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const {Engine}=require('./engine.js');
const M=require('../shared/simulation.js');
const wallOrigin=Date.now(),monoOrigin=performance.now();
const engine=new Engine({filename:workerData.filename,now:()=>wallOrigin+performance.now()-monoOrigin,maxActive:workerData.maxActive});
engine.interruptExports();
let lastCommit=performance.now(),lastWall=Date.now(),lastMono=performance.now();
const timer=setInterval(()=>{
  try{
    const wall=Date.now(),mono=performance.now();
    if(Math.abs((wall-lastWall)-(mono-lastMono))>1000)engine.clockError='检测到系统时钟跳变，请校准时钟后重启服务';
    lastWall=wall;lastMono=mono;
    engine.advanceTo(engine.targetTick(),{maxSteps:2400,budgetMs:12});
    if(mono-lastCommit>=1000||engine.pending.length>=10000){engine.checkpoint();lastCommit=mono;}
  }catch(error){parentPort.postMessage({type:'fatal',message:error.message});clearInterval(timer);}
},25);
parentPort.on('message',({id,method,args=[]})=>{
  try{
    let result;
    if(method==='model')result={model:M.MODEL,server:engine.health()};
    else if(method==='close'){clearInterval(timer);engine.close();result={ok:true};}
    else {
      const allowed=['guest','authenticate','recover','rotateRecovery','logout','launch','get','list','trajectory','terminate','prepareExport','getExport','finishExport','health'];
      if(!allowed.includes(method))throw new Error('未知内部指令');
      result=engine[method](...args);
    }
    parentPort.postMessage({id,result});
  }catch(error){parentPort.postMessage({id,error:{message:error.message,status:error.status||500}});}
});
parentPort.postMessage({type:'ready'});
