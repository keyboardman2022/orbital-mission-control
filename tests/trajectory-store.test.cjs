const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {Worker}=require('node:worker_threads');
const {createBackup}=require('../server/backup.js');
const storePath='../server/trajectory-store.js';
function fixture(t){
 const dir=fs.mkdtempSync(join(tmpdir(),'orbital-chunks-')),filename=join(dir,'orbital.sqlite'),db=new DatabaseSync(filename);
 db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE satellites(id TEXT PRIMARY KEY,record TEXT); CREATE TABLE points(satellite_id TEXT,seq INTEGER,tick INTEGER,elapsed REAL,x REAL,y REAL,vx REAL,vy REAL,kind TEXT,PRIMARY KEY(satellite_id,seq)); CREATE INDEX points_time ON points(satellite_id,tick); CREATE TABLE events(satellite_id TEXT,seq INTEGER,event TEXT);`);
 db.prepare('INSERT INTO satellites VALUES (?,?)').run('s',JSON.stringify({birthTick:100,status:'terminated'}));
 const original=Array.from({length:13},(_,i)=>({seq:i+1,tick:i===12?110:i*10,elapsedSeconds:i/3,x:Math.sin(i),y:i,vx:i/7,vy:i?-i:0,kind:i===0?'birth':i===12?'terminated':'sample'}));
 const insert=db.prepare('INSERT INTO points VALUES (?,?,?,?,?,?,?,?,?)');for(const p of original)insert.run('s',p.seq,p.tick,p.elapsedSeconds,p.x,p.y,p.vx,p.vy,p.kind);
 t.after(()=>{if(db.isOpen)db.close();fs.rmSync(dir,{recursive:true,force:true});});return {dir,filename,db,original};
}
function pages(store,f,options){let after=0,all=[];for(let i=0;i<100;i++){const page=store.readPoints(f.db,f.filename,{id:'s',after,limit:2,...options});assert.ok(page.length<=2);assert.equal(f.db.isTransaction,false);if(!page.length)return all;all.push(...page);after=page.at(-1).seq;}throw Error('pagination did not finish');}
test('store API exists',()=>{const s=require(storePath);assert.equal(typeof s.initializeStore,'function');assert.equal(typeof s.archiveBatch,'function');assert.equal(typeof s.readPoints,'function');});
test('cursor at or beyond fixed cutoff returns empty before opening a database snapshot',()=>{
 const s=require(storePath),db=new DatabaseSync(':memory:');try{
  // An exhausted sequence range needs no points table or archive lookup.
  assert.deepEqual(s.readPoints(db,'unused.sqlite',{id:'s',after:10,cutoffSeq:10,boundaries:true}),[]);
  assert.deepEqual(s.readPoints(db,'unused.sqlite',{id:'s',after:11,cutoffSeq:10,boundaries:true}),[]);assert.equal(db.isTransaction,false);
  assert.throws(()=>s.readPoints(db,'unused.sqlite',{id:'s',after:10,cutoffSeq:10,limit:0}),/parameters/);
 }finally{db.close();}
});
test('immutable chunks and hot rows roundtrip with bounded sequence pages and frozen cutoff',t=>{
 const s=require(storePath),f=fixture(t);s.initializeStore(f.db);
 const chunk=s.archiveBatch(f.db,f.filename,{cutoffWorldTick:180,maxPoints:3});assert.equal(chunk.count,3);
 while(s.archiveBatch(f.db,f.filename,{cutoffWorldTick:180,maxPoints:3})){}
 assert.equal(f.db.prepare('SELECT count(*) n FROM points').get().n,5);
 assert.deepEqual(pages(s,f,{cutoffSeq:10}),f.original.slice(0,10));
 assert.deepEqual(pages(s,f,{fromTick:35,toTick:75,boundaries:true}),f.original.slice(3,9));
 assert.deepEqual(pages(s,f,{fromTick:35,toTick:75,boundaries:true,cutoffSeq:7}),f.original.slice(3,7));
 while(s.archiveBatch(f.db,f.filename,{cutoffWorldTick:1000,maxPoints:3})){}
 assert.deepEqual(pages(s,f,{}),f.original);assert.equal(f.db.prepare('SELECT count(*) n FROM points').get().n,0);
 assert.deepEqual(pages(s,f,{fromTick:110,toTick:110,boundaries:true}),f.original.slice(10));
 assert.deepEqual(pages(s,f,{fromTick:111,toTick:119,boundaries:true}),f.original.slice(12));
 f.db.exec('BEGIN');assert.deepEqual(s.readPoints(f.db,f.filename,{id:'s',limit:1}),f.original.slice(0,1));assert.equal(f.db.isTransaction,true);f.db.exec('ROLLBACK');
});
test('archive corruption and escaping manifest paths fail loudly',t=>{
 const s=require(storePath),f=fixture(t);s.initializeStore(f.db);const c=s.archiveBatch(f.db,f.filename,{cutoffWorldTick:150});
 const path=join(f.dir,'trajectories',c.file),bytes=fs.readFileSync(path);fs.writeFileSync(path,Buffer.concat([bytes,Buffer.from('corrupt')]));
 assert.throws(()=>s.readPoints(f.db,f.filename,{id:'s'}),/checksum/i);
 f.db.prepare('UPDATE trajectory_chunks SET file=?').run('../orbital.sqlite');assert.throws(()=>s.readPoints(f.db,f.filename,{id:'s'}),/path/i);
});
test('manifest transaction failure retains exact hot rows and leaves a harmless verified orphan',t=>{
 const s=require(storePath),f=fixture(t);s.initializeStore(f.db);f.db.exec("CREATE TRIGGER reject_chunk BEFORE INSERT ON trajectory_chunks BEGIN SELECT RAISE(ABORT,'injected manifest failure'); END");
 assert.throws(()=>s.archiveBatch(f.db,f.filename,{cutoffWorldTick:180}),/injected manifest failure/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM trajectory_chunks').get().n,0);assert.equal(fs.readdirSync(join(f.dir,'trajectories')).length,1);assert.deepEqual(pages(s,f,{}),f.original);
 f.db.exec('DROP TRIGGER reject_chunk');s.archiveBatch(f.db,f.filename,{cutoffWorldTick:180});assert.deepEqual(pages(s,f,{}),f.original);
});
test('backup sidecar restores only referenced verified archives; corruption leaves no valid backup',async t=>{
 const s=require(storePath),f=fixture(t);s.initializeStore(f.db);const c=s.archiveBatch(f.db,f.filename,{cutoffWorldTick:180});
 fs.writeFileSync(join(f.dir,'trajectories','orphan.gz'),'unreferenced');const destination=join(f.dir,'backup.sqlite');await createBackup({source:f.filename,destination});
 assert.deepEqual(fs.readdirSync(destination+'.trajectories'),[c.file]);const restore=join(f.dir,'restore');fs.mkdirSync(restore);fs.copyFileSync(destination,join(restore,'orbital.sqlite'));fs.cpSync(destination+'.trajectories',join(restore,'trajectories'),{recursive:true});
 const restored=new DatabaseSync(join(restore,'orbital.sqlite'));try{assert.deepEqual(s.readPoints(restored,join(restore,'orbital.sqlite'),{id:'s'}),f.original);}finally{restored.close();}
 fs.appendFileSync(join(f.dir,'trajectories',c.file),'broken');const bad=join(f.dir,'bad.sqlite');await assert.rejects(createBackup({source:f.filename,destination:bad}),/checksum/i);assert.equal(fs.existsSync(bad),false);
});
test('worker exports archived birth and terminal points with fixed cutoff, events, sampling and SI',async t=>{
 const s=require(storePath),f=fixture(t);s.initializeStore(f.db);while(s.archiveBatch(f.db,f.filename,{cutoffWorldTick:1000,maxPoints:4})){}
 f.db.prepare('INSERT INTO events VALUES (?,?,?)').run('s',1,JSON.stringify({type:'terminated',tick:110}));
 const record={satelliteId:'s',cutoffTick:110,cutoffSeq:13,cutoffEventSeq:1,format:'json',createdAt:'test',sampling:{version:'test-sampler'},satellite:{name:'s',initial:{},state:{}},model:require('../shared/simulation.js').MODEL};
 const target=join(f.dir,'out.json'),worker=new Worker(join(__dirname,'../server/export-worker.js'),{workerData:{filename:f.filename,target,record}});const exit=new Promise(resolve=>worker.once('exit',resolve));const result=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});await exit;
 assert.equal(result.status,'ready',result.message);const output=JSON.parse(fs.readFileSync(target,'utf8'));assert.deepEqual(output.sampling,record.sampling);assert.deepEqual(output.points.map(p=>p.seq),f.original.map(p=>p.seq));assert.equal(output.points[0].kind,'birth');assert.equal(output.points.at(-1).kind,'terminated');assert.equal(output.events[0].type,'terminated');assert.ok(Number.isFinite(output.points[0].xKm));
});
test('chunks cap at 4096 and export crosses multiple pages without including later sequence',async t=>{
 const s=require(storePath),f=fixture(t);s.initializeStore(f.db);const insert=f.db.prepare('INSERT INTO points VALUES (?,?,?,?,?,?,?,?,?)');
 f.db.exec('BEGIN');for(let seq=14;seq<=5007;seq++)insert.run('s',seq,seq*10,seq/3,seq,-seq,1,2,'sample');f.db.exec('COMMIT');
 const c=s.archiveBatch(f.db,f.filename,{cutoffWorldTick:100000,maxPoints:9999});assert.equal(c.count,4096);
 assert.equal(s.readPoints(f.db,f.filename,{id:'s',limit:2000}).length,2000);
 const record={satelliteId:'s',cutoffTick:50070,cutoffSeq:5000,cutoffEventSeq:0,format:'json',createdAt:'test',satellite:{name:'s',initial:{},state:{},sampling:{version:'time-interpolation-v1',legacyThroughSeq:13}},model:require('../shared/simulation.js').MODEL};
 const target=join(f.dir,'paged.json'),worker=new Worker(join(__dirname,'../server/export-worker.js'),{workerData:{filename:f.filename,target,record}}),exit=new Promise(resolve=>worker.once('exit',resolve));
 const result=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});await exit;assert.equal(result.status,'ready',result.message);
 const output=JSON.parse(fs.readFileSync(target,'utf8'));assert.equal(output.points.length,5000);assert.deepEqual(output.points.map(p=>p.seq),Array.from({length:5000},(_,i)=>i+1));assert.equal(output.sampling.legacyThroughSeq,13);assert.equal(output.sampling.legacyPolicy.version,'legacy-adaptive-v1');assert.equal(output.sampling.legacyPolicy.linearPredictionErrorThreshold,.5);
});
test('late hot window uses a time range and whole-history next page resumes at cursor tick',t=>{
 const s=require(storePath),f=fixture(t);s.initializeStore(f.db);const insert=f.db.prepare('INSERT INTO points VALUES (?,?,?,?,?,?,?,?,?)');
 f.db.exec('BEGIN');for(let seq=14;seq<=40000;seq++)insert.run('s',seq,seq*10,seq/3,seq,-seq,1,2,'sample');f.db.exec('COMMIT');
 const prepare=f.db.prepare.bind(f.db),plans=[];
 // Observe the real SQLite plan and bindings of executed hot-page queries.
 f.db.prepare=sql=>{const statement=prepare(sql);if(sql.includes('elapsed AS elapsedSeconds')&&sql.includes('FROM points')&&sql.includes('LIMIT ?'))return {all(...bindings){plans.push({plan:prepare('EXPLAIN QUERY PLAN '+sql).all(...bindings),bindings});return statement.all(...bindings);}};return statement;};
 const late=s.readPoints(f.db,f.filename,{id:'s',fromTick:399800,toTick:400000,limit:100});assert.deepEqual(late.map(p=>p.seq),Array.from({length:21},(_,i)=>39980+i));
 const resumed=s.readPoints(f.db,f.filename,{id:'s',after:39990,limit:5});assert.deepEqual(resumed.map(p=>p.seq),[39991,39992,39993,39994,39995]);
 assert.equal(plans.length,2);for(const {plan} of plans)assert.ok(plan.some(row=>/USING INDEX points_time .*tick>\? AND tick<\?/.test(row.detail)),JSON.stringify(plan));
 assert.ok(plans[1].bindings.includes(399900),'the actual page time range must start at the cursor tick');
});
test('online backup pins one WAL snapshot while another connection keeps committing',async t=>{
 const s=require(storePath),f=fixture(t);s.initializeStore(f.db);s.archiveBatch(f.db,f.filename,{cutoffWorldTick:180});
 const insert=f.db.prepare('INSERT INTO points VALUES (?,?,?,?,?,?,?,?,?)');f.db.exec('BEGIN');for(let seq=14;seq<=20000;seq++)insert.run('s',seq,seq*10,seq/3,seq,-seq,1,2,'sample');f.db.exec('COMMIT');
 const before=f.db.prepare('SELECT x FROM points WHERE satellite_id=? AND seq=?').get('s',13).x,destination=join(f.dir,'snapshot.sqlite');
 const pending=createBackup({source:f.filename,destination,rate:1});
 f.db.prepare('UPDATE points SET x=? WHERE satellite_id=? AND seq=?').run(9999,'s',13);
 let writes=1;const interval=setInterval(()=>{f.db.prepare('UPDATE points SET x=? WHERE satellite_id=? AND seq=?').run(9999+writes++,'s',13);},1);
 const stop=setTimeout(()=>clearInterval(interval),250);
 try{await pending;}finally{clearTimeout(stop);clearInterval(interval);}
 const restored=new DatabaseSync(destination,{readOnly:true});try{assert.equal(restored.prepare('SELECT x FROM points WHERE satellite_id=? AND seq=?').get('s',13).x,before);assert.equal(restored.prepare('SELECT count(*) n FROM trajectory_chunks').get().n,1);}finally{restored.close();}
 assert.notEqual(f.db.prepare('SELECT x FROM points WHERE satellite_id=? AND seq=?').get('s',13).x,before);assert.ok(writes>1,'writer remains active while incremental backup runs');
});
