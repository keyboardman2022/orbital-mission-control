'use strict';
const Model=require('../shared/simulation.js');
const Generator=require('../shared/world-generator.js');
const {createSimulation}=require('../shared/nbody.js');

const SAMPLE_TICKS=480;
const DETAIL_WINDOW_SAMPLES=2048;
const DETAIL_WINDOW_TICKS=SAMPLE_TICKS*DETAIL_WINDOW_SAMPLES;
const RATE=Model.MODEL.tickRate;
const LIVE_PATH_INTERVAL=RATE/2;
const LIVE_PATH_LIMIT=160;
const key=(userId,worldId)=>`${userId}:${worldId}`;
const point=(body,tick)=>({tick,x:body.x,y:body.y,z:body.z,vx:body.vx,vy:body.vy,vz:body.vz});
const meta=(body,birthTick)=>({id:body.id,name:body.name,kind:body.kind,color:body.color,...(body.bodyClass?{bodyClass:body.bodyClass}:{}),
  radius:body.radius,massSolar:body.mass,systemId:body.systemId,birthTick,endTick:null});

function moreMassive(first,second){
  if(first.massSolar!==second.massSolar)return first.massSolar>second.massSolar?first:second;
  return first.id<second.id?first:second;
}

function restoreCollisionLinks(catalog){
  // Older archives have exact birth and end times but no parent links.
  const births=new Map(),ends=new Map();
  for(const body of catalog.values()){
    if(body.id.startsWith('merged-'))births.set(body.birthTick,[...(births.get(body.birthTick)??[]),body]);
    if(body.endTick!=null)ends.set(body.endTick,[...(ends.get(body.endTick)??[]),body]);
  }
  for(const [tick,results] of births){
    const parents=ends.get(tick);
    if(results.length!==1||parents?.length!==2)continue;
    const [result]=results;
    result.continuedFrom??=moreMassive(...parents).id;
    result.absorbedFrom??=parents.find(parent=>parent.id!==result.continuedFrom)?.id;
  }
}

function initialBodies(world){
  return world.systems.flatMap(system=>Generator.bodyPositions(system).map(({initial,orbit,massSolar,...body})=>
    ({...body,mass:massSolar,systemId:system.id})));
}

