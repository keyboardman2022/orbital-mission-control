'use strict';
const ESTIMATED_BYTES_PER_POINT=256;
const DEFAULT_MAX_POINTS=409600;

function createPolicy(maxPoints=DEFAULT_MAX_POINTS){
  if(!Number.isSafeInteger(maxPoints)||maxPoints<1)throw new TypeError('trajectory max points must be a positive safe integer');
  const limitBytes=maxPoints*ESTIMATED_BYTES_PER_POINT;
  if(!Number.isSafeInteger(limitBytes))throw new TypeError('trajectory byte limit must be a safe integer');
  return Object.freeze({version:'point-budget-v1',estimatedBytesPerPoint:ESTIMATED_BYTES_PER_POINT,maxPoints,limitBytes});
}
const POLICY=createPolicy();

function validPolicy(value){
  return value?.version==='point-budget-v1'&&Number.isSafeInteger(value.maxPoints)&&value.maxPoints>0&&
    value.estimatedBytesPerPoint===ESTIMATED_BYTES_PER_POINT&&value.limitBytes===value.maxPoints*ESTIMATED_BYTES_PER_POINT;
}
function endpoint(record){
  const point=record.lastSample||record.state||{};
  return {seq:Math.max(0,Number(record.seq)||0),tick:Math.max(0,Number(point.tick)||0),elapsedSeconds:Math.max(0,Number(point.elapsedSeconds)||0)};
}
function ensure(record,policy=POLICY){
  if(!record||typeof record!=='object')throw new TypeError('trajectory budget requires a satellite record');
  if(!validPolicy(policy))throw new TypeError('invalid trajectory budget policy');
  if(!record.trajectoryBudget){
    record.trajectoryBudget={...policy,status:'recording',cappedAt:null};
  }else if(!validPolicy(record.trajectoryBudget)||!['recording','capped'].includes(record.trajectoryBudget.status)){
    throw new TypeError('invalid durable trajectory budget');
  }
  const budget=record.trajectoryBudget;
  if((record.seq||0)>=budget.maxPoints&&budget.status!=='capped'){
    budget.status='capped';budget.cappedAt=endpoint(record);
  }
  if(budget.status==='capped'&&!budget.cappedAt)budget.cappedAt=endpoint(record);
  return budget;
}
function isCapped(record){return ensure(record).status==='capped';}
function admit(record,point){
  const budget=ensure(record);
  if(budget.status==='capped')return false;
  point.seq=++record.seq;record.lastSample=point;
  if(record.seq>=budget.maxPoints){budget.status='capped';budget.cappedAt={seq:point.seq,tick:point.tick,elapsedSeconds:point.elapsedSeconds};}
  return true;
}
function coverage(record){
  const budget=ensure(record),end=budget.status==='capped'?budget.cappedAt:endpoint(record),lastSeq=Math.max(0,Number(record.seq)||0);
  return {status:budget.status,estimatedBytes:lastSeq*budget.estimatedBytesPerPoint,limitBytes:budget.limitBytes,
    estimatedBytesPerPoint:budget.estimatedBytesPerPoint,maxPoints:budget.maxPoints,lastSeq,
    endTick:end.tick,endElapsedSeconds:end.elapsedSeconds,truncated:budget.status==='capped'};
}

module.exports={ESTIMATED_BYTES_PER_POINT,DEFAULT_MAX_POINTS,POLICY,createPolicy,ensure,admit,isCapped,coverage};
