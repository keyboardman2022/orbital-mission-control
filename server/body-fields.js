'use strict';
const Model=require('../shared/simulation.js');
const Generator=require('../shared/world-generator.js');
const {createSimulation}=require('../shared/nbody.js');

const SAMPLE_TICKS=480;
const RATE=Model.MODEL.tickRate;
const key=(userId,worldId)=>`${userId}:${worldId}`;
const point=(body,tick)=>({tick,x:body.x,y:body.y,z:body.z,vx:body.vx,vy:body.vy,vz:body.vz});
const meta=(body,birthTick)=>({id:body.id,name:body.name,kind:body.kind,color:body.color,...(body.bodyClass?{bodyClass:body.bodyClass}:{}),
  radius:body.radius,massSolar:body.mass,systemId:body.systemId,birthTick,endTick:null});

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
  const frames=new Map();
  function frame(){
    frames.set(tick,sim.bodies.map(body=>({...body})));
    if(frames.size>4)frames.delete(frames.keys().next().value);
  }
  const sample=(body,at)=>tracks.push({id:body.id,...point(body,at)});
  frame();
  if(!saved)for(const body of sim.bodies)sample(body,0);
  function advanceTo(target){
    while(tick<target){
      sim.step(1/RATE);tick++;dirty=true;
      for(;seen<sim.collisions.length;seen++){
        const {first,second,result,time}=sim.collisions[seen];
        const at=Math.min(tick,time*RATE);
        for(const body of [first,second]){
          catalog.get(body.id).endTick=at;
          sample(body,at);
        }
        catalog.set(result.id,meta(result,at));sample(result,at);
      }
      if(tick%SAMPLE_TICKS===0)for(const body of sim.bodies)sample(body,tick);
      frame();
    }
  }
  function at(time){
    const start=frames.get(Math.floor(time))??frames.get(tick);
    if(Number.isInteger(time))return start;
    const fraction=(time-Math.floor(time))/RATE;
    return start.map(body=>({...body,x:body.x+body.vx*fraction,y:body.y+body.vy*fraction,z:body.z+body.vz*fraction}));
  }
  return {userId,worldId,tracks,catalog,advanceTo,at,runtime:Model.createRuntime(world,at),
    get tick(){return tick;},get dirty(){return dirty;},
    snapshot:()=>({tick,nextId:sim.nextId,bodies:frames.get(tick),catalog:[...catalog.values()]}),
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
    this.save=db.prepare('INSERT INTO body_fields VALUES (?,?,?) ON CONFLICT(user_id,world_id) DO UPDATE SET state=excluded.state');
    this.insert=db.prepare('INSERT OR REPLACE INTO body_tracks VALUES (?,?,?,?,?,?,?,?,?,?)');
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
  flush(){
    for(const field of this.fields.values())if(field.dirty){
      const {userId,worldId}=field;
      this.save.run(userId,worldId,JSON.stringify(field.serialize()));
      for(const p of field.tracks)this.insert.run(userId,worldId,p.id,p.tick,p.x,p.y,p.z,p.vx,p.vy,p.vz);
    }
  }
  committed(){for(const field of this.fields.values())field.committed();}
  trajectory(field,id){
    const body=field.catalog.get(id);
    if(!body)return null;
    const scope=[field.userId,field.worldId,id];
    const stride=Math.max(1,Math.ceil((field.tick-body.birthTick)/SAMPLE_TICKS/1400))*SAMPLE_TICKS;
    const points=this.db.prepare(`SELECT tick,x,y,z,vx,vy,vz FROM body_tracks
      WHERE user_id=? AND world_id=? AND body_id=? AND (tick=? OR tick=? OR (tick=CAST(tick AS INTEGER) AND CAST(tick AS INTEGER)%?=0)) ORDER BY tick`)
      .all(...scope,body.birthTick,body.endTick,stride);
    const live=field.at(field.tick).find(item=>item.id===id);
    if(live&&points.at(-1)?.tick!==field.tick)points.push(point(live,field.tick));
    return {body,points};
  }
  historyFrame(field,tick){
    if(tick>=field.tick)return {tick:field.tick,bodies:field.at(field.tick)};
    const before=this.db.prepare(`SELECT tick,x,y,z,vx,vy,vz FROM body_tracks WHERE user_id=? AND world_id=? AND body_id=? AND tick<=? ORDER BY tick DESC LIMIT 1`);
    const after=this.db.prepare(`SELECT tick,x,y,z,vx,vy,vz FROM body_tracks WHERE user_id=? AND world_id=? AND body_id=? AND tick>=? ORDER BY tick LIMIT 1`);
    const bodies=[];
    for(const body of field.catalog.values()){
      if(tick<body.birthTick||body.endTick!=null&&tick>=body.endTick)continue;
      const args=[field.userId,field.worldId,body.id,tick];
      const a=before.get(...args);
      if(!a)continue;
      const live=field.at(field.tick).find(item=>item.id===body.id);
      const b=after.get(...args)??(live&&point(live,field.tick))??a;
      const t=a.tick===b.tick?0:(tick-a.tick)/(b.tick-a.tick);
      bodies.push({...body,...Object.fromEntries(['x','y','z','vx','vy','vz'].map(axis=>[axis,a[axis]+(b[axis]-a[axis])*t]))});
    }
    return {tick,bodies};
  }
}

module.exports={BodyFields,initialBodies};
