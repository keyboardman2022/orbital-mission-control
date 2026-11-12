'use strict';
const {parentPort,workerData,Worker}=require('node:worker_threads');
const {join}=require('node:path');
const {Engine}=require('./engine.js');
const {purgeFlatMaps}=require('./purge-flat-maps.js');
const M=require('../shared/simulation.js');
purgeFlatMaps(workerData.filename);
const wallOrigin=Date.now(),monoOrigin=performance.now();
const engine=new Engine({filename:workerData.filename,now:()=>wallOrigin+performance.now()-monoOrigin,maxActive:workerData.maxActive,velocityRelativeTolerance:workerData.velocityRelativeTolerance});
engine.interruptExports();
const storage=new Worker(join(__dirname,'storage-worker.js'),{workerData:{filename:workerData.filename}});
let pendingStorage=null,finishStorage=null,waitingRequests=0,stopped=false,storageFailed=false;
let lastCommit=performance.now(),lastArchive=performance.now(),lastMono=performance.now();
function fatal(error){
  if(storageFailed)return;
  storageFailed=true;
  clearInterval(timer);
  storage.terminate().catch(()=>{});
  finishStorage?.();
  parentPort.postMessage({type:'fatal',message:error.message});
}
storage.on('error',fatal);
storage.on('exit',code=>{
  if(!stopped)fatal(new Error('存档线程已停止（'+code+'）'));
});
function saveInBackground(mono,archive){
  const started=performance.now(),batch=engine.captureCheckpoint(),receipt=engine.checkpointReceipt(batch);
  pendingStorage=new Promise(resolve=>{
    finishStorage=()=>{pendingStorage=null;finishStorage=null;resolve();};
  });
  storage.once('message',result=>{
    if(result.error){fatal(new Error(result.error));return;}
    engine.completeCheckpoint(receipt,result.checkpointMs);
    if(archive){
      engine.metrics.archivedPoints+=result.archivedPoints;
      engine.metrics.archiveMs=result.archiveMs;
      engine.metrics.archiveError=result.archiveError;
    }
    finishStorage();
  });
  storage.postMessage({batch,...(archive?{cutoffWorldTick:batch.clock.tick-86400*M.MODEL.tickRate}:{})});
  // postMessage has already copied the batch. Only one batch can be in flight.
  engine.releaseCheckpoint();
  engine.metrics.checkpointCaptureMs=performance.now()-started;
  engine.metrics.checkpointQueuedTick=batch.clock.tick;
  lastCommit=mono;
  if(archive)lastArchive=mono;
}
// Give high-rate maps more turns and cap how long any turn can block RPCs.
const pollMs=8;
const timer=setInterval(()=>{
  try{
    const mono=performance.now(),elapsed=Math.max(0,(mono-lastMono)/1000);lastMono=mono;
    let fastestRate=1;
    for(const clock of engine.spatialClocks.values()){
      if(clock.pausedAt==null)fastestRate=Math.max(fastestRate,clock.rate??1);
    }
    const budgetMs=fastestRate>64?55:fastestRate>M.MODEL.livePathAboveRate?40:16;
    engine.advanceRealtime(elapsed,{budgetMs});
    if(!pendingStorage&&!waitingRequests){
      const archive=mono-lastArchive>=1000&&engine.tick>=86400*M.MODEL.tickRate;
      if(archive||mono-lastCommit>=1000||engine.pending.length>=10000)saveInBackground(mono,archive);
    }
  }catch(error){fatal(error);}
},pollMs);
const readOnly=new Set(['modelInfo','authenticate','get','health','getExport','pendingMapSwitches']);
const allowed=new Set([...readOnly,'registerWorld','guest','recover','rotateRecovery','logout','launch','list','active','trajectory','bodyTrajectory','bodyFrame','terminate','terminateMany','deleteSatellite','switchMap','finishMapSwitch','prepareExport','finishExport','setSpatialPaused','setSpatialRate']);
parentPort.on('message',async({id,method,args=[]})=>{
  const knownField=method==='list'&&(!args[1]?.worldId||engine.bodyFields.get(args[0],args[1].worldId));
  const needsStorage=!readOnly.has(method)&&!knownField;
  if(needsStorage)waitingRequests++;
  try{
    if(method==='close'){stopped=true;clearInterval(timer);}
    // Serialize SQLite writers, including auto-checkpointing. Read-only SSE
    // requests on existing maps can proceed while the storage worker commits.
    if(needsStorage)await pendingStorage;
    if(storageFailed)throw new Error('存档线程不可用');
    let result;
    if(method==='close'){
      const closed=new Promise(resolve=>storage.once('exit',resolve));
      storage.postMessage({});
      await closed;
      engine.close();result={ok:true};
    }
    else {
      if(stopped||!allowed.has(method))throw new Error('未知内部指令或服务正在关闭');
      result=engine[method](...args);
    }
    parentPort.postMessage({id,result});
  }catch(error){parentPort.postMessage({id,error:{message:error.message,status:error.status||500}});}
  finally{if(needsStorage)waitingRequests--;}
});
parentPort.postMessage({type:'ready'});
