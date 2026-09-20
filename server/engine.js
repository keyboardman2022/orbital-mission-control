'use strict';
const {DatabaseSync}=require('node:sqlite');
const {randomUUID,randomBytes,createHash}=require('node:crypto');
const M=require('../shared/simulation.js');
const U=require('../shared/units.js');
const {createSampler,POLICY}=require('./trajectory-sampler.js');
const Budget=require('./trajectory-budget.js');
const {initializeStore,readPoints,archiveBatch}=require('./trajectory-store.js');
const {statSync}=require('node:fs');
const hash=value=>createHash('sha256').update(String(value)).digest('hex');
const secret=()=>randomBytes(32).toString('base64url');
function fail(status,message){throw Object.assign(new Error(message),{status});}
function integer(value,fallback,min=0,max=Number.MAX_SAFE_INTEGER){
  if(value===undefined||value===null||value==='')return fallback;
  const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)fail(422,'无效的分页或时间参数');return n;
}
class Engine{
  constructor({filename,now=Date.now,maxActive=1000,velocityRelativeTolerance=.001,trajectoryMaxPoints=Budget.DEFAULT_MAX_POINTS}){
    if(!Number.isFinite(velocityRelativeTolerance)||velocityRelativeTolerance<0||velocityRelativeTolerance>.01)throw new Error('速度相对记录容差须在0–0.01范围内');
    this.samplingPolicy={...POLICY,velocityRelativeTolerance};
    this.filename=filename;this.samplers=new Map();
    this.metrics={rawSteps:0,savedPoints:0,checkpointMs:0,checkpointMaxMs:0,archivedPoints:0,archiveMs:0,archiveError:null};
    this.maxActive=maxActive;
    this.trajectoryPolicy=Budget.createPolicy(trajectoryMaxPoints);
    this.now=now;this.db=new DatabaseSync(filename);this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,recovery_hash TEXT UNIQUE NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS satellites(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),created_ms INTEGER NOT NULL,idem TEXT NOT NULL,request_hash TEXT NOT NULL,record TEXT NOT NULL,UNIQUE(user_id,idem));
      CREATE INDEX IF NOT EXISTS satellites_owner ON satellites(user_id,created_ms);
      CREATE TABLE IF NOT EXISTS points(satellite_id TEXT NOT NULL REFERENCES satellites(id),seq INTEGER NOT NULL,tick INTEGER NOT NULL,elapsed REAL NOT NULL,x REAL NOT NULL,y REAL NOT NULL,vx REAL NOT NULL,vy REAL NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(satellite_id,seq));
      CREATE INDEX IF NOT EXISTS points_time ON points(satellite_id,tick);
      CREATE TABLE IF NOT EXISTS events(satellite_id TEXT NOT NULL REFERENCES satellites(id),seq INTEGER NOT NULL,event TEXT NOT NULL,PRIMARY KEY(satellite_id,seq));
      CREATE TABLE IF NOT EXISTS exports(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),satellite_id TEXT NOT NULL REFERENCES satellites(id),record TEXT NOT NULL);
    `);
    initializeStore(this.db);
    this.sql={point:this.db.prepare('INSERT INTO points VALUES (?,?,?,?,?,?,?,?,?)'),event:this.db.prepare('INSERT INTO events VALUES (?,?,?)'),record:this.db.prepare('UPDATE satellites SET record=? WHERE id=?'),clock:this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)')};
    const meta=this.db.prepare('SELECT value FROM meta WHERE key=?');
    const config=meta.get('model');
    if(config&&JSON.parse(config.value).version!==M.MODEL.version)throw new Error('数据库模型版本与程序不匹配，拒绝静默迁移');
    if(!config)this.db.prepare('INSERT INTO meta VALUES (?,?)').run('model',JSON.stringify(M.MODEL));
    const clock=meta.get('clock');
    const saved=clock?JSON.parse(clock.value):{epochMs:this.now(),tick:0};
    this.epochMs=saved.epochMs;this.tick=saved.tick;this.lastGoodWallMs=saved.savedWallMs||this.now();this.clockError=this.now()<this.lastGoodWallMs-1000?'系统时钟早于最近保存时刻，请校准后重启':null;
    this.records=new Map();this.dirty=new Set();this.pending=[];this.pendingEvents=[];
    for(const row of this.db.prepare('SELECT record FROM satellites').iterate()){
      const r=JSON.parse(row.record);if(r.status==='active'||r.status==='queued'){
        const budgetBefore=JSON.stringify(r.trajectoryBudget);Budget.ensure(r,this.trajectoryPolicy);
        if(JSON.stringify(r.trajectoryBudget)!==budgetBefore)this.dirty.add(r.id);
        // Keep all committed coordinates/times; extend tracking only for live records.
        if(!r.state.continuousTracking){r.state.continuousTracking=true;this.dirty.add(r.id);}
        this.records.set(r.id,r);
        if(Math.hypot(r.state.x,r.state.y)>M.MODEL.observation.radius){
          r.state.event={type:'out_of_observable',substepFraction:0,x:r.state.x,y:r.state.y,elapsedSeconds:r.state.elapsedSeconds};
          this.finish(r,'out_of_observable');continue;
        }
        if(r.status==='active')this.ensureSampler(r);
      }
    }
    this.checkpoint();
  }
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  targetTick(){return Math.max(this.tick,Math.floor((this.now()-this.epochMs)*M.MODEL.tickRate/1000));}
  health(){
    if(!this.diskCheckedAt||performance.now()-this.diskCheckedAt>1000){this.diskCheckedAt=performance.now();const size=path=>{try{return statSync(path).size;}catch{return 0;}};this.diskMetrics={databaseBytes:size(this.filename),walBytes:size(this.filename+'-wal')};}
    return {tick:this.tick,lagSeconds:Math.max(0,this.targetTick()-this.tick)/M.MODEL.tickRate,status:this.clockError?'clock_error':this.targetTick()-this.tick>120?'recovering':'running',active:this.records.size,clockError:this.clockError,storage:{...this.metrics,...this.diskMetrics,bufferedStates:[...this.samplers.values()].reduce((sum,s)=>sum+s.size-1,0),pendingPoints:this.pending.length}};
  }
  session(userId){
    const token=secret(),csrfToken=secret();
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(hash(token),userId,csrfToken,this.now()+30*86400000);
    return {user:{id:userId},token,csrfToken};
  }
  guest(token){
    if(token){try{const a=this.authenticate(token);return {user:{id:a.userId},token,csrfToken:a.csrfToken};}catch(e){if(e.status!==401)throw e;}}
    const id=randomUUID(),recoveryKey=secret();
    return this.transaction(()=>{this.db.prepare('INSERT INTO users VALUES (?,?,?)').run(id,hash(recoveryKey),this.now());return {...this.session(id),recoveryKey};});
  }
  authenticate(token){
    if(typeof token!=='string'||token.length>200)fail(401,'请先建立访客身份');
    const s=this.db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(hash(token),this.now());
    if(!s)fail(401,'会话已失效，请恢复身份或重新进入');return {userId:s.user_id,csrfToken:s.csrf};
  }
  recover(recoveryKey){
    if(typeof recoveryKey!=='string'||recoveryKey.length>200)fail(401,'恢复凭证不正确');
    const user=this.db.prepare('SELECT id FROM users WHERE recovery_hash=?').get(hash(recoveryKey));
    if(!user)fail(401,'恢复凭证不正确');return this.session(user.id);
  }
  rotateRecovery(userId){const recoveryKey=secret();this.db.prepare('UPDATE users SET recovery_hash=? WHERE id=?').run(hash(recoveryKey),userId);return {recoveryKey};}
  logout(token){this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));return {ok:true};}
  owned(userId,id){
    const row=this.db.prepare('SELECT user_id,record FROM satellites WHERE id=?').get(id);
    if(!row||row.user_id!==userId)fail(404,'找不到该卫星');
    return this.records.get(id)||JSON.parse(row.record);
  }
  publicRecord(r){const {ownerId,seq,lastSample,eventSeq,requestHash,...result}=r;return structuredClone({...result,
    calibration:r.initial.calibration||U.SCALE,calibrationInferred:!r.initial.calibration,
    telemetry:U.telemetry(r.state,r.initial.calibration||U.SCALE),trajectoryCoverage:Budget.coverage(r)});}
  get(userId,id){return this.publicRecord(this.owned(userId,id));}
  launch(userId,input){
    const initial=M.validateLaunch(input),idem=input.idempotencyKey;
    if(typeof idem!=='string'||idem.length<8||idem.length>128)fail(422,'发射请求缺少有效幂等键');
    const requestHash=hash(JSON.stringify(initial));
    const old=this.db.prepare('SELECT * FROM satellites WHERE user_id=? AND idem=?').get(userId,idem);
    if(old){if(old.request_hash!==requestHash)fail(409,'同一发射请求不能更换参数');return this.get(userId,old.id);}
    if(this.clockError)fail(503,'服务器时钟异常，暂不能发射');
    if(this.records.size>=this.maxActive)fail(503,'当前并发计算容量已满，请稍后发射；已有卫星继续运行');
    // A newborn must never be durable ahead of its world's durable checkpoint.
    this.checkpoint();
    const id=randomUUID(),queued=this.targetTick()-this.tick>120,createdMs=Math.floor(this.now()),nameGenerated=!initial.name;
    if(nameGenerated)initial.name='SAT-'+hash(`${createdMs}:${id}`).slice(0,16);
    const r={id,ownerId:userId,name:initial.name,massKg:initial.massKg,initial,sampling:{...this.samplingPolicy,legacyThroughSeq:0},trajectoryBudget:{...this.trajectoryPolicy,status:'recording',cappedAt:null},...(nameGenerated?{nameGenerated:true,nameTimestampMs:createdMs}:{}),status:queued?'queued':'active',birthTick:queued?null:this.tick,state:M.createState(initial,{continuousTracking:true}),createdAt:new Date(createdMs).toISOString(),endReason:null,seq:0,eventSeq:0,lastSample:null};
    if(queued)r.state.status='queued';
    this.transaction(()=>{
      if(!queued){r.lastSample={...M.snapshot(r.state),kind:'birth'};Budget.admit(r,r.lastSample);r.eventSeq=1;}
      this.db.prepare('INSERT INTO satellites VALUES (?,?,?,?,?,?)').run(id,userId,this.now(),idem,requestHash,JSON.stringify(r));
      if(r.lastSample)this.insertPoint(r.id,r.lastSample);
      if(!queued)this.db.prepare('INSERT INTO events VALUES (?,?,?)').run(id,1,JSON.stringify({type:'birth',tick:0,worldTick:r.birthTick,elapsedSeconds:0,x:r.state.x,y:r.state.y}));
    });
    this.records.set(id,r);
    if(!queued)this.ensureSampler(r);
    return this.publicRecord(r);
  }
  insertPoint(id,p){this.sql.point.run(id,p.seq,p.tick,p.elapsedSeconds,p.x,p.y,p.vx,p.vy,p.kind);}
  enqueuePoint(r,p){
    if(!Budget.admit(r,p))return false;
    this.pending.push({id:r.id,p});this.dirty.add(r.id);
    if(Budget.isCapped(r))this.samplers.delete(r.id);
    return true;
  }
  ensureSampler(r){
    Budget.ensure(r,this.trajectoryPolicy);if(Budget.isCapped(r))return null;
    if(this.samplers.has(r.id))return this.samplers.get(r.id);
    if(!r.sampling){
      // Close the old policy at the exact durable state without rewriting any historical row.
      if(r.lastSample?.tick!==r.state.tick||r.lastSample?.elapsedSeconds!==r.state.elapsedSeconds)this.enqueuePoint(r,{...M.snapshot(r.state),kind:'sampling-transition'});
      r.sampling={...this.samplingPolicy,legacyThroughSeq:r.seq};this.dirty.add(r.id);
    }
    if(Budget.isCapped(r))return null;
    const sampler=createSampler(M.snapshot(r.state),r.initial.calibration||U.SCALE,{velocityRelativeTolerance:r.sampling.velocityRelativeTolerance??0});this.samplers.set(r.id,sampler);return sampler;
  }
  flushSampler(r,kind){
    if(Budget.isCapped(r)){this.samplers.delete(r.id);return;}
    const sampler=this.samplers.get(r.id),points=sampler?sampler.flush():[];
    if(kind&&points.length)points.at(-1).kind=kind;
    for(const p of points)if(!this.enqueuePoint(r,p))break;
    if(kind&&!points.length&&!Budget.isCapped(r))this.enqueuePoint(r,{...M.snapshot(r.state),kind});
  }
  sample(r,kind){this.flushSampler(r,kind||(r.state.status==='active'?'sample':r.state.status));}
  finish(r,type){
    r.status=type;r.state.status=type;r.endReason=type;
    this.sample(r,type);this.pendingEvents.push({id:r.id,seq:++r.eventSeq,event:{type,...r.state.event,tick:r.state.tick,elapsedSeconds:r.state.elapsedSeconds}});this.dirty.add(r.id);
  }
  advanceTo(target,{maxSteps=Infinity,budgetMs=Infinity}={}){
    if(this.clockError)return;
    const started=performance.now();let steps=0;
    while(this.tick<target&&steps<maxSteps&&performance.now()-started<budgetMs){
      const active=[...this.records.values()].filter(r=>r.status==='active');
      if(!active.length){this.tick=target;break;}
      for(const r of active){
        const sampler=this.ensureSampler(r);M.step(r.state);this.metrics.rawSteps++;if(sampler)sampler.push(M.snapshot(r.state));this.dirty.add(r.id);
        if(r.state.status!=='active'){this.finish(r,r.state.status);continue;}
        if(sampler?.size>=POLICY.blockTicks+1)this.flushSampler(r);
      }
      this.tick++;steps++;
    }
    if(this.tick>=target){
      for(const r of this.records.values())if(r.status==='queued'){
        r.status='active';r.state.status='active';r.birthTick=this.tick;this.sample(r,'birth');
        this.ensureSampler(r);
        this.pendingEvents.push({id:r.id,seq:++r.eventSeq,event:{type:'birth',tick:0,worldTick:r.birthTick,elapsedSeconds:0,x:r.state.x,y:r.state.y}});
      }
    }
  }
  checkpoint(){
    const started=performance.now();
    for(const id of this.dirty){const r=this.records.get(id);if(r&&this.samplers.has(id))this.flushSampler(r);}
    if(!this.clockError)this.lastGoodWallMs=Math.max(this.lastGoodWallMs,this.now());
    this.transaction(()=>{
      for(const {id,p} of this.pending)this.insertPoint(id,p);
      for(const e of this.pendingEvents)this.sql.event.run(e.id,e.seq,JSON.stringify(e.event));
      for(const id of this.dirty){const r=this.records.get(id);if(r)this.sql.record.run(JSON.stringify(r),id);}
      this.sql.clock.run('clock',JSON.stringify({epochMs:this.epochMs,tick:this.tick,savedWallMs:this.lastGoodWallMs}));
    });
    this.metrics.savedPoints+=this.pending.length;this.metrics.checkpointMs=performance.now()-started;this.metrics.checkpointMaxMs=Math.max(this.metrics.checkpointMaxMs,this.metrics.checkpointMs);
    this.pending=[];this.pendingEvents=[];this.dirty.clear();
    for(const [id,r] of this.records)if(!['active','queued'].includes(r.status)){this.records.delete(id);this.samplers.delete(id);}
  }
  list(userId,{cursor,limit}={}){
    const after=integer(cursor,Number.MAX_SAFE_INTEGER),count=integer(limit,50,1,100);
    const rows=this.db.prepare('SELECT rowid AS cursor,id,record FROM satellites WHERE user_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?').all(userId,after,count+1);
    return {satellites:rows.slice(0,count).map(row=>this.publicRecord(this.records.get(row.id)||JSON.parse(row.record))),nextCursor:rows.length>count?rows[count-1].cursor:null,server:this.health()};
  }
  active(userId){return {satellites:[...this.records.values()].filter(r=>r.ownerId===userId&&['active','queued'].includes(r.status)).map(r=>this.publicRecord(r)),server:this.health()};}
  trajectory(userId,id,query={}){
    const r=this.owned(userId,id);if(query.cutoffSeq===undefined)this.checkpoint();
    const after=integer(query.cursor,0),count=integer(query.limit,1000,1,5000),from=integer(query.fromTick,0),to=integer(query.toTick,r.state.tick);
    if(from>to)fail(422,'起始时间不能晚于截止时间');
    const cutoffSeq=integer(query.cutoffSeq,r.seq,0,r.seq),boundaries=query.boundaries==='1'||query.boundaries===true;
    const rows=readPoints(this.db,this.filename,{id,after,fromTick:from,toTick:to,cutoffSeq,limit:count+1,boundaries});
    return {points:rows.slice(0,count).map(p=>({...p,...U.telemetry(p,r.initial.calibration||U.SCALE)})),nextCursor:rows.length>count?rows[count-1].seq:null,cutoffTick:to,cutoffSeq,sampling:r.sampling||{version:'legacy-linear-prediction-v1'},
      calibration:r.initial.calibration||U.SCALE,calibrationInferred:!r.initial.calibration};
  }
  terminate(userId,id,{checkpoint=true}={}){
    const r=this.owned(userId,id);if(!['active','queued'].includes(r.status))return this.publicRecord(r);
    this.records.set(id,r);r.state.event={type:'terminated',substepFraction:0};
    if(r.birthTick===null){r.status='terminated';r.state.status='terminated';r.endReason='terminated';this.dirty.add(id);}
    else this.finish(r,'terminated');
    if(checkpoint)this.checkpoint();return this.publicRecord(r);
  }
  terminateMany(userId,ids){
    if(!Array.isArray(ids)||ids.length>1000||ids.some(id=>typeof id!=='string'))fail(422,'批量终止参数无效');
    const unique=[...new Set(ids)];for(const id of unique)this.owned(userId,id);
    const satellites=unique.map(id=>this.terminate(userId,id,{checkpoint:false}));this.checkpoint();return {satellites,server:this.health()};
  }
  prepareExport(userId,id,format){
    if(!['csv','json'].includes(format))fail(422,'仅支持 CSV 和 JSON');
    const r=this.owned(userId,id);if(r.birthTick===null)fail(409,'卫星尚未正式出生，没有可导出的轨迹');
    if(r.status==='active'){this.records.set(id,r);this.sample(r,'cutoff');}
    this.checkpoint();
    const out={id:randomUUID(),satelliteId:id,format,status:'pending',cutoffTick:r.state.tick,cutoffSeq:r.seq,cutoffEventSeq:r.eventSeq,createdAt:new Date(this.now()).toISOString(),expiresAt:new Date(this.now()+7*86400000).toISOString(),satellite:this.publicRecord(r),model:M.MODEL};
    this.db.prepare('INSERT INTO exports VALUES (?,?,?,?)').run(out.id,userId,id,JSON.stringify(out));return out;
  }
  getExport(userId,id){const row=this.db.prepare('SELECT user_id,record FROM exports WHERE id=?').get(id);if(!row||row.user_id!==userId)fail(404,'找不到该导出任务');return JSON.parse(row.record);}
  finishExport(id,changes){const row=this.db.prepare('SELECT record FROM exports WHERE id=?').get(id);if(!row)return;const r={...JSON.parse(row.record),...changes};this.db.prepare('UPDATE exports SET record=? WHERE id=?').run(JSON.stringify(r),id);}
  interruptExports(){for(const row of this.db.prepare('SELECT id,record FROM exports').all()){const r=JSON.parse(row.record);if(r.status==='pending')this.finishExport(row.id,{status:'failed',message:'服务重启中断了导出，请重新导出'});}}
  archive(){
    this.checkpoint();
    const started=performance.now();
    try{if(this.tick<86400*M.MODEL.tickRate)return null;const chunk=archiveBatch(this.db,this.filename,{cutoffWorldTick:this.tick-86400*M.MODEL.tickRate,maxPoints:4096});this.metrics.archivedPoints+=chunk?.count||0;this.metrics.archiveError=null;return chunk;}catch(error){this.metrics.archiveError=error.message;return null;}finally{this.metrics.archiveMs=performance.now()-started;}
  }
  close(){if(this.closed)return;this.checkpoint();this.db.close();this.closed=true;}
}
module.exports={Engine,fail,integer};
