'use strict';
const {DatabaseSync}=require('node:sqlite');
const {existsSync,lstatSync,unlinkSync}=require('node:fs');
const {dirname,join}=require('node:path');
const {archivePath}=require('./trajectory-store.js');

const cleanupKey='flat-map-file-cleanup';
const exportSuffixes=['.json','.csv','.json.partial','.csv.partial'];
function unlinkIfPresent(file){
  try{unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}
}

// Run before the simulation loads records, while the server owns the data directory.
function purgeFlatMaps(filename,{archiveDir,exportDir=join(dirname(filename),'exports')}={}){
  if(!existsSync(filename))return {flights:0,worlds:0};
  const db=new DatabaseSync(filename);
  try{
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;');
    const tables=new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row=>row.name));
    if(!tables.has('satellites'))return {flights:0,worlds:0};
    const pending=db.prepare('SELECT value FROM meta WHERE key=?').get(cleanupKey);
    const cleanup=pending?JSON.parse(pending.value):{archives:[],exports:[]};
    let flights=0,worlds=0;
    db.exec('BEGIN IMMEDIATE');
    try{
      db.exec(`CREATE TEMP TABLE flat_flights(id TEXT PRIMARY KEY);
        INSERT INTO flat_flights SELECT id FROM satellites
        WHERE COALESCE(json_extract(record,'$.initial.dimension'),2)=2;`);
      const flat='satellite_id IN (SELECT id FROM flat_flights)';
      if(tables.has('trajectory_chunks'))cleanup.archives.push(...db.prepare(`SELECT file FROM trajectory_chunks WHERE ${flat}`).all().map(row=>row.file));
      if(tables.has('exports'))cleanup.exports.push(...db.prepare(`SELECT id FROM exports WHERE ${flat}`).all().map(row=>row.id));
      for(const table of ['exports','events','points','trajectory_chunks','satellite_worlds']){
        if(tables.has(table))db.exec(`DELETE FROM ${table} WHERE ${flat}`);
      }
      flights=Number(db.prepare('DELETE FROM satellites WHERE id IN (SELECT id FROM flat_flights)').run().changes);
      if(tables.has('worlds')){
        const unreferenced=tables.has('satellite_worlds')
          ? 'AND NOT EXISTS (SELECT 1 FROM satellite_worlds WHERE world_id=worlds.id)' : '';
        worlds=Number(db.prepare(`DELETE FROM worlds WHERE json_extract(config,'$.layout') IS NULL ${unreferenced}`).run().changes);
      }
      if(flights||worlds)db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(cleanupKey,JSON.stringify(cleanup));
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}

    if(pending||flights||worlds){
      for(const file of cleanup.archives)unlinkIfPresent(archivePath(filename,file,archiveDir));
      if(cleanup.exports.length&&existsSync(exportDir)&&lstatSync(exportDir).isSymbolicLink())throw new Error('Invalid export directory path');
      for(const id of cleanup.exports){
        if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid export ID');
        for(const suffix of exportSuffixes)unlinkIfPresent(join(exportDir,id+suffix));
      }
      db.exec('VACUUM');
      db.prepare('DELETE FROM meta WHERE key=?').run(cleanupKey);
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }
    return {flights,worlds};
  }finally{db.close();}
}
module.exports={purgeFlatMaps};
