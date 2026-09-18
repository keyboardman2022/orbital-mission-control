'use strict';
const {DatabaseSync,backup}=require('node:sqlite');
const {resolve,join,dirname}=require('node:path');
const {mkdirSync,existsSync,renameSync,rmSync,copyFileSync,readFileSync}=require('node:fs');
const {randomUUID,createHash}=require('node:crypto');
const {hasStore,archivePath,readChunk}=require('./trajectory-store.js');
async function createBackup({source=process.env.ORBITAL_DATA_DIR?join(process.env.ORBITAL_DATA_DIR,'orbital.sqlite'):resolve(__dirname,'../data/orbital.sqlite'),destination,rate=2048}={}){
  if(!Number.isSafeInteger(rate)||rate<1)throw Error('Invalid backup page rate');
  const dir=resolve(__dirname,'../backups');if(!destination){mkdirSync(dir,{recursive:true});destination=join(dir,'orbital-'+new Date().toISOString().replaceAll(':','-')+'.sqlite');}
  destination=resolve(destination);source=resolve(source);const sidecar=destination+'.trajectories';if(existsSync(destination)||existsSync(sidecar))throw new Error('备份目标已存在，拒绝覆盖');
  const temporary=destination+'.'+randomUUID()+'.partial',staging=temporary+'.trajectories';let sidecarPublished=false;
  const cleanupDirectory=path=>{const absolute=resolve(path);if(dirname(absolute)!==dirname(destination)||absolute===dirname(destination))throw Error('Unsafe backup cleanup path');rmSync(absolute,{recursive:true,force:true});};
  try{
   const db=new DatabaseSync(source,{readOnly:true});try{
    // Pin a WAL snapshot so commits on the simulation connection cannot restart copying.
    db.exec('BEGIN');db.prepare('SELECT rootpage FROM sqlite_master LIMIT 1').get();
    await backup(db,temporary,{rate});db.exec('COMMIT');
   }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}
   const restored=new DatabaseSync(temporary,{readOnly:true});let manifests;
   try{const check=restored.prepare('PRAGMA integrity_check').get();if(check.integrity_check!=='ok')throw new Error('备份完整性检查失败');manifests=hasStore(restored)?restored.prepare('SELECT * FROM trajectory_chunks ORDER BY satellite_id,first_seq').all():[];}finally{restored.close();}
   mkdirSync(staging);
   for(const manifest of manifests){
    readChunk(source,manifest);const target=join(staging,manifest.file);copyFileSync(archivePath(source,manifest.file),target);
    if(createHash('sha256').update(readFileSync(target)).digest('hex')!==manifest.checksum)throw Error('Backup trajectory archive checksum mismatch');
   }
   renameSync(staging,sidecar);sidecarPublished=true;renameSync(temporary,destination);return destination;
  }catch(error){rmSync(temporary,{force:true});cleanupDirectory(staging);if(sidecarPublished)cleanupDirectory(sidecar);throw error;}
}
if(require.main===module)createBackup({destination:process.argv[2]}).then(path=>console.log('备份完成：'+path)).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={createBackup};
