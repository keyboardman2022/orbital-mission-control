'use strict';

const CHUNK=8192;

function removeSatelliteRows(db,userId,ids,removePoints){
  const archives=[],exportIds=[];
  const findArchives=db.prepare('SELECT file FROM trajectory_chunks WHERE satellite_id=?');
  const findExports=db.prepare('SELECT id FROM exports WHERE satellite_id=?');
  const tables=removePoints?['exports','events','trajectory_chunks']:['exports','events','points','trajectory_chunks'];
  const removeChildren=tables.map(table=>db.prepare(`DELETE FROM ${table} WHERE satellite_id=?`));
  const remove=db.prepare('DELETE FROM satellites WHERE id=? AND user_id=?');
  for(const id of ids){
    for(const row of findArchives.iterate(id))archives.push(row.file);
    for(const row of findExports.iterate(id))exportIds.push(row.id);
    removePoints?.(id);
    for(const statement of removeChildren)statement.run(id);
    if(remove.run(id,userId).changes!==1)throw Object.assign(new Error('找不到该卫星'),{status:404});
  }
  return {archives,exportIds};
}

function writeMapSwitch(db,store,plan,progress){
  const {userId,fromWorldId,toWorldId,switchId,ids,clock}=plan;
  const bodyCount=db.prepare('SELECT count(*) n FROM body_tracks WHERE user_id=? AND world_id=?');
  const pointCount=db.prepare('SELECT count(*) n FROM points WHERE satellite_id=?');
  progress({stage:'counting'});
  const total=bodyCount.get(userId,fromWorldId).n+ids.reduce((sum,id)=>sum+pointCount.get(id).n,0);
  let removed=0,lastReport=0;
  const report=(count=0,force=false)=>{
    removed+=count;
    const now=performance.now();
    if(force||now-lastReport>=100){
      progress({stage:'tracks',removed,total});
      lastReport=now;
    }
  };
  const pointEdge=db.prepare('SELECT seq FROM points WHERE satellite_id=? ORDER BY seq LIMIT 1 OFFSET ?');
  const pointDelete=db.prepare('DELETE FROM points WHERE satellite_id=? AND seq<=?');
  const pointsRemaining=db.prepare('DELETE FROM points WHERE satellite_id=?');
  const bodyEdge=db.prepare('SELECT body_id,tick FROM body_tracks WHERE user_id=? AND world_id=? ORDER BY body_id,tick LIMIT 1 OFFSET ?');
  const bodyDelete=db.prepare('DELETE FROM body_tracks WHERE user_id=? AND world_id=? AND (body_id,tick)<=(?,?)');
  const bodiesRemaining=db.prepare('DELETE FROM body_tracks WHERE user_id=? AND world_id=?');

  db.exec('BEGIN IMMEDIATE');
  try{
    report(0,true);
    const files=removeSatelliteRows(db,userId,ids,id=>{
      for(let edge;(edge=pointEdge.get(id,CHUNK-1));)report(pointDelete.run(id,edge.seq).changes);
      report(pointsRemaining.run(id).changes);
    });
    for(let edge;(edge=bodyEdge.get(userId,fromWorldId,CHUNK-1));){
      report(bodyDelete.run(userId,fromWorldId,edge.body_id,edge.tick).changes);
    }
    report(bodiesRemaining.run(userId,fromWorldId).changes,true);
    db.prepare('DELETE FROM body_fields WHERE user_id=? AND world_id=?').run(userId,fromWorldId);
    if(clock)store.writeClock(plan.clockKey,clock);
    const cleanup=ids.length||clock?{ids,...files}:null;
    db.prepare('INSERT INTO map_switches VALUES (?,?,?,?,?,?)').run(userId,switchId,fromWorldId,toWorldId,ids.length,cleanup&&JSON.stringify(cleanup));
    progress({stage:'commit'});
    db.exec('COMMIT');
    return {deleted:ids.length,cleanup};
  }catch(error){
    if(db.isTransaction)db.exec('ROLLBACK');
    throw error;
  }
}

module.exports={removeSatelliteRows,writeMapSwitch};
