'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const {DatabaseSync}=require('node:sqlite');
const {createWriteStream,renameSync,unlinkSync}=require('node:fs');
const {finished}=require('node:stream/promises');
const {once}=require('node:events');
const {createHash}=require('node:crypto');
const U=require('../shared/units.js');
async function run(){
  const {filename,target,record}=workerData,db=new DatabaseSync(filename,{readOnly:true});
  const temporary=target+'.partial',out=createWriteStream(temporary,{flags:'wx'}),digest=createHash('sha256');
  let bytes=0,writeError;
  out.on('error',error=>{writeError=error;});
  async function write(text){if(writeError)throw writeError;const data=Buffer.from(text);digest.update(data);bytes+=data.length;if(!out.write(data))await once(out,'drain');}
  try{
    const metadata={satellite:record.satellite,model:record.model,cutoffTick:record.cutoffTick,cutoffSeq:record.cutoffSeq,createdAt:record.createdAt,integration:{method:'fixed-step velocity Verlet',stepSeconds:record.model.step,event:'linear drift segment boundary intersection',precisionNote:'非严格相对论。测试中最小半径80、切向初速度1000的一秒位置与16倍细步长结果相差约0.352场景单位；径向捕获事件时间误差小于0.002模拟秒。非全参数精度保证。'},sampling:{baseIntervalSeconds:1,innerRadius:4*record.model.rs,innerIntervalSeconds:record.model.step,linearPredictionErrorThreshold:.5},description:'世界坐标 +Y 向上；伪牛顿场景单位；记录完整追踪时段的采样点，并非每个积分步骤。'};
    metadata.calibration=record.satellite.calibration||U.SCALE;
    metadata.physicalUnits={distance:'km',speed:'km/s',time:'s',mass:'kg'};
    metadata.description='世界坐标 +Y 向上；原始 x/y/vx/vy 为场景单位，另附 km 和 km/s 换算。10 倍标称太阳质量为假设示例；历史记录的换算会标记 calibrationInferred。伪牛顿模型不是相对论测量；physicalSpeedValid=false 时，speedKmS 不可视为真实物理速度。记录为采样点，并非每一步积分。';
    metadata.events=db.prepare('SELECT event FROM events WHERE satellite_id=? AND seq<=? ORDER BY seq').all(record.satelliteId,record.cutoffEventSeq).map(row=>JSON.parse(row.event));
    const query=db.prepare('SELECT seq,tick,elapsed AS elapsedSeconds,x,y,vx,vy,kind FROM points WHERE satellite_id=? AND tick<=? AND seq<=? ORDER BY seq');
    const csv=value=>{let s=String(value??'');if(typeof value==='string'&&/^[=+@\-\t\r\n]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
    if(record.format==='json')await write(JSON.stringify(metadata).slice(0,-1)+',"points":[');
    else await write('\uFEFFsatellite_id,name,elapsed_sim_seconds,tick,event_type,x,y,vx,vy,radius,speed,elapsed_physical_seconds,x_km,y_km,vx_km_s,vy_km_s,radius_km,speed_km_s,physical_speed_valid,metadata_json\r\n');
    let first=true;
    for(const p of query.iterate(record.satelliteId,record.cutoffTick,record.cutoffSeq)){
      const physical=U.telemetry(p,metadata.calibration);
      if(record.format==='json')await write((first?'':',')+JSON.stringify({...p,...physical}));
      else await write([record.satelliteId,record.satellite.name,p.elapsedSeconds,p.tick,p.kind,p.x,p.y,p.vx,p.vy,Math.hypot(p.x,p.y),physical.speed,physical.physicalElapsedSeconds,physical.xKm,physical.yKm,physical.vxKmS,physical.vyKmS,physical.radiusKm,physical.speedKmS,physical.physicalSpeedValid,first?JSON.stringify(metadata):''].map(csv).join(',')+'\r\n');
      first=false;
    }
    if(record.format==='json')await write(']}\n');
    out.end();await finished(out);db.close();renameSync(temporary,target);
    parentPort.postMessage({status:'ready',bytes,checksum:digest.digest('hex')});
  }catch(error){out.destroy();try{await finished(out);}catch{}try{db.close();}catch{}try{unlinkSync(temporary);}catch{}throw error;}
}
run().catch(error=>parentPort.postMessage({status:'failed',message:error.message}));
