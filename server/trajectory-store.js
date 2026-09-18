'use strict';
const fs=require('node:fs');
const {dirname,join,basename}=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {gzipSync,gunzipSync}=require('node:zlib');
const MAX_POINTS=4096,MAX_BYTES=4*1024*1024;
const columns='seq,tick,elapsed AS elapsedSeconds,x,y,vx,vy,kind';
const checksum=bytes=>createHash('sha256').update(bytes).digest('hex');
function initializeStore(db){db.exec(`CREATE TABLE IF NOT EXISTS trajectory_chunks(
 satellite_id TEXT NOT NULL REFERENCES satellites(id),first_seq INTEGER NOT NULL,last_seq INTEGER NOT NULL,
 first_tick INTEGER NOT NULL,last_tick INTEGER NOT NULL,count INTEGER NOT NULL CHECK(count BETWEEN 1 AND 4096),
 file TEXT NOT NULL UNIQUE,checksum TEXT NOT NULL,PRIMARY KEY(satellite_id,first_seq));
 CREATE INDEX IF NOT EXISTS trajectory_chunks_time ON trajectory_chunks(satellite_id,first_tick,last_tick);`);}
function hasStore(db){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trajectory_chunks'").get();}
function archivePath(filename,file){
 if(typeof file!=='string'||file!==basename(file)||!/^[a-f0-9-]+\.json\.gz$/.test(file))throw Error('Invalid trajectory archive path');
 const directory=join(dirname(filename),'trajectories');
 if(fs.existsSync(directory)&&fs.lstatSync(directory).isSymbolicLink())throw Error('Invalid trajectory archive directory path');
 const path=join(directory,file);if(fs.existsSync(path)&&fs.lstatSync(path).isSymbolicLink())throw Error('Invalid trajectory archive file path');return path;
}
function readChunk(filename,manifest){
 const path=archivePath(filename,manifest.file),size=fs.statSync(path).size;if(size>MAX_BYTES)throw Error('Trajectory archive size limit exceeded');
 const compressed=fs.readFileSync(path);if(checksum(compressed)!==manifest.checksum)throw Error('Trajectory archive checksum mismatch');
 const points=JSON.parse(gunzipSync(compressed,{maxOutputLength:MAX_BYTES}).toString('utf8'));
 if(!Array.isArray(points)||points.length!==manifest.count||points.length<1||points.length>MAX_POINTS)throw Error('Invalid trajectory archive point count');
 let seq=0,tick=-1;
 for(const p of points){if(!Number.isSafeInteger(p.seq)||p.seq<=seq||!Number.isSafeInteger(p.tick)||p.tick<tick||!['elapsedSeconds','x','y','vx','vy'].every(k=>Number.isFinite(p[k]))||typeof p.kind!=='string')throw Error('Invalid trajectory archive point');seq=p.seq;tick=p.tick;}
 if(points[0].seq!==manifest.first_seq||points.at(-1).seq!==manifest.last_seq||points[0].tick!==manifest.first_tick||points.at(-1).tick!==manifest.last_tick)throw Error('Trajectory archive manifest mismatch');return points;
}
function readTransaction(db,fn){const own=!db.isTransaction;if(own)db.exec('BEGIN');try{const result=fn();if(own)db.exec('COMMIT');return result;}catch(error){if(own)db.exec('ROLLBACK');throw error;}}
function readPoints(db,filename,{id,after=0,fromTick=0,toTick=Number.MAX_SAFE_INTEGER,cutoffSeq=Number.MAX_SAFE_INTEGER,limit=1000,boundaries=false}={}){
 if(typeof id!=='string'||![after,fromTick,toTick,cutoffSeq,limit].every(Number.isSafeInteger)||after<0||fromTick<0||toTick<fromTick||cutoffSeq<0||limit<1||limit>5001)throw Error('Invalid trajectory read parameters');
 if(after>=cutoffSeq)return [];
 const snapshot=readTransaction(db,()=>{
  const archivedStore=hasStore(db);let lowerTick=fromTick;
  if(after>0){
   const cursor=db.prepare('SELECT tick FROM points WHERE satellite_id=? AND seq=?').get(id,after);
   const archivedCursor=!cursor&&archivedStore?db.prepare('SELECT first_tick FROM trajectory_chunks WHERE satellite_id=? AND first_seq<=? AND last_seq>=? ORDER BY first_seq DESC LIMIT 1').get(id,after,after):null;
   lowerTick=Math.max(lowerTick,cursor?.tick??archivedCursor?.first_tick??0);
  }
  // Trajectory ticks are monotonic with seq; order equal-tick lifecycle points by seq.
  const hot=db.prepare(`SELECT ${columns} FROM points INDEXED BY points_time WHERE satellite_id=? AND seq>? AND seq<=? AND tick>=? AND tick<=? ORDER BY tick,seq LIMIT ?`).all(id,after,cutoffSeq,lowerTick,toTick,limit);
  let before,afterWindow,manifests=[],beforeManifest,afterManifest;
  if(boundaries){before=db.prepare(`SELECT ${columns} FROM points WHERE satellite_id=? AND seq<=? AND tick<? ORDER BY tick DESC,seq DESC LIMIT 1`).get(id,cutoffSeq,fromTick);afterWindow=db.prepare(`SELECT ${columns} FROM points WHERE satellite_id=? AND seq<=? AND tick>? ORDER BY tick,seq LIMIT 1`).get(id,cutoffSeq,toTick);}
  if(archivedStore){
   manifests=db.prepare(`SELECT * FROM trajectory_chunks WHERE satellite_id=? AND first_seq>=COALESCE((SELECT first_seq FROM trajectory_chunks WHERE satellite_id=? AND first_seq<=? ORDER BY first_seq DESC LIMIT 1),0) AND last_seq>? AND first_seq<=? AND last_tick>=? AND first_tick<=? ORDER BY first_seq LIMIT ?`).all(id,id,after,after,cutoffSeq,fromTick,toTick,limit);
   if(boundaries){beforeManifest=db.prepare('SELECT * FROM trajectory_chunks WHERE satellite_id=? AND first_seq<=? AND first_tick<? ORDER BY first_seq DESC LIMIT 1').get(id,cutoffSeq,fromTick);afterManifest=db.prepare('SELECT * FROM trajectory_chunks WHERE satellite_id=? AND first_seq<=? AND last_tick>? ORDER BY first_seq LIMIT 1').get(id,cutoffSeq,toTick);}
  }
  return {hot,before,afterWindow,manifests,beforeManifest,afterManifest};
 });
 // Immutable files remain available after releasing the short database snapshot.
 const cache=new Map(),load=m=>{if(!cache.has(m.file))cache.set(m.file,readChunk(filename,m));return cache.get(m.file);};
 const candidates=[...snapshot.hot];let archived=0;
 for(const m of snapshot.manifests){for(const p of load(m)){if(p.seq>after&&p.seq<=cutoffSeq&&p.tick>=fromTick&&p.tick<=toTick){candidates.push(p);if(++archived>=limit)break;}}if(archived>=limit)break;}
 if(boundaries){
  let before=snapshot.before,next=snapshot.afterWindow;
  if(snapshot.beforeManifest)for(const p of load(snapshot.beforeManifest))if(p.seq<=cutoffSeq&&p.tick<fromTick&&(!before||p.seq>before.seq))before=p;
  if(snapshot.afterManifest)for(const p of load(snapshot.afterManifest))if(p.seq<=cutoffSeq&&p.tick>toTick&&(!next||p.seq<next.seq))next=p;
  if(before&&before.seq>after)candidates.push(before);if(next&&next.seq>after)candidates.push(next);
 }
 return [...new Map(candidates.map(p=>[p.seq,p])).values()].sort((a,b)=>a.seq-b.seq).slice(0,limit).map(p=>({...p}));
}
function archiveBatch(db,filename,{cutoffWorldTick,maxPoints=MAX_POINTS}={}){
 if(!Number.isSafeInteger(cutoffWorldTick)||cutoffWorldTick<0||!Number.isSafeInteger(maxPoints)||maxPoints<1)throw Error('Invalid trajectory archive parameters');
 if(db.isTransaction)throw Error('Archive requires its own transaction');initializeStore(db);maxPoints=Math.min(maxPoints,MAX_POINTS);
 const oldest=db.prepare(`SELECT s.id AS satellite_id,json_extract(s.record,'$.birthTick') AS birth_tick FROM satellites s WHERE json_extract(s.record,'$.birthTick') IS NOT NULL AND EXISTS(SELECT 1 FROM points p WHERE p.satellite_id=s.id AND p.tick<?-json_extract(s.record,'$.birthTick')) LIMIT 1`).get(cutoffWorldTick);
 if(!oldest)return null;
 const points=db.prepare(`SELECT ${columns} FROM points WHERE satellite_id=? AND tick<? ORDER BY seq LIMIT ?`).all(oldest.satellite_id,cutoffWorldTick-oldest.birth_tick,maxPoints);
 const compressed=gzipSync(Buffer.from(JSON.stringify(points))),digest=checksum(compressed),file=digest+'-'+randomUUID()+'.json.gz';
 const manifest={satellite_id:oldest.satellite_id,first_seq:points[0].seq,last_seq:points.at(-1).seq,first_tick:points[0].tick,last_tick:points.at(-1).tick,count:points.length,file,checksum:digest};
 const directory=join(dirname(filename),'trajectories');fs.mkdirSync(directory,{recursive:true});const path=archivePath(filename,file),temporary=path+'.partial';
 let fd;try{fd=fs.openSync(temporary,'wx');fs.writeFileSync(fd,compressed);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,path);readChunk(filename,manifest);
  // POSIX persists the directory rename; Windows does not support fsync of directories.
  if(process.platform!=='win32'){const directoryFd=fs.openSync(directory,'r');try{fs.fsyncSync(directoryFd);}finally{fs.closeSync(directoryFd);}}
 }catch(error){if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temporary);}catch{}throw error;}
 db.exec('BEGIN IMMEDIATE');try{
  db.prepare('INSERT INTO trajectory_chunks VALUES (?,?,?,?,?,?,?,?)').run(...['satellite_id','first_seq','last_seq','first_tick','last_tick','count','file','checksum'].map(k=>manifest[k]));
  const remove=db.prepare('DELETE FROM points WHERE satellite_id=? AND seq=?');for(const p of points){const result=remove.run(oldest.satellite_id,p.seq);if(result.changes!==1)throw Error('Trajectory archive source changed');}
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}return manifest;
}
module.exports={initializeStore,readPoints,archiveBatch,archivePath,readChunk,hasStore};