function createField(userId,worldId,world,saved){
  const sim=createSimulation(saved?.bodies??initialBodies(world),{
    gravity:Generator.MU_PER_SOLAR_MASS,softening:Generator.N_BODY_SOFTENING,
    startTime:saved?.time??0,nextId:saved?.nextId??1,mergeId:id=>`merged-${id}`
  });
  let tick=saved?.tick??0,seen=0,dirty=!saved;
  const tracks=[],catalog=new Map(saved?.catalog?.map(body=>[body.id,body])??sim.bodies.map(body=>[body.id,meta(body,0)]));
  if(saved)restoreCollisionLinks(catalog);
  // The integrator reads adjacent ticks (and occasionally a fractional hit).
  // Reuse four slots so a fast field does not allocate a body per tick per star.
  const gravityFrames=Array.from({length:4},()=>({tick:-1,nextId:0,bodies:[]}));
  const liveFrames=[];
  let snapshotTick=-1,snapshotBodies;
  function gravityFrame(){
    const slot=gravityFrames[tick%gravityFrames.length],bodies=slot.bodies;
    if(slot.tick===tick)return bodies;
    if(slot.nextId!==sim.nextId){
      bodies.length=0;
      for(const b of sim.bodies)bodies.push({
        id:b.id,name:b.name,kind:b.kind,radius:b.radius,massSolar:b.mass,
        mu:Generator.MU_PER_SOLAR_MASS*b.mass,rs:b.kind==='blackHole'?b.radius:0,
        collisionRadius:b.radius,softening:Generator.N_BODY_SOFTENING,
        x:0,y:0,z:0,vx:0,vy:0,vz:0
      });
      slot.nextId=sim.nextId;
    }
    let finite=true;
    for(let i=0;i<bodies.length;i++){
      const source=sim.bodies[i],target=bodies[i];
      target.x=source.x;target.y=source.y;target.z=source.z;
      target.vx=source.vx;target.vy=source.vy;target.vz=source.vz;
      finite=finite&&Number.isFinite(source.x)&&Number.isFinite(source.y)&&Number.isFinite(source.z)&&
        target.mu>=0&&target.mu<1e100;
    }
    bodies.boundedEnergy=finite;
    slot.tick=tick;
    return bodies;
  }
  function frame(){
    if(snapshotTick!==tick){
      snapshotTick=tick;
      snapshotBodies=sim.bodies.map(body=>({...body}));
    }
    return snapshotBodies;
  }
  const sample=(body,at)=>tracks.push({id:body.id,...point(body,at)});
  if(!saved)for(const body of sim.bodies)sample(body,0);
  function advanceTo(target,retainPrevious=false,recordLive=false){
    while(tick<target){
      if(retainPrevious)gravityFrame();
      sim.step(1/RATE);tick++;dirty=true;
      for(;seen<sim.collisions.length;seen++){
        const {first,second,result,time}=sim.collisions[seen];
        const at=Math.min(tick,time*RATE);
        for(const body of [first,second]){
          catalog.get(body.id).endTick=at;
          sample(body,at);
        }
        const survivor=moreMassive(catalog.get(first.id),catalog.get(second.id));
        const absorbed=survivor.id===first.id?second:first;
        const {x,y,z}=result;
        catalog.set(result.id,{...meta(result,at),continuedFrom:survivor.id,absorbedFrom:absorbed.id,mergeOrigin:{x,y,z}});sample(result,at);
      }
      if(tick%SAMPLE_TICKS===0)for(const body of sim.bodies)sample(body,tick);
      if(recordLive&&tick%LIVE_PATH_INTERVAL===0){
        liveFrames.push({tick,positions:sim.bodies.map(({id,x,y,z})=>[id,x,y,z])});
        if(liveFrames.length>LIVE_PATH_LIMIT)liveFrames.shift();
      }
    }
  }
  function gravityAt(time){
    const tick=Math.floor(time),slot=gravityFrames[tick%gravityFrames.length];
    const start=slot?.tick===tick?slot.bodies:gravityFrame();
    if(Number.isInteger(time))return start;
    const fraction=(time-Math.floor(time))/RATE;
    return start.map(body=>({...body,x:body.x+body.vx*fraction,y:body.y+body.vy*fraction,z:body.z+body.vz*fraction}));
  }
  return {userId,worldId,tracks,catalog,advanceTo,currentBodies:frame,
    runtime:Model.createRuntime(world,gravityAt,{preparedBodies:true}),
    get tick(){return tick;},get dirty(){return dirty;},
    snapshot:()=>({tick,nextId:sim.nextId,bodies:frame(),catalog:[...catalog.values()]}),
    livePath:since=>liveFrames.filter(frame=>frame.tick>since),
    serialize:()=>({tick,time:sim.time,nextId:sim.nextId,bodies:sim.bodies,catalog:[...catalog.values()]}),
    committed(){dirty=false;tracks.length=0;}
  };
}

