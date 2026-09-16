'use strict';
const {DatabaseSync,backup}=require('node:sqlite');
const {resolve,join}=require('node:path');
const {mkdirSync,existsSync}=require('node:fs');
async function createBackup({source=process.env.ORBITAL_DATA_DIR?join(process.env.ORBITAL_DATA_DIR,'orbital.sqlite'):resolve(__dirname,'../data/orbital.sqlite'),destination}={}){
  const dir=resolve(__dirname,'../backups');if(!destination){mkdirSync(dir,{recursive:true});destination=join(dir,'orbital-'+new Date().toISOString().replaceAll(':','-')+'.sqlite');}
  destination=resolve(destination);if(existsSync(destination))throw new Error('备份目标已存在，拒绝覆盖');
  const db=new DatabaseSync(resolve(source),{readOnly:true});
  try{await backup(db,destination);}finally{db.close();}
  const restored=new DatabaseSync(destination,{readOnly:true});try{const check=restored.prepare('PRAGMA integrity_check').get();if(check.integrity_check!=='ok')throw new Error('备份完整性检查失败');}finally{restored.close();}
  return destination;
}
if(require.main===module)createBackup({destination:process.argv[2]}).then(path=>console.log('备份完成：'+path)).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={createBackup};
