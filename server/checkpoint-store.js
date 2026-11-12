'use strict';

function createCheckpointStore(db){
  const point=db.prepare('INSERT INTO points(satellite_id,seq,tick,elapsed,x,y,vx,vy,kind,z,vz) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const event=db.prepare('INSERT INTO events VALUES (?,?,?)');
  const record=db.prepare('UPDATE satellites SET record=? WHERE id=?');
  const clock=db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)');
  const field=db.prepare('INSERT INTO body_fields VALUES (?,?,?) ON CONFLICT(user_id,world_id) DO UPDATE SET state=excluded.state');
  const track=db.prepare('INSERT OR REPLACE INTO body_tracks VALUES (?,?,?,?,?,?,?,?,?,?)');

  function insertPoint(id,p){
    point.run(id,p.seq,p.tick,p.elapsedSeconds,p.x,p.y,p.vx,p.vy,p.kind,p.z??null,p.vz??null);
  }

  function write(batch,extra){
    db.exec('BEGIN IMMEDIATE');
    try{
      for(const {id,p} of batch.points)insertPoint(id,p);
      for(const e of batch.events)event.run(e.id,e.seq,JSON.stringify(e.event));
      for(const r of batch.records)record.run(JSON.stringify(r),r.id);
      for(const {userId,worldId,state,tracks} of batch.fields){
        field.run(userId,worldId,JSON.stringify(state));
        for(const p of tracks)track.run(userId,worldId,p.id,p.tick,p.x,p.y,p.z,p.vx,p.vy,p.vz);
      }
      extra?.();
      clock.run('clock',JSON.stringify(batch.clock));
      db.exec('COMMIT');
    }catch(error){
      if(db.isTransaction)db.exec('ROLLBACK');
      throw error;
    }
  }

  return {insertPoint,write,writeClock:(key,value)=>clock.run(key,JSON.stringify(value))};
}

module.exports={createCheckpointStore};
