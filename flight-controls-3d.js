'use strict';

const OrbitalFlightControls3D = (() => {
  const $ = id => document.getElementById(id);
  const history = OrbitalHistory, units = OrbitalUnits;
  const statuses = {queued:'排队中', active:'运行中', captured:'已撞击天体', escaped:'已逃逸',
    terminated:'已终止', out_of_observable:'超出可观测区域', error:'计算中断'};
  const running = record => ['active','queued'].includes(record?.status);
  const sweepSeconds = 8;
  const recordPath = id => '/api/satellites/' + encodeURIComponent(id);
  const show = (id, value) => {
    const node = $(id);
    if(node.textContent !== value)node.textContent = value;
  };

  function create({api, spaceQuery, worldId, model, getFlight, getState, getSweepSource, hasSweepSource, frameSweep, receive, remove,
    observeClock, draw, exactHistory, ensureVisible, resumeLive, wake, isLivePlaying, isHidden, isOnline, isSending, updateLaunch}) {
    let cursor, listRequest, action, sweep, replay, exportRequest, epoch=0;
    const note = text => show('records-status',text);
    const replayStatus = text => show('history-status',text);
    const selection = () => getFlight()?.id;
    const trajectory = (id, options, signal) => {
      const {boundaries,...values} = options;
      const params=new URLSearchParams();
      for(const [key,value] of Object.entries(values))if(value!=null)params.set(key,value);
      if(boundaries)params.set('boundaries','1');
      return api(recordPath(id)+'/trajectory?'+params,undefined,{signal});
    };

    function render(){
      const record=getFlight(), state=replay?replay.point:record&&getState(record.id);
      $('flight-detail').hidden=!record;
      $('refresh-flights').disabled=!isOnline()||!!listRequest;
      $('more-flights').hidden=cursor==null;
      $('more-flights').disabled=!isOnline()||!!listRequest;
      $('sweep-3d').disabled=sweep?!!sweep.cancelled||!sweep.wave:!hasSweepSource||!isOnline()||isSending()||!!action;
      show('sweep-3d',sweep?(sweep.cancelled?'正在停止…':sweep.wave?'停止冲击波':'正在蓄能…')
        :hasSweepSource?'全图冲击波':'冲击波需要黑洞');
      const wave=sweep?.wave;
      const eta=wave&&Math.ceil(Math.max(0,wave.duration-wave.age));
      const waveStatus=wave
        ? (sweep.cancelled?'正在停止冲击波':isLivePlaying()?'球形冲击波':'冲击波已暂停')+
          ' · '+sweep.sourceLabel+' · 已终止 '+sweep.count+' 颗 · '+(eta?'剩余约 '+eta+' 秒':'正在确认结果')
        : '';
      $('stage-wave').hidden=!wave;
      show('stage-wave',waveStatus);
      show('view-status',waveStatus|| (replay?'历史回放':isHidden()?'卫星已隐藏':isLivePlaying()?'实时观察':'当前星图模拟已暂停'));
      if(!record)return;
      show('flight-name',record.name);
      show('flight-state',replay?'历史回放':statuses[state?.status??record.status]??record.status);
      show('height-value',state?units.toKm(state.z).toFixed(2):'—');
      const calibration=record.calibration??units.SCALE;
      const telemetry=state&&units.telemetry(state,calibration);
      const event=state?.event;
      const collision={'black-hole':'黑洞',blackHole:'黑洞',star:'恒星',planet:'行星',moon:'天然卫星'}[event?.bodyType];
      const capped=record.trajectoryCoverage?.status==='capped';
      show('flight-meta',[record.id,record.massKg+' kg',
        state&&state.elapsedSeconds.toFixed(3)+' 模拟秒',
        telemetry&&telemetry.physicalElapsedSeconds.toPrecision(4)+' s 模型物理时间',
        record.initial.dynamicsVersion,collision&&'撞击 '+collision,capped&&'轨迹已达到存储上限'].filter(Boolean).join(' · '));
      const initial=units.toKmS(record.initial.speed,calibration).toLocaleString('zh-CN',{maximumFractionDigits:2});
      const speed=state?units.formatSpeed(state,calibration):'—';
      const components=telemetry?.physicalSpeedValid
        ? ' · 速度分量 '+[telemetry.vxKmS,telemetry.vyKmS,telemetry.vzKmS].map(value=>value.toFixed(2)).join(' / ')+' km/s · '+(telemetry.fractionOfC*100).toFixed(2)+'% c'
        : telemetry?' · 模型速度 '+telemetry.speedKmS.toFixed(2)+' km/s':'';
      show('flight-speed','初速度 '+initial+' km/s · '+(replay?'回放速度 ':running(record)?'当前速度 ':'末态速度 ')+speed+components);
      $('terminate-3d').disabled=!isOnline()||!running(record)||!!action||!!sweep;
      $('delete-3d').disabled=!isOnline()||!!action||!!sweep;
      $('history-3d').disabled=!isOnline()||!!replay?.controller;
      for(const button of document.querySelectorAll('[data-export]'))button.disabled=!isOnline();
    }

    async function loadList(more=false,{quiet=false}={}){
      if(listRequest||more&&cursor==null)return;
      const request=new AbortController(), current=epoch;
      listRequest=request;render();
      if(!quiet)note('正在读取卫星档案…');
      try{
        const query=new URLSearchParams(spaceQuery);
        if(more)query.set('cursor',cursor);
        const result=await api('/api/satellites?'+query,undefined,{signal:request.signal});
        if(current!==epoch)return;
        cursor=result.nextCursor;
        if(observeClock(result.server))receive(result.satellites);
        note(result.satellites.length?'卫星档案已更新。':'当前地图还没有 3D 卫星。');
      }catch(error){if(current===epoch){note(error.message);if(quiet)throw error;}}
      finally{if(listRequest===request){listRequest=null;render();}}
    }

    function leaveReplay(){
      replay?.controller?.abort();
      replay?.overviewController?.abort();
      if(replay)exactHistory.clear();
      replay=null;
      $('replay-3d').hidden=true;
      render();draw();
    }

    function clearSelection(){
      exportRequest?.abort();
      exportRequest=null;
      $('download-export-3d').hidden=true;
      $('download-export-3d').removeAttribute('href');
      show('export-status','');
      leaveReplay();
    }

    function reset(){
      epoch++;
      listRequest?.abort();
      listRequest=null;
      cursor=null;action=null;sweep=null;
      clearSelection();note('');render();
    }

    function setReplayTime(session,time){
      session.time=time;
      session.point=history.interpolate(session.cache.points,time);
      $('timeline-3d').value=time;
      show('replay-time',time.toFixed(2)+' 模拟秒');
    }

    async function loadOverview(session){
      const controller=new AbortController();
      session.overviewController=controller;
      const stride=Math.max(1,Math.ceil(session.cutoffSeq/12000));
      const exact=exactHistory.start();
      try{
        await history.loadExact(options=>trajectory(session.id,{cursor:options.cursor,
          limit:options.limit,cutoffSeq:session.cutoffSeq},controller.signal),{
          cutoffSeq:session.cutoffSeq,signal:controller.signal,onPage:(points,meta)=>{
            if(replay!==session||controller.signal.aborted)return;
            if(exact)exactHistory.append(points);
            for(const point of points){
              if(point.seq===1||point.seq%stride===0||point.seq===session.cutoffSeq)session.overview.push(point);
            }
            session.overviewStatus='已读取 '+meta.pointCount.toLocaleString('zh-CN')+' 个历史点'+
              (exact?' · 完整精确轨迹':stride===1?' · 星图显示保存点':' · 当前浏览器按间隔显示采样点');
            updateReplayStatus(session);
            if(!session.playing)draw();
          }
        });
      }catch(error){
        if(replay===session&&!controller.signal.aborted){
          session.overviewStatus='完整轨迹读取中断 · '+error.message;
          updateReplayStatus(session);
        }
      }
    }

    function updateReplayStatus(session){
      replayStatus([session.windowStatus,session.overviewStatus].filter(Boolean).join(' · '));
    }

    function replayButton(){
      show('replay-play',replay?.playing?'暂停':'播放');
    }

    async function seek(time,play=false){
      const session=replay;
      if(!session)return;
      session.controller?.abort();
      session.controller=null;
      session.playing=play;
      replayButton();
      if(play)wake();
      time=Math.max(0,Math.min(session.endSeconds,time));
      if(session.cache.contains(time)){
        setReplayTime(session,time);
        render();draw();return;
      }
      session.time=time;
      session.point=null;
      $('timeline-3d').value=time;
      show('replay-time',time.toFixed(2)+' 模拟秒');
      const controller=new AbortController(),{signal}=controller;
      session.controller=controller;
      session.windowStatus='正在读取附近的轨迹…';
      updateReplayStatus(session);
      const current=()=>replay===session&&!signal.aborted;
      render();draw();
      try{
        const result=await history.loadWindow(history.windowRange(time,session,model.MODEL.tickRate),
          async options=>{
            const page=await trajectory(session.id,options,signal);
            if(current()&&session.cutoffSeq===undefined){
              session.cutoffSeq=page.cutoffSeq;
              const coverage=page.trajectoryCoverage;
              if(coverage){
                session.tick=coverage.endTick;
                session.endSeconds=session.elapsedSeconds=coverage.endElapsedSeconds;
                $('timeline-3d').max=session.endSeconds;
                time=Math.min(time,session.endSeconds);
                session.capped=coverage.status==='capped';
              }
            }
            return page;
          },{cutoffSeq:session.cutoffSeq,targetTick:time*model.MODEL.tickRate});
        if(!current())return;
        session.cache.set(result.range,result.points);
        if(!session.cache.contains(time))throw new Error('此时刻没有可回放的轨迹采样点。');
        setReplayTime(session,time);
        session.windowStatus=session.capped?'回放到轨迹存储上限':'可拖动时间轴定位';
        updateReplayStatus(session);
        if(!session.overviewController)void loadOverview(session);
      }catch(error){
        if(current()){session.playing=false;session.windowStatus=error.message;updateReplayStatus(session);}
      }finally{
        if(current()){session.controller=null;replayButton();render();draw();}
      }
    }

    $('history-3d').onclick=()=>{
      const record=getFlight();
      if(!record)return;
      leaveReplay();ensureVisible();
      const coverage=record.trajectoryCoverage;
      const elapsedSeconds=coverage?.endElapsedSeconds??record.state.elapsedSeconds;
      replay={id:record.id,tick:coverage?.endTick??record.state.tick,elapsedSeconds,endSeconds:elapsedSeconds,
        birthTick:record.birthFieldTick??record.birthTick??0,resumePoint:record.resumePoint,
        time:0,point:null,cache:history.createCache(),overview:[],playing:false};
      $('timeline-3d').max=elapsedSeconds;
      $('replay-3d').hidden=false;
      void seek(0);
    };
    $('timeline-3d').oninput=event=>void seek(Number(event.target.value),replay?.playing);
    $('replay-play').onclick=()=>{
      if(!replay)return;
      if(replay.playing){replay.playing=false;replayButton();return;}
      void seek(replay.time>=replay.endSeconds?0:replay.time,true);
    };
    $('return-live').onclick=leaveReplay;

    async function changeRecord(method){
      const record=getFlight();
      if(!record||action||sweep||!isOnline())return;
      const deleting=method==='DELETE';
      if(!confirm(deleting
        ? '永久删除“'+record.name+'”及其轨迹与导出文件？'
        : '终止“'+record.name+'”的追踪？已有轨迹仍会保留。'))return;
      const current=epoch;
      action=record.id;render();
      try{
        const result=await api(recordPath(record.id)+(deleting?'':'/terminate'),deleting?undefined:{},{method});
        if(current!==epoch)return;
        if(deleting)remove(record.id);else receive([result.satellite]);
        note(deleting?'卫星档案已删除。':'已终止追踪，可以回放和导出轨迹。');
      }catch(error){if(current===epoch)note(error.message);}
      finally{if(current===epoch){action=null;render();}}
    }
    $('terminate-3d').onclick=()=>void changeRecord('POST');
    $('delete-3d').onclick=()=>void changeRecord('DELETE');
    $('refresh-flights').onclick=()=>void loadList();
    $('more-flights').onclick=()=>void loadList(true);

    for(const button of document.querySelectorAll('[data-export]'))button.onclick=async()=>{
      const id=selection();
      if(!id||!isOnline())return;
      exportRequest?.abort();
      const controller=new AbortController(),{signal}=controller;
      exportRequest=controller;
      const current=()=>exportRequest===controller&&!signal.aborted;
      const link=$('download-export-3d'),format=button.dataset.export;
      link.hidden=true;
      show('export-status','正在生成轨迹导出…');
      try{
        let {export:job}=await api(recordPath(id)+'/exports',{format},{signal});
        while(current()&&['pending','running','processing','writing'].includes(job.status)){
          await new Promise(resolve=>setTimeout(resolve,1000));
          if(!current())return;
          ({export:job}=await api('/api/exports/'+encodeURIComponent(job.id),undefined,{signal}));
        }
        if(!current())return;
        if(!['ready','completed'].includes(job.status))throw new Error(job.message||job.error||'导出失败，请重试。');
        link.href=job.downloadUrl||'/api/exports/'+encodeURIComponent(job.id)+'/download';
        link.textContent='下载 '+format.toUpperCase()+' 文件';
        link.hidden=false;
        show('export-status','导出已就绪 · 截止 tick '+job.cutoffTick+
          (job.trajectoryCoverage?.status==='capped'?' · 轨迹已达到存储上限':''));
      }catch(error){if(current())show('export-status',error.message);}
    };

    async function sendHits(session){
      if(session.sending||!session.pending.size)return;
      const ids=[...session.pending].slice(0,250);
      for(const id of ids)session.pending.delete(id);
      session.sending=true;
      try{
        const result=await api('/api/satellites/terminate-many',{ids,worldId,dimension:3});
        if(sweep===session){
          receive(result.satellites);
          session.count+=result.satellites.filter(record=>record.status==='terminated').length;
        }
      }catch(error){
        if(sweep===session){session.failed+=ids.length;note('有卫星清除失败 · '+error.message);}
      }finally{
        if(sweep===session){session.sending=false;finishSweep(session);}
      }
    }

    function finishSweep(session){
      if(!session.wave?.done||session.sending||session.pending.size)return;
      sweep=null;
      note((session.cancelled?'冲击波已停止':'冲击波已扫过全图')+' · 已终止 '+session.count+
        ' 颗卫星，已有轨迹可回放和导出。'+(session.failed?' '+session.failed+' 颗清除失败。':''));
      updateLaunch();render();draw();
    }

    $('sweep-3d').onclick=async()=>{
      if(sweep?.wave){sweep.cancelled=true;sweep.wave.cancel();render();finishSweep(sweep);return;}
      if(sweep||!isOnline()||action||isSending())return;
      const source=getSweepSource();
      if(!source)return;
      const {origin,label:sourceLabel}=source;
      const session={sourceLabel,pending:new Set(),count:0,failed:0,sendIn:0};
      sweep=session;updateLaunch();render();
      try{
        const result=await api('/api/satellites/active?'+spaceQuery);
        if(sweep!==session)return;
        leaveReplay();ensureVisible();
        if(observeClock(result.server))receive(result.satellites);
        await resumeLive();
        if(sweep!==session)return;
        let extent=model.MODEL.observation.radius+Math.hypot(origin.x,origin.y,origin.z);
        for(const {state} of result.satellites){
          const distance=Math.hypot(state.x-origin.x,state.y-origin.y,(state.z??0)-origin.z);
          if(Number.isFinite(distance))extent=Math.max(extent,distance);
        }
        session.wave=OrbitalSweep.create({ids:result.satellites.map(record=>record.id),
          origin,extent,speed:extent/sweepSeconds});
        frameSweep(origin);
        note('球形波前从'+sourceLabel+'向外扩散，扫到卫星时会终止追踪。');
        render();
      }catch(error){
        if(sweep===session){sweep=null;note(error.message);updateLaunch();render();}
      }
    };

    function advance(seconds){
      if(replay?.playing&&!replay.controller){
        const next=Math.min(replay.endSeconds,replay.time+seconds*Number($('replay-rate').value));
        if(!replay.cache.contains(next))void seek(next,true);
        else{
          setReplayTime(replay,next);
          if(next>=replay.endSeconds){replay.playing=false;replayButton();}
        }
      }
      const session=sweep;
      if(!session?.wave)return;
      if(isLivePlaying()&&!session.cancelled){
        session.wave.advance(seconds);
        const positions=new Map();
        for(const id of session.wave.remaining){
          const state=getState(id);
          if(running(state))positions.set(id,state);
        }
        for(const id of session.wave.hits(positions))session.pending.add(id);
      }
      session.sendIn-=seconds;
      if(session.sendIn<=0&&session.pending.size&&!session.sending){
        session.sendIn=.15;
        void sendHits(session);
      }
      finishSweep(session);
    }

    return {advance,loadList,render,reset,clearSelection,leaveReplay,
      get sweeping(){return !!sweep;},
      get wave(){return sweep?.wave;},
      get replay(){return replay;}};
  }

  return {create,statuses};
})();
