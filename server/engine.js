'use strict';
const {DatabaseSync}=require('node:sqlite');
const {randomUUID,randomBytes,createHash}=require('node:crypto');
const M=require('../shared/simulation.js');
const U=require('../shared/units.js');
const {generateWorld,N_BODY_MOTION}=require('../shared/world-generator.js');
const {BodyFields,DETAIL_WINDOW_TICKS,LIVE_PATH_INTERVAL,LIVE_PATH_LIMIT}=require('./body-fields.js');
const {createSampler,POLICY}=require('./trajectory-sampler.js');
const {createCheckpointStore}=require('./checkpoint-store.js');
const Budget=require('./trajectory-budget.js');
const {initializeStore,readPoints,archiveBatch,archivePath}=require('./trajectory-store.js');
const {statSync,unlinkSync}=require('node:fs');
const hash=value=>createHash('sha256').update(String(value)).digest('hex');
const secret=()=>randomBytes(32).toString('base64url');
const spatialClockKey=(userId,worldId)=>`spatial-clock:${userId}:${worldId??''}`;
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
    this.worlds=new Map();this.recordRuntimes=new WeakMap();this.liveFlightPaths=new WeakMap();
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
      CREATE TABLE IF NOT EXISTS worlds(id TEXT PRIMARY KEY,config TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS satellite_worlds(satellite_id TEXT PRIMARY KEY REFERENCES satellites(id) ON DELETE CASCADE,world_id TEXT NOT NULL REFERENCES worlds(id));
      CREATE TABLE IF NOT EXISTS points(satellite_id TEXT NOT NULL REFERENCES satellites(id),seq INTEGER NOT NULL,tick INTEGER NOT NULL,elapsed REAL NOT NULL,x REAL NOT NULL,y REAL NOT NULL,vx REAL NOT NULL,vy REAL NOT NULL,kind TEXT NOT NULL,z REAL,vz REAL,PRIMARY KEY(satellite_id,seq));
      CREATE INDEX IF NOT EXISTS points_time ON points(satellite_id,tick);
      CREATE TABLE IF NOT EXISTS events(satellite_id TEXT NOT NULL REFERENCES satellites(id),seq INTEGER NOT NULL,event TEXT NOT NULL,PRIMARY KEY(satellite_id,seq));
      CREATE TABLE IF NOT EXISTS exports(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),satellite_id TEXT NOT NULL REFERENCES satellites(id),record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS map_switches(user_id TEXT NOT NULL REFERENCES users(id),id TEXT NOT NULL,
        from_world TEXT,to_world TEXT,deleted INTEGER NOT NULL,cleanup TEXT,PRIMARY KEY(user_id,id));
    `);
    initializeStore(this.db);
    if(!this.db.prepare("SELECT 1 FROM pragma_table_info('points') WHERE name='z'").get()){
      this.transaction(()=>this.db.exec('ALTER TABLE points ADD COLUMN z REAL; ALTER TABLE points ADD COLUMN vz REAL;'));
    }
    const meta=this.db.prepare('SELECT value FROM meta WHERE key=?');
    const config=meta.get('model');
    if(config&&JSON.parse(config.value).version!==M.MODEL.version)throw new Error('数据库模型版本与程序不匹配，拒绝静默迁移');
    if(!config)this.db.prepare('INSERT INTO meta VALUES (?,?)').run('model',JSON.stringify(M.MODEL));
    const clock=meta.get('clock');
    const saved=clock?JSON.parse(clock.value):{tick:0};
    this.tick=saved.tick;this.realtimeRemainder=0;this.lastGoodWallMs=saved.savedWallMs??this.now();this.clockError=this.now()<this.lastGoodWallMs-1000?'系统时钟早于最近保存时刻，请校准后重启':null;
    this.spatialClocks=new Map(this.db.prepare("SELECT key,value FROM meta WHERE key LIKE 'spatial-clock:%'").all()
      .map(({key,value})=>[key,JSON.parse(value)]));
    this.bodyFields=new BodyFields(this.db);
    this.store=createCheckpointStore(this.db);
    this.bodyFields.restore(worldId=>this.worldInfo(worldId).world);
    this.records=new Map();this.dirty=new Set();this.pending=[];this.pendingEvents=[];
    for(const row of this.db.prepare('SELECT record FROM satellites').iterate()){
      const r=JSON.parse(row.record);if(r.status==='active'||r.status==='queued'){
        if(r.worldId)this.recordRuntimes.set(r,this.bodyFields.get(r.ownerId,r.worldId)?.runtime??this.worldInfo(r.worldId).runtime);
        const budgetBefore=JSON.stringify(r.trajectoryBudget);Budget.ensure(r,this.trajectoryPolicy);
        if(JSON.stringify(r.trajectoryBudget)!==budgetBefore)this.dirty.add(r.id);
        // Keep all committed coordinates/times; extend tracking only for live records.
        if(!r.state.continuousTracking){r.state.continuousTracking=true;this.dirty.add(r.id);}
        this.records.set(r.id,r);
        const {x,y,z}=r.state,radius=z===undefined?Math.hypot(x,y):Math.hypot(x,y,z);
        if(radius>M.MODEL.observation.radius){
          r.state.event={type:'out_of_observable',substepFraction:0,x:r.state.x,y:r.state.y,...(r.state.z!==undefined?{z:r.state.z}:{}),elapsedSeconds:r.state.elapsedSeconds};
          this.finish(r,'out_of_observable');continue;
        }
        if(r.status==='active')this.ensureSampler(r);
      }
    }
    if(!this.clockError)this.activateQueued();
    this.checkpoint();
  }
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  registerWorld(input){
    const {seed,options={}}=input;
    if(!options||typeof options!=='object'||Array.isArray(options))fail(422,'数量配置必须是对象');
    let world;
    try{world=generateWorld(seed,options);}catch(error){if(error instanceof RangeError)fail(422,error.message);throw error;}
    const config=JSON.stringify(world),worldId=hash(config);
    this.db.prepare('INSERT OR IGNORE INTO worlds(id,config) VALUES (?,?)').run(worldId,config);
    return {worldId,world};
  }
  worldInfo(worldId){
    if(worldId==null)return {worldId:null,world:null,runtime:M};
    if(typeof worldId!=='string'||!/^[a-f0-9]{64}$/.test(worldId))fail(404,'找不到该种子地图');
    let info=this.worlds.get(worldId);
    if(!info){
      const row=this.db.prepare('SELECT config FROM worlds WHERE id=?').get(worldId);
      if(!row)fail(404,'找不到该种子地图');
      const world=JSON.parse(row.config);
      info={worldId,world,runtime:M.createRuntime(world)};
      if(this.worlds.size>=32)this.worlds.delete(this.worlds.keys().next().value);
      this.worlds.set(worldId,info);
    }
    return info;
  }
  modelInfo(id){
    const {worldId,world,runtime}=this.worldInfo(id);
    return {model:runtime.MODEL,sampling:this.samplingPolicy,server:this.health(),...(worldId?{worldId,world}:{})};
  }
  health(){
    if(!this.diskCheckedAt||performance.now()-this.diskCheckedAt>1000){this.diskCheckedAt=performance.now();const size=path=>{try{return statSync(path).size;}catch{return 0;}};this.diskMetrics={databaseBytes:size(this.filename),walBytes:size(this.filename+'-wal')};}
    return {tick:this.tick,lagSeconds:0,status:this.clockError?'clock_error':'running',clockMode:'runtime-only-v1',active:this.records.size,clockError:this.clockError,storage:{...this.metrics,...this.diskMetrics,bufferedStates:[...this.samplers.values()].reduce((sum,s)=>sum+s.size-1,0),pendingPoints:this.pending.length}};
  }
  spatialTick(clock){
    const at=clock?.pausedAt??this.tick;
    if(clock?.anchorTick!==undefined)return clock.fieldTick+(at-clock.anchorTick)*clock.rate;
    return at-(clock?.offset??0);
  }
  ensureBodyField(userId,worldId,world=this.worldInfo(worldId).world){
    if(world?.motion!==N_BODY_MOTION)return null;
    const existing=this.bodyFields.get(userId,worldId);
    if(existing)return existing;
    const key=spatialClockKey(userId,worldId),previous=this.spatialClocks.get(key);
    const clock={offset:this.tick,pausedAt:null,revision:previous?.revision??0};
    const field=this.bodyFields.open(userId,worldId,world);
    try{this.checkpoint(()=>this.store.writeClock(key,clock));}
    catch(error){this.bodyFields.forget(userId,worldId);throw error;}
    this.spatialClocks.set(key,clock);
    return field;
  }
  viewClock(userId,worldId,dimension,includeLive=false){
    const server=this.health();
    if(dimension!==3)return server;
    const field=this.ensureBodyField(userId,worldId);
    const clock=this.spatialClocks.get(spatialClockKey(userId,worldId));
    const rate=clock?.rate??1;
    return {...server,tick:this.spatialTick(clock),paused:clock?.pausedAt!=null,pauseRevision:clock?.revision??0,simulationRate:rate,
      ...(field?{bodyField:field.snapshot()}:{}),
      ...(field&&includeLive&&rate>M.MODEL.livePathAboveRate?{bodyLivePath:field.livePath(field.tick-rate*M.MODEL.tickRate*.65)}:{})};
  }
  setSpatialPaused(userId,worldId,paused){
    if(typeof paused!=='boolean')fail(422,'请选择暂停或继续模拟');
    return this.configureSpatialClock(userId,worldId,{paused});
  }
  setSpatialRate(userId,worldId,rate){
    if(!this.worldInfo(worldId).runtime.MODEL.simulationRates.includes(rate))fail(422,'请选择支持的模拟倍速');
    return this.configureSpatialClock(userId,worldId,{rate});
  }
  configureSpatialClock(userId,worldId,{paused,rate}){
    this.ensureBodyField(userId,worldId);
    if(this.clockError)fail(503,'服务器时钟异常，暂不能切换模拟状态');
    const key=spatialClockKey(userId,worldId);
    const clock=this.spatialClocks.get(key),wasPaused=clock?.pausedAt!=null,oldRate=clock?.rate??1;
    const nextPaused=paused??wasPaused,nextRate=rate??oldRate;
    if(nextPaused!==wasPaused||nextRate!==oldRate){
      const next={anchorTick:this.tick,fieldTick:this.spatialTick(clock),rate:nextRate,
        pausedAt:nextPaused?this.tick:null,revision:(clock?.revision??0)+1};
      this.checkpoint(()=>this.store.writeClock(key,next));
      this.spatialClocks.set(key,next);
    }
    return this.active(userId,worldId,3);
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
  publicRecord(r){const {ownerId,seq,lastSample,eventSeq,requestHash,trajectoryBudget,...result}=r;return structuredClone({...result,
    calibration:r.initial.calibration||U.SCALE,calibrationInferred:!r.initial.calibration,
    telemetry:U.telemetry(r.state,r.initial.calibration||U.SCALE),trajectoryCoverage:Budget.coverage(r)});}
  get(userId,id,{includeLive=false}={}){
    const record=this.owned(userId,id);
    return includeLive?this.liveRecord(record):this.publicRecord(record);
  }
  liveRecord(record){
    const result=this.publicRecord(record);
    const rate=this.spatialClocks.get(spatialClockKey(record.ownerId,record.worldId))?.rate??1;
    const path=this.liveFlightPaths.get(record);
    if(rate>M.MODEL.livePathAboveRate&&path){
      const since=record.state.fieldTick-rate*M.MODEL.tickRate*.65;
      result.livePath=path.filter(point=>point[0]>since);
    }
    return result;
  }
  launch(userId,input){
    const info=this.worldInfo(input.worldId),{worldId}=info;
    const field=this.ensureBodyField(userId,worldId,info.world),runtime=field?.runtime??info.runtime;
    const idem=input.idempotencyKey,relative=input.referenceBodyId!==undefined||input.launchPreset!==undefined;
    let initial=relative?null:runtime.validateLaunch(input);
    if(typeof idem!=='string'||idem.length<8||idem.length>128)fail(422,'发射请求缺少有效幂等键');
    // A retry is tied to the submitted offset, even if the reference has moved since birth.
    const request=relative?[worldId,input.referenceBodyId,input.position?.x,input.position?.y,input.position?.z,
      input.name,input.dimension,input.massKg,input.speed,input.directionDeg,input.pitchDeg,
      input.unitSystem,input.calibrationVersion,input.modelVersion,input.dynamicsVersion,
      ...(input.launchPreset===undefined?[]:[input.launchPreset])]
      :worldId?{...initial,worldId}:initial;
    const requestHash=hash(JSON.stringify(request));
    const old=this.db.prepare('SELECT * FROM satellites WHERE user_id=? AND idem=?').get(userId,idem);
    if(old){if(old.request_hash!==requestHash)fail(409,'同一发射请求不能更换参数');return this.get(userId,old.id);}
    const fieldTick=input.dimension===3?this.spatialTick(this.spatialClocks.get(spatialClockKey(userId,worldId))):this.tick;
    initial??=runtime.validateLaunch(runtime.resolveLaunch(input,fieldTick));
    if(field&&field.currentBodies().some(body=>body.kind==='blackHole'&&Math.hypot(initial.position.x-body.x,
      initial.position.y-body.y,initial.position.z-body.z)<=body.radius))fail(422,'位置在黑洞捕获面内，无法发射');
    if(initial.dynamicsVersion!==runtime.MODEL.dynamics.version)fail(409,'新发射必须使用当前多引力源动力学版本，请刷新页面');
    if(this.clockError)fail(503,'服务器时钟异常，暂不能发射');
    if(this.records.size>=this.maxActive)fail(503,'当前并发计算容量已满，请稍后发射；已有卫星继续运行');
    // A newborn must never be durable ahead of its world's durable checkpoint.
    this.checkpoint();
    const id=randomUUID(),createdMs=Math.floor(this.now()),nameGenerated=!initial.name;
    if(nameGenerated)initial.name='SAT-'+hash(`${createdMs}:${id}`).slice(0,16);
    const r={id,ownerId:userId,name:initial.name,massKg:initial.massKg,initial,sampling:{...this.samplingPolicy,legacyThroughSeq:0},trajectoryBudget:{...this.trajectoryPolicy,status:'recording',cappedAt:null},...(nameGenerated?{nameGenerated:true,nameTimestampMs:createdMs}:{}),...(worldId?{worldId}:{}),status:'active',birthTick:this.tick,...(fieldTick!==this.tick?{birthFieldTick:fieldTick}:{}),state:runtime.createState(initial,{continuousTracking:true,fieldTick}),createdAt:new Date(createdMs).toISOString(),endReason:null,seq:0,eventSeq:0,lastSample:null};
    this.transaction(()=>{
      r.lastSample={...M.snapshot(r.state),kind:'birth'};Budget.admit(r,r.lastSample);r.eventSeq=1;
      this.db.prepare('INSERT INTO satellites VALUES (?,?,?,?,?,?)').run(id,userId,this.now(),idem,requestHash,JSON.stringify(r));
      if(worldId)this.db.prepare('INSERT INTO satellite_worlds VALUES (?,?)').run(id,worldId);
      if(r.lastSample)this.insertPoint(r.id,r.lastSample);
      this.db.prepare('INSERT INTO events VALUES (?,?,?)').run(id,1,JSON.stringify({type:'birth',tick:0,worldTick:r.birthTick,elapsedSeconds:0,x:r.state.x,y:r.state.y,...(initial.dimension===3?{z:r.state.z}:{})}));
    });
    this.records.set(id,r);
    if(worldId)this.recordRuntimes.set(r,runtime);
    this.ensureSampler(r);
    return this.publicRecord(r);
  }
  insertPoint(id,p){this.store.insertPoint(id,p);}
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
  activateQueued(){
    // Compatibility for pending launches saved by the former offline-recovery scheduler.
    for(const r of this.records.values())if(r.status==='queued'){
      r.status='active';r.state.status='active';r.birthTick=this.tick;if(r.state.dynamicsVersion===M.MODEL.dynamics.version)r.state.fieldTick=this.tick;this.sample(r,'birth');
      this.ensureSampler(r);
      this.pendingEvents.push({id:r.id,seq:++r.eventSeq,event:{type:'birth',tick:0,worldTick:r.birthTick,elapsedSeconds:0,x:r.state.x,y:r.state.y}});
    }
  }
  advanceRealtime(seconds,{budgetMs=12}={}){
    if(this.clockError||!Number.isFinite(seconds)||seconds<=0)return;
    // Retain fractions for 240 Hz accuracy, but never accumulate missed whole steps.
    this.realtimeRemainder+=Math.min(seconds,.1)*M.MODEL.tickRate;
    const steps=Math.floor(this.realtimeRemainder+1e-9);this.realtimeRemainder=Math.max(0,this.realtimeRemainder-steps);
    if(steps){
      const before=this.tick;
      this.advanceTo(before+steps,{maxSteps:steps,budgetMs});
      this.metrics.skippedTicks=(this.metrics.skippedTicks??0)+steps-(this.tick-before);
    }
    this.metrics.clampedSeconds=(this.metrics.clampedSeconds??0)+Math.max(0,seconds-.1);
  }
  advanceTo(target,{maxSteps=Infinity,budgetMs=Infinity}={}){
    if(this.clockError)return;
    const started=performance.now();let steps=0;
    const fields=[],flights=[];
    let rounds=1;
    const schedule=(work,item,clock)=>{
      if(clock?.pausedAt!=null)return;
      const rate=clock?.rate??1;
      work.push({item,rate});rounds=Math.max(rounds,rate);
    };
    for(const field of this.bodyFields.fields.values())schedule(fields,field,this.spatialClocks.get(spatialClockKey(field.userId,field.worldId)));
    for(const r of this.records.values())if(r.status==='active'){
      const clock=r.initial.dimension===3?this.spatialClocks.get(spatialClockKey(r.ownerId,r.worldId)):undefined;
      schedule(flights,r,clock);
    }
    const flightRuntimes=new Set(flights.map(({item})=>this.recordRuntimes.get(item)));
    const liveRuntimes=new Set();
    for(const work of fields){
      work.retainPrevious=flightRuntimes.has(work.item.runtime);
      work.recordLive=work.rate>M.MODEL.livePathAboveRate;
      if(work.recordLive)liveRuntimes.add(work.item.runtime);
    }
    let liveFlights=flights.length;
    while(this.tick<target&&steps<maxSteps&&performance.now()-started<budgetMs){
      if(!liveFlights&&!fields.length){this.tick=target;break;}
      // Advance each celestial field immediately before the matching satellite step.
      for(let round=0;round<rounds;round++){
        for(const {item:field,rate,retainPrevious,recordLive} of fields)if(round<rate)field.advanceTo(field.tick+1,retainPrevious,recordLive);
        for(const flight of flights){
          const {item:r,rate}=flight;
          if(round>=rate||r.status!=='active')continue;
          if(flight.sampler===undefined){
            flight.sampler=this.ensureSampler(r);
            flight.runtime=this.recordRuntimes.get(r)??M;
            flight.recordLive=liveRuntimes.has(flight.runtime);
            this.dirty.add(r.id);
          }
          const sampler=flight.sampler;
          flight.runtime.step(r.state);
          this.metrics.rawSteps++;
          if(flight.recordLive&&r.state.fieldTick%LIVE_PATH_INTERVAL===0){
            let path=this.liveFlightPaths.get(r);
            if(!path){path=[];this.liveFlightPaths.set(r,path);}
            const {fieldTick,x,y,z}=r.state;
            path.push([fieldTick,x,y,z]);
            if(path.length>LIVE_PATH_LIMIT)path.shift();
          }
          if(sampler)sampler.push(r.state,r.state.status==='active'?'sample':r.state.status);
          if(r.state.status!=='active'){this.finish(r,r.state.status);liveFlights--;continue;}
          if(sampler?.size>=POLICY.blockTicks+1){
            this.flushSampler(r);
            flight.sampler=this.samplers.get(r.id)??null;
          }
        }
      }
      this.tick++;steps++;
    }
  }
  captureCheckpoint(){
    for(const id of this.dirty){const r=this.records.get(id);if(r&&this.samplers.has(id))this.flushSampler(r);}
    const now=this.now();
    if(!this.clockError)this.lastGoodWallMs=Math.max(this.lastGoodWallMs,now);
    return {points:this.pending,events:this.pendingEvents,records:[...this.dirty].map(id=>this.records.get(id)).filter(Boolean),
      fields:this.bodyFields.checkpointFields(),clock:{mode:'runtime-only-v1',epochMs:now-this.tick/M.MODEL.tickRate*1000,tick:this.tick,savedWallMs:this.lastGoodWallMs}};
  }
  releaseCheckpoint(){
    this.bodyFields.committed();
    this.pending=[];this.pendingEvents=[];this.dirty.clear();
  }
  completeCheckpoint({pointCount,terminalIds,tick},checkpointMs){
    this.metrics.savedPoints+=pointCount;
    this.metrics.checkpointSavedTick=tick;
    this.metrics.checkpointMs=checkpointMs;
    this.metrics.checkpointMaxMs=Math.max(this.metrics.checkpointMaxMs,checkpointMs);
    for(const id of terminalIds){
      this.records.delete(id);
      this.samplers.delete(id);
    }
  }
  checkpointReceipt(batch){
    return {pointCount:batch.points.length,tick:batch.clock.tick,
      terminalIds:batch.records.filter(r=>!['active','queued'].includes(r.status)).map(r=>r.id)};
  }
  checkpoint(extra){
    const started=performance.now(),batch=this.captureCheckpoint();
    this.store.write(batch,extra);
    this.releaseCheckpoint();
    this.completeCheckpoint(this.checkpointReceipt(batch),performance.now()-started);
  }
  list(userId,{cursor,limit,worldId,dimension,includeLive=false}={}){
    this.worldInfo(worldId);
    const after=integer(cursor,Number.MAX_SAFE_INTEGER),count=integer(limit,50,1,100),space=integer(dimension,2,2,3);
    const rows=this.db.prepare(`SELECT s.rowid AS cursor,s.id,s.record FROM satellites s
      LEFT JOIN satellite_worlds sw ON sw.satellite_id=s.id
      WHERE s.user_id=? AND s.rowid<? AND sw.world_id IS ? AND COALESCE(json_extract(s.record,'$.initial.dimension'),2)=? ORDER BY s.rowid DESC LIMIT ?`).all(userId,after,worldId??null,space,count+1);
    const satellites=rows.slice(0,count).map(row=>{
      const record=this.records.get(row.id)||JSON.parse(row.record);
      return includeLive===true?this.liveRecord(record):this.publicRecord(record);
    });
    return {satellites,nextCursor:rows.length>count?rows[count-1].cursor:null,server:this.viewClock(userId,worldId,space,includeLive===true)};
  }
  active(userId,worldId,dimension){
    this.worldInfo(worldId);
    const space=integer(dimension,2,2,3);
    return {satellites:[...this.records.values()].filter(r=>r.ownerId===userId&&(r.worldId??null)===(worldId??null)&&(r.initial.dimension??2)===space&&['active','queued'].includes(r.status)).map(r=>this.publicRecord(r)),server:this.viewClock(userId,worldId,space)};
  }
  trajectory(userId,id,query={}){
    const r=this.owned(userId,id);if(query.cutoffSeq===undefined)this.checkpoint();
    const trajectoryCoverage=Budget.coverage(r),after=integer(query.cursor,0),count=integer(query.limit,1000,1,5000);
    const requestedFrom=integer(query.fromTick,0),requestedTo=integer(query.toTick,trajectoryCoverage.endTick);
    const explicitTo=query.toTick!==undefined&&query.toTick!==null&&query.toTick!=='';
    if(explicitTo&&requestedFrom>requestedTo)fail(422,'起始时间不能晚于截止时间');
    const to=Math.min(requestedTo,trajectoryCoverage.endTick),from=Math.min(requestedFrom,to);
    const cutoffSeq=integer(query.cutoffSeq,trajectoryCoverage.lastSeq,0,trajectoryCoverage.lastSeq),boundaries=query.boundaries==='1'||query.boundaries===true;
    const rows=readPoints(this.db,this.filename,{id,after,fromTick:from,toTick:to,cutoffSeq,limit:count+1,boundaries});
    return {points:rows.slice(0,count).map(p=>({...p,...U.telemetry(p,r.initial.calibration||U.SCALE)})),nextCursor:rows.length>count?rows[count-1].seq:null,cutoffTick:to,cutoffSeq,trajectoryCoverage,sampling:r.sampling||{version:'legacy-linear-prediction-v1'},
      calibration:r.initial.calibration||U.SCALE,calibrationInferred:!r.initial.calibration};
  }
  bodyTrajectory(userId,worldId,id,range){
    if(range){
      const fromTick=integer(range.fromTick,null),toTick=integer(range.toTick,null);
      if(fromTick==null||toTick==null||toTick<fromTick||toTick-fromTick>DETAIL_WINDOW_TICKS){
        fail(422,'无效的天体轨迹时间范围');
      }
      range={fromTick,toTick};
    }
    const field=this.ensureBodyField(userId,worldId);
    if(!field)fail(404,'当前地图没有多体轨迹');
    if(!range||field.tracks.length)this.checkpoint();
    const result=this.bodyFields.trajectory(field,id,range);
    if(!result)fail(404,'找不到该天体');
    return result;
  }
  bodyFrame(userId,worldId,tick){
    const field=this.ensureBodyField(userId,worldId);
    if(!field)fail(404,'当前地图没有多体轨迹');
    if(!Number.isFinite(tick)||tick<0)fail(422,'无效的天体回放时间');
    if(field.tracks.length)this.checkpoint();
    return this.bodyFields.historyFrame(field,tick);
  }
  terminate(userId,id,{checkpoint=true}={}){
    const r=this.owned(userId,id);if(!['active','queued'].includes(r.status))return this.publicRecord(r);
    this.records.set(id,r);r.state.event={type:'terminated',substepFraction:0};
    if(r.birthTick===null){r.status='terminated';r.state.status='terminated';r.endReason='terminated';this.dirty.add(id);}
    else this.finish(r,'terminated');
    if(checkpoint)this.checkpoint();return this.publicRecord(r);
  }
  terminateMany(userId,ids,worldId,dimension=2){
    this.worldInfo(worldId);
    if(![2,3].includes(dimension)||!Array.isArray(ids)||ids.length>1000||ids.some(id=>typeof id!=='string'))fail(422,'批量终止参数无效');
    const unique=[...new Set(ids)];
    for(const id of unique){const record=this.owned(userId,id);if((record.worldId??null)!==(worldId??null)||(record.initial.dimension??2)!==dimension)fail(404,'当前地图中找不到该卫星');}
    const satellites=unique.map(id=>this.terminate(userId,id,{checkpoint:false}));this.checkpoint();return {satellites,server:this.health()};
  }
  removeSatelliteRows(userId,ids){
    const archives=[],exportIds=[];
    const findArchives=this.db.prepare('SELECT file FROM trajectory_chunks WHERE satellite_id=?');
    const findExports=this.db.prepare('SELECT id FROM exports WHERE satellite_id=?');
    const removeChildren=['exports','events','points','trajectory_chunks'].map(table=>
      this.db.prepare(`DELETE FROM ${table} WHERE satellite_id=?`));
    const remove=this.db.prepare('DELETE FROM satellites WHERE id=? AND user_id=?');
    for(const id of ids){
      for(const row of findArchives.iterate(id))archives.push(row.file);
      for(const row of findExports.iterate(id))exportIds.push(row.id);
      for(const statement of removeChildren)statement.run(id);
      const removed=remove.run(id,userId);
      if(removed.changes!==1)fail(404,'找不到该卫星');
    }
    return {archives,exportIds};
  }
  forgetSatellites(ids){
    for(const id of ids){this.records.delete(id);this.samplers.delete(id);this.dirty.delete(id);}
  }
  deleteSatellite(userId,id){
    this.owned(userId,id);this.checkpoint();
    const {archives,exportIds}=this.transaction(()=>this.removeSatelliteRows(userId,[id]));
    this.forgetSatellites([id]);
    const archiveCleanupFailures=[];
    for(const file of archives)try{unlinkSync(archivePath(this.filename,file));}catch(error){if(error.code!=='ENOENT')archiveCleanupFailures.push(file);}
    return {id,exportIds,archiveCleanupFailures};
  }
  switchMap(userId,{fromWorldId,toWorldId,switchId}){
    if(fromWorldId===undefined||toWorldId===undefined||typeof switchId!=='string'||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(switchId))fail(422,'无效的地图切换请求');
    const prior=this.db.prepare('SELECT * FROM map_switches WHERE user_id=? AND id=?').get(userId,switchId);
    if(prior){
      if(prior.from_world!==fromWorldId||prior.to_world!==toWorldId)fail(409,'切换请求已用于其他地图');
      return {deleted:prior.deleted,cleanup:prior.cleanup&&JSON.parse(prior.cleanup)};
    }
    this.worldInfo(fromWorldId);this.worldInfo(toWorldId);
    if(fromWorldId===toWorldId)return {deleted:0,cleanup:null};
    this.checkpoint();
    const ids=this.db.prepare(`SELECT s.id FROM satellites s LEFT JOIN satellite_worlds sw ON sw.satellite_id=s.id
      WHERE s.user_id=? AND sw.world_id IS ? AND json_extract(s.record,'$.initial.dimension')=3`).all(userId,fromWorldId).map(row=>row.id);
    const clockKey=spatialClockKey(userId,fromWorldId),previousClock=this.spatialClocks.get(clockKey);
    // Reset the old map's pause without letting connected clients discard the new clock revision.
    const clock=previousClock&&{offset:0,pausedAt:null,revision:previousClock.revision+1};
    const cleanup=this.transaction(()=>{
      const files=this.removeSatelliteRows(userId,ids);
      this.bodyFields.deleteRows(userId,fromWorldId);
      if(clock)this.store.writeClock(clockKey,clock);
      const work=ids.length||clock?{ids,...files}:null;
      this.db.prepare('INSERT INTO map_switches VALUES (?,?,?,?,?,?)').run(userId,switchId,fromWorldId,toWorldId,ids.length,work&&JSON.stringify(work));
      return work;
    });
    this.forgetSatellites(ids);
    this.bodyFields.forget(userId,fromWorldId);
    if(clock)this.spatialClocks.set(clockKey,clock);
    return {deleted:ids.length,cleanup};
  }
  pendingMapSwitches(){
    return this.db.prepare('SELECT user_id,id,from_world,cleanup FROM map_switches WHERE cleanup IS NOT NULL').all()
      .map(row=>({userId:row.user_id,switchId:row.id,fromWorldId:row.from_world,cleanup:JSON.parse(row.cleanup)}));
  }
  finishMapSwitch(userId,switchId){
    return this.db.prepare('UPDATE map_switches SET cleanup=NULL WHERE user_id=? AND id=? AND cleanup IS NOT NULL')
      .run(userId,switchId).changes===1;
  }
  prepareExport(userId,id,format){
    if(!['csv','json'].includes(format))fail(422,'仅支持 CSV 和 JSON');
    const r=this.owned(userId,id);if(r.birthTick===null)fail(409,'卫星尚未正式出生，没有可导出的轨迹');
    if(r.status==='active'&&!Budget.isCapped(r)){this.records.set(id,r);this.sample(r,'cutoff');}
    this.checkpoint();
    const trajectoryCoverage=Budget.coverage(r);
    const {world,runtime}=this.worldInfo(r.worldId);
    const out={id:randomUUID(),satelliteId:id,format,status:'pending',cutoffTick:trajectoryCoverage.endTick,cutoffSeq:trajectoryCoverage.lastSeq,cutoffEventSeq:r.eventSeq,trajectoryCoverage,createdAt:new Date(this.now()).toISOString(),expiresAt:new Date(this.now()+7*86400000).toISOString(),satellite:this.publicRecord(r),model:runtime.MODEL,...(world?{world}:{})};
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