class BodyFields{
  constructor(db){
    this.db=db;this.fields=new Map();
    db.exec(`CREATE TABLE IF NOT EXISTS body_fields(
      user_id TEXT NOT NULL REFERENCES users(id),world_id TEXT NOT NULL REFERENCES worlds(id),state TEXT NOT NULL,
      PRIMARY KEY(user_id,world_id));
      CREATE TABLE IF NOT EXISTS body_tracks(
      user_id TEXT NOT NULL,world_id TEXT NOT NULL,body_id TEXT NOT NULL,tick REAL NOT NULL,
      x REAL NOT NULL,y REAL NOT NULL,z REAL NOT NULL,vx REAL NOT NULL,vy REAL NOT NULL,vz REAL NOT NULL,
      PRIMARY KEY(user_id,world_id,body_id,tick),
      FOREIGN KEY(user_id,world_id) REFERENCES body_fields(user_id,world_id) ON DELETE CASCADE) WITHOUT ROWID;`);
  }
  restore(worldFor){
    for(const row of this.db.prepare('SELECT * FROM body_fields').all()){
      this.open(row.user_id,row.world_id,worldFor(row.world_id),JSON.parse(row.state));
    }
  }
  open(userId,worldId,world,saved){
    const field=createField(userId,worldId,world,saved);
    this.fields.set(key(userId,worldId),field);return field;
  }
  get(userId,worldId){return this.fields.get(key(userId,worldId));}
  forget(userId,worldId){this.fields.delete(key(userId,worldId));}
  deleteRows(userId,worldId){this.db.prepare('DELETE FROM body_fields WHERE user_id=? AND world_id=?').run(userId,worldId);}
  checkpointFields(){
    const batch=[];
    for(const field of this.fields.values())if(field.dirty){
      const {userId,worldId}=field;
      batch.push({userId,worldId,state:field.serialize(),tracks:field.tracks});
    }
    return batch;
  }
  committed(){for(const field of this.fields.values())field.committed();}
  trajectory(field,id,range){
    const body=field.catalog.get(id);
    if(!body)return null;
    const continuations=new Map(),absorptions=new Map();
    for(const segment of field.catalog.values()){
      if(segment.continuedFrom)continuations.set(segment.continuedFrom,segment);
      if(segment.absorbedFrom)absorptions.set(segment.absorbedFrom,segment);
    }
    const segments=[];
    for(let segment=body;segment;segment=continuations.get(segment.id))segments.push(segment);
    if(range){
      const readRange=this.db.prepare(`SELECT tick,x,y,z,vx,vy,vz FROM body_tracks
        WHERE user_id=? AND world_id=? AND body_id=? AND tick BETWEEN ? AND ? ORDER BY tick`);
      const points=segments.flatMap(segment=>readRange.all(field.userId,field.worldId,segment.id,range.fromTick,range.toTick));
      return {points};
    }
    const last=segments.at(-1);
    const stride=Math.max(1,Math.ceil(((last.endTick??field.tick)-body.birthTick)/DETAIL_WINDOW_TICKS))*SAMPLE_TICKS;
    const readPoints=this.db.prepare(`SELECT tick,x,y,z,vx,vy,vz FROM body_tracks
      WHERE user_id=? AND world_id=? AND body_id=? AND (tick=? OR tick=? OR (tick=CAST(tick AS INTEGER) AND CAST(tick AS INTEGER)%?=0)) ORDER BY tick`);
    const points=segments.flatMap(segment=>readPoints.all(field.userId,field.worldId,segment.id,segment.birthTick,segment.endTick,stride));
    const live=field.currentBodies().find(item=>item.id===last.id);
    if(live&&points.at(-1)?.tick!==field.tick)points.push(point(live,field.tick));
    const originalId=segmentId=>{
      let segment=field.catalog.get(segmentId);
      while(segment?.continuedFrom)segment=field.catalog.get(segment.continuedFrom);
      return segment?.id??null;
    };
    const birthPosition=this.db.prepare('SELECT x,y,z FROM body_tracks WHERE user_id=? AND world_id=? AND body_id=? AND tick=?');
    const waveFor=result=>{
      if(!result)return null;
      const origin=result.mergeOrigin??birthPosition.get(field.userId,field.worldId,result.id,result.birthTick);
      return origin?{origin:{...origin},radius:result.radius}:null;
    };
    const collisionEvents=segments.slice(1).map(segment=>({
      tick:segment.birthTick,otherBodyId:originalId(segment.absorbedFrom),absorbed:false,wave:waveFor(segment)
    }));
    const contactFrame=last.endTick==null?null:this.historyFrame(field,last.endTick,{atContact:true});
    if(contactFrame){
      const result=absorptions.get(last.id);
      collisionEvents.push({tick:last.endTick,otherBodyId:originalId(result?.continuedFrom),absorbed:true,wave:waveFor(result)});
    }
    const collisions=[...new Set(collisionEvents.map(event=>event.tick))];
    return {body:{...body,endTick:last.endTick},points,segments,collisions,collisionEvents,
      detailWindowTicks:stride>SAMPLE_TICKS?DETAIL_WINDOW_TICKS:0,...(contactFrame&&{contactFrame})};
  }
  historyFrame(field,tick,{atContact=false}={}){
    if(tick>=field.tick&&!atContact)return {tick:field.tick,bodies:field.currentBodies()};
    const before=this.db.prepare(`SELECT tick,x,y,z,vx,vy,vz FROM body_tracks WHERE user_id=? AND world_id=? AND body_id=? AND tick<=? ORDER BY tick DESC LIMIT 1`);
    const after=this.db.prepare(`SELECT tick,x,y,z,vx,vy,vz FROM body_tracks WHERE user_id=? AND world_id=? AND body_id=? AND tick>=? ORDER BY tick LIMIT 1`);
    const bodies=[];
    for(const body of field.catalog.values()){
      if(tick<body.birthTick||body.endTick!=null&&(tick>body.endTick||tick===body.endTick&&!atContact))continue;
      if(atContact&&body.birthTick===tick&&body.id.startsWith('merged-'))continue;
      const args=[field.userId,field.worldId,body.id,tick];
      const a=before.get(...args);
      if(!a)continue;
      const live=field.currentBodies().find(item=>item.id===body.id);
      const b=after.get(...args)??(live&&point(live,field.tick))??a;
      const t=a.tick===b.tick?0:(tick-a.tick)/(b.tick-a.tick);
      bodies.push({...body,...Object.fromEntries(['x','y','z','vx','vy','vz'].map(axis=>[axis,a[axis]+(b[axis]-a[axis])*t]))});
    }
    return {tick,bodies};
  }
}

module.exports={BodyFields,initialBodies,DETAIL_WINDOW_TICKS,LIVE_PATH_INTERVAL,LIVE_PATH_LIMIT};
