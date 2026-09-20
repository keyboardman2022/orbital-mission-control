'use strict';
function createStreamState(){return {known:new Map()};}
function buildSnapshot(stream,data,{selectedId,now=Date.now()}={}){
  const satellites=[],present=new Set();
  for(const record of data.satellites){
    present.add(record.id);const old=stream.known.get(record.id);
    const coverage=record.trajectoryCoverage;
    const changed=!old||old.tick!==record.state?.tick||old.status!==record.status||old.coverageStatus!==coverage?.status||old.coverageLastSeq!==coverage?.lastSeq;
    if(!changed)continue;
    const immediate=!old||old.status!==record.status;
    if(!immediate&&record.id!==selectedId&&now-old.sentAt<1000)continue;
    satellites.push(!old?record:{id:record.id,state:record.state,status:record.status,endReason:record.endReason,birthTick:record.birthTick,telemetry:record.telemetry,trajectoryCoverage:coverage});
    stream.known.set(record.id,{tick:record.state?.tick,status:record.status,coverageStatus:coverage?.status,coverageLastSeq:coverage?.lastSeq,sentAt:now});
  }
  for(const id of stream.known.keys())if(!present.has(id))stream.known.delete(id);
  return {...data,satellites,delivery:'delta'};
}
module.exports={createStreamState,buildSnapshot};
