'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const {DatabaseSync}=require('node:sqlite');
const {createCheckpointStore}=require('./checkpoint-store.js');
const {archiveBatch}=require('./trajectory-store.js');

const {filename}=workerData;
const db=new DatabaseSync(filename);
db.exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
const store=createCheckpointStore(db);

parentPort.on('message',({batch,cutoffWorldTick})=>{
  if(!batch){db.close();parentPort.close();return;}
  try{
    const start=performance.now();
    store.write(batch);
    const checkpointMs=performance.now()-start;
    let archivedPoints=0,archiveMs=0,archiveError=null;
    if(cutoffWorldTick!==undefined){
      const startArchive=performance.now();
      try{archivedPoints=archiveBatch(db,filename,{cutoffWorldTick})?.count??0;}
      catch(error){archiveError=error.message;}
      archiveMs=performance.now()-startArchive;
    }
    parentPort.postMessage({checkpointMs,archivedPoints,archiveMs,archiveError});
  }catch(error){parentPort.postMessage({error:error.message});}
});
