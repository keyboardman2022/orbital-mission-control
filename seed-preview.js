'use strict';

(() => {
  const {VERSION, SPATIAL_LAYOUT, LIMITS, systemLabel, BODY_PROFILES, generateWorld, bodyPositions, worldOrbitalPlanes} = OrbitalWorldGenerator;
  const kinds = {blackHole: '黑洞', star: '恒星', planet: '行星', moon: '天然卫星'};
  const formatter = new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 1});
  const degree = radians => `${((Math.round(radians * 1800 / Math.PI) % 3600) / 10).toFixed(1)}°`;
  const ratio = value => value < .001 ? value.toExponential(2) : value.toFixed(3);
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const result = document.getElementById('map-result');
  const template = document.getElementById('map-template');
  const status = document.getElementById('generation-status');
  const error = document.getElementById('generation-error');
  const form = document.getElementById('seed-form');
  const input = document.getElementById('seed');
  const play = document.getElementById('play-map');
  const version = document.getElementById('generator-version');
  const pageUrl = new URL(location.href);
  const switchNote = document.getElementById('map-switch-note');
  let savedMap, switchIntent;
  const details = document.getElementById('body-profile-help');
  for (const [kind, {label, radius, mass}] of Object.entries(BODY_PROFILES)) {
    if (!kind.endsWith('Star')) continue;
    const item = document.createElement('li');
    item.textContent = `${label} · 半径 ${radius.join('–')} · 质量 ${mass.map(value => value < .001 ? value.toExponential() : value).join('–')} M☉`;
    details.querySelector('ul').append(item);
  }
  function setReturnWorld(worldId) {
    const href = worldId?'map-3d.html?worldId='+encodeURIComponent(worldId):'map-3d.html';
    for (const link of document.querySelectorAll('.site-header a')) link.href = href;
    const labUrl = new URL('gravity-lab.html',pageUrl);
    if (worldId) labUrl.searchParams.set('worldId',worldId);
    else if (pageUrl.searchParams.get('from')==='classic') labUrl.searchParams.set('from','classic');
    document.getElementById('gravity-lab-link').href=labUrl.href;
    return href;
  }
  const returnWorld = pageUrl.searchParams.get('worldId');
  setReturnWorld(/^[a-f0-9]{64}$/.test(returnWorld)?returnWorld:null);
  function sourceMap() {
    const id = pageUrl.searchParams.get('worldId');
    if (/^[a-f0-9]{64}$/.test(id)) return id;
    if (pageUrl.searchParams.get('from') === 'classic') return null;
  }
  switchNote.hidden = sourceMap() === undefined;
  const countFields = form.querySelectorAll('.count-fields select');
  for (const field of countFields) {
    const {min, max} = LIMITS[field.name];
    for (let count = min; count <= max; count++) {
      field.add(new Option(count === 0 && field.name === 'blackHoles' ? '0 个（无黑洞）' : String(count), String(count)));
    }
  }

  function svg(parent, name, attributes, content) {
    const node = document.createElementNS(svgNamespace, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (content !== undefined) node.textContent = content;
    parent.append(node);
    return node;
  }

  function mapBackground(drawing, label) {
    drawing.replaceChildren();
    for (let index = 0; index < 75; index++) {
      svg(drawing, 'circle', {cx: (index * 193 + 17) % 500, cy: (index * 89 + 23) % 260, r: index % 7 === 0 ? 1 : .6, fill: '#8796af', opacity: .28});
    }
    svg(drawing, 'path', {d: 'M 30 130 H 470 M 250 17 V 243', stroke: '#27344c', 'stroke-dasharray': '3 5'});
    svg(drawing, 'text', {x: 14, y: 22, fill: '#aab8d1', 'font-size': 11}, label);
  }

  function spatialDrawing(drawing, world, selected, positions, closeup, target, view) {
    const body = positions.get(selected.id).find(item => item.id === target);
    const center = closeup ? body ?? selected : {x: 0, y: 0, z: 0};
    const local = body && positions.get(selected.id).filter(item => item.orbit?.parentId === body.id);
    const extent = closeup
      ? body ? Math.max(body.radius * 4, ...local.map(item => item.orbit.radius * 1.3)) : selected.extent
      : world.radius;
    const scale = 108 * view.zoom / extent;
    const cosYaw = Math.cos(view.yaw), sinYaw = Math.sin(view.yaw);
    const cosPitch = Math.cos(view.pitch), sinPitch = Math.sin(view.pitch);
    const project = point => {
      const x = point.x - center.x, y = point.y - center.y, z = (point.z ?? 0) - (center.z ?? 0);
      const forward = x * sinYaw + y * cosYaw;
      return {x: 250 + (x * cosYaw - y * sinYaw) * scale,
        y: 130 + (forward * sinPitch - z * cosPitch) * scale, depth: forward * cosPitch + z * sinPitch};
    };
    mapBackground(drawing, `${closeup?'3D 近景':'3D 全图'} · ${world.motion?'初始状态':'初始相位'}`);
    if (!closeup) {
      for (const [index, system] of world.systems.entries()) {
        const flat = project({...system, z: 0}), point = project(system);
        svg(drawing, 'line', {x1: flat.x, y1: flat.y, x2: point.x, y2: point.y,
          stroke: '#6b8bab', 'stroke-dasharray': '2 3'});
        svg(drawing, 'circle', {cx: point.x, cy: point.y, r: Math.max(8, system.extent * scale),
          fill: 'none', stroke: system.bodies[0].color, 'stroke-opacity': system === selected ? .85 : .28,
          ...(system.triple ? {'stroke-dasharray':'3 2'} : {})});
        svg(drawing, 'text', {x: point.x + 9, y: point.y - 9, fill: '#cfdef1', 'font-size': 10,
          stroke: '#080d18', 'stroke-width': 3, 'paint-order': 'stroke'}, `S0${index + 1}`);
      }
    }
    const bodies = closeup ? body ? [body, ...local] : positions.get(selected.id) : [...positions.values()].flat();
    const dots = bodies.map(item => ({item, ...project(item)})).sort((a, b) => a.depth - b.depth);
    for (const {item, x, y} of dots) {
      const radius = item === body ? 5 : item.kind === 'moon' ? 1.1 : item.kind === 'planet' ? 1.7 : closeup ? 3.6 : 2;
      svg(drawing, 'circle', {cx: x, cy: y, r: radius, fill: item.kind === 'blackHole' ? '#080d18' : item.color,
        stroke: item.kind === 'blackHole' ? item.color : 'none'});
    }
  }

  function renderMap(world) {
    const card = template.content.firstElementChild.cloneNode(true);
    const get = selector => card.querySelector(selector);
    get('.seed-name').textContent = world.seed;
    const drawing = get('.map-drawing');
    const toggle = get('.view-toggle');
    const focus = get('.spatial-focus');
    if(world.motion){
      get('.distance-heading').textContent='距星区中心';
      get('.speed-heading').textContent='初速度';
      get('.direction-heading').textContent='方向 / 俯仰';
    }
    const planes = worldOrbitalPlanes(world);
    const positions = new Map(world.systems.map(system => [system.id, bodyPositions(system, 0, planes)]));
    const initialView = {yaw: -.38, pitch: .6, zoom: 1};
    let view = {...initialView};
    let selected = world.systems[0].centers
      ? world.systems.reduce((best,system) => system.bodies.length > best.bodies.length ? system : best)
      : world.systems.find(system => system.triple) ?? world.systems.find(system => system.binary) ?? world.systems[0];
    let closeup = false;
    const counts = {blackHole: 0, star: 0};
    for (const system of world.systems) {
      for (const body of system.bodies) counts[body.kind] = (counts[body.kind] ?? 0) + 1;
    }
    const stats = [['星系', world.systems.length], ...Object.entries(counts).map(([kind, count]) => [kinds[kind], count])];
    for (const [label, count] of stats) {
      const stat = document.createElement('div');
      const term = document.createElement('dt');
      const value = document.createElement('dd');
      term.textContent = label;
      value.textContent = count;
      stat.append(term, value);
      get('.map-stats').append(stat);
    }

    const choices = world.systems.map((system, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'system-choice';
      button.textContent = `S0${index + 1} · ${systemLabel(system)}`;
      button.setAttribute('aria-label', `查看 ${button.textContent}`);
      button.addEventListener('click', () => {
        selected = system;
        view.zoom = 1;
        focus.value = '';
        renderSelection();
      });
      get('.system-list').append(button);
      return button;
    });

    function renderSelection() {
      const index=world.systems.indexOf(selected);
      const title=selected.centers||selected.binary||selected.triple?`S0${index + 1} · ${systemLabel(selected)}`:selected.name;
      toggle.textContent = closeup ? '返回全图' : '系统近景';
      toggle.setAttribute('aria-pressed', String(closeup));
      get('.map-key').hidden = closeup || Boolean(selected.centers);
      choices.forEach((button, index) => button.setAttribute('aria-pressed', String(world.systems[index] === selected)));
      get('.detail-heading h3').textContent = title;
      get('.type-tag').textContent = world.motion?'多体引力':selected.centers ? '随机组合' : systemLabel(selected);
      const neighbors = world.systems.filter(system => system !== selected);
      const nearest = Math.min(...neighbors.map(system => Math.hypot(system.x - selected.x, system.y - selected.y,
        (system.z ?? 0) - (selected.z ?? 0))));
      const parameters = [`最近星区间距 ${formatter.format(nearest)}`, `中心高度 Z ${formatter.format(selected.z ?? 0)}`];
      if (selected.binary) {
        parameters.push(`双星间距 ${formatter.format(selected.binary.separation)}`, `次星／主星 ${ratio(selected.binary.massRatio)}`, `主星初相 ${degree(selected.binary.phase)}`);
      }
      if (selected.triple) {
        parameters.push(`内双星间距 ${formatter.format(selected.triple.innerSeparation)}`,
          `外星距内双星质心 ${formatter.format(selected.triple.outerSeparation)}`);
      }
      const table = get('tbody');
      table.replaceChildren();
      const primary = selected.bodies[0];
      const bodyNumbers = {star: 0, planet: 0, moon: 0};
      const names = new Map(selected.bodies.map(body => [
        body.id, body.kind === 'blackHole' ? body.name : `${kinds[body.kind]} ${++bodyNumbers[body.kind]}`
      ]));
      if (selected.triple) {
        names.set(selected.triple.innerId, '内双星质心');
        names.set(selected.id, '三星质心');
      }
      if (selected.centers) {
        names.set(selected.id, '星系质心');
        selected.centers.forEach((center,index) => names.set(center.id, `轨道组 ${index+1} 质心`));
        const children = new Map();
        for (const member of [...selected.centers,...selected.bodies]) {
          const parent = member.orbit?.parentId;
          if (!parent) continue;
          if (!children.has(parent)) children.set(parent,[]);
          children.get(parent).push(member);
        }
        function groupText(member) {
          if (children.has(member.id)) return `(${children.get(member.id).map(groupText).join(' + ')})`;
          return member.kind === 'blackHole' ? '黑洞' : names.get(member.id);
        }
        const root = children.get(selected.id);
        parameters.push(root ? `轨道组合 ${root.map(groupText).join(' + ')}` : '独立恒星');
      }
      get('.system-parameters').textContent = parameters.join(' · ');
      for (const body of selected.bodies) {
        const row = table.insertRow();
        const first = row.insertCell();
        const swatch = document.createElement('span');
        swatch.className = 'body-swatch';
        swatch.style.backgroundColor = body.color;
        swatch.setAttribute('aria-hidden', 'true');
        const color = document.createElement('span');
        color.className = 'body-color';
        const profile = BODY_PROFILES[body.bodyClass];
        color.textContent = `${profile?.label ?? kinds[body.kind]} · ${body.color.toUpperCase()}`;
        first.append(swatch, names.get(body.id), color);
        if (profile) {
          const physical = document.createElement('span');
          physical.className = 'body-host';
          physical.textContent = `半径 ${formatter.format(body.radius)} · ${ratio(body.massSolar)} M☉`;
          first.append(physical);
        }
        if (body.orbit) {
          const host = document.createElement('span');
          host.className = 'body-host';
          host.textContent = `绕行 ${names.get(body.orbit.parentId) ?? '双星质心'}`;
          first.append(host);
        }
        row.insertCell().textContent = ratio(body.massSolar / primary.massSolar);
        if(body.initial){
          const {x,y,z,vx,vy,vz}=body.initial;
          row.insertCell().textContent=formatter.format(Math.hypot(x,y,z));
          row.insertCell().textContent=formatter.format(Math.hypot(vx,vy,vz));
          row.insertCell().textContent=`${degree(Math.atan2(vy,vx))} / ${(Math.atan2(vz,Math.hypot(vx,vy))*180/Math.PI).toFixed(1)}°`;
        }else{
          row.insertCell().textContent = body.orbit ? formatter.format(body.orbit.radius) : '—';
          row.insertCell().textContent = body.orbit ? degree(body.orbit.phase) : '—';
          const plane = planes.get(body.id);
          row.insertCell().textContent = plane ? degree(Math.acos(plane.cosInclination)) : '—';
        }
      }
      const target = focus.value;
      focus.replaceChildren(new Option('整个星系', ''));
      for (const body of selected.bodies) {
        if (body.kind !== 'moon') focus.add(new Option(names.get(body.id), body.id));
      }
      focus.value = target;
      redraw();
    }

    function redraw() {
      spatialDrawing(drawing, world, selected, positions, closeup, focus.value, view);
    }
    let drag;
    const updateView = (yaw, pitch, zoom) => {
      view = {yaw, pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch)),
        zoom: Math.max(.5, Math.min(8, zoom))};
      redraw();
    };
    const pinch=OrbitalCamera.createPinchGesture({
      start(){drag=null;},
      zoom(factor){updateView(view.yaw,view.pitch,view.zoom*factor);}
    });
    drawing.addEventListener('pointerdown', event => {
      if(pinch.down(event)){drawing.setPointerCapture(event.pointerId);return;}
      if (event.button !== 0 || drag) return;
      drag = {id: event.pointerId, x: event.clientX, y: event.clientY};
      drawing.setPointerCapture(event.pointerId);
    });
    drawing.addEventListener('pointermove', event => {
      if(pinch.move(event))return;
      if (drag?.id !== event.pointerId) return;
      updateView(view.yaw + (event.clientX - drag.x) * .009, view.pitch + (event.clientY - drag.y) * .009, view.zoom);
      drag.x = event.clientX;
      drag.y = event.clientY;
    });
    function endDrag(event){
      pinch.end(event);
      if(drag?.id===event.pointerId)drag=null;
    }
    for(const type of ['pointerup','pointercancel','lostpointercapture'])drawing.addEventListener(type,endDrag);
    drawing.addEventListener('wheel', event => {
      event.preventDefault();
      updateView(view.yaw, view.pitch, view.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
    }, {passive: false});
    drawing.addEventListener('keydown', event => {
      const actions = {ArrowLeft: [-.15, 0, 1], ArrowRight: [.15, 0, 1], ArrowUp: [0, .15, 1], ArrowDown: [0, -.15, 1],
        '+': [0, 0, 1.12], '=': [0, 0, 1.12], '-': [0, 0, 1 / 1.12]};
      if (!Object.hasOwn(actions, event.key)) return;
      event.preventDefault();
      const [yaw, pitch, zoom] = actions[event.key];
      updateView(view.yaw + yaw, view.pitch + pitch, view.zoom * zoom);
    });
    focus.addEventListener('change', () => {
      closeup = true;
      view.zoom = 1;
      renderSelection();
    });
    get('.reset-preview').addEventListener('click', () => {
      view = {...initialView};
      redraw();
    });
    toggle.addEventListener('click', () => {
      closeup = !closeup;
      view.zoom = 1;
      renderSelection();
    });
    renderSelection();
    return card;
  }

  function generate() {
    const options = {layout: SPATIAL_LAYOUT};
    for (const field of countFields) {
      if (field.value) options[field.name] = field.value === 'required' ? 'required' : Number(field.value);
    }
    const seed = input.value.trim().normalize('NFC');
    const matchesSaved = savedMap && seed === savedMap.world.seed && [...countFields].every(
      field => field.value === String(savedMap.world.options?.[field.name] ?? ''));
    let world;
    try {
      world = matchesSaved ? savedMap.world : generateWorld(seed, options);
    } catch (failure) {
      if (!input.value.trim()) {
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      }
      error.textContent = failure.message;
      error.hidden = false;
      status.textContent = '';
      result.replaceChildren();
      return;
    }
    input.removeAttribute('aria-invalid');
    error.hidden = true;
    result.replaceChildren(renderMap(world));
    version.textContent = `布局 ${world.layout ?? VERSION}`;
    status.textContent = `${matchesSaved ? '已载入' : '已生成'} ${world.systems.length} 个星系。选择星系可查看各天体参数。`;
    if (matchesSaved) return {worldId: savedMap.worldId};
    return {seed:world.seed,options};
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    generate();
  });
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
  document.getElementById('random-seed').addEventListener('click', () => {
    const parts = crypto.getRandomValues(new Uint32Array(2));
    input.value = `ORB-${Array.from(parts, part => part.toString(36)).join('-')}`;
    generate();
  });
  play.addEventListener('click', async () => {
    if (!form.reportValidity()) return;
    const configuration = generate();
    if (!configuration) return;
    play.disabled = true;
    status.textContent = '正在准备任务控制台…';
    try {
      let {worldId} = configuration;
      if (!worldId) {
        const response = await fetch('/api/worlds', {
          method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(configuration)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || '暂时无法保存地图。');
        worldId = data.worldId;
      }
      const fromWorldId = sourceMap();
      if (fromWorldId !== undefined && fromWorldId !== worldId) {
        status.textContent = '正在清理原地图的数据…';
        const session = await fetch('/api/session');
        const credentials = await session.json();
        if (!session.ok) throw new Error(credentials.error?.message || '无法确认当前档案。');
        if (switchIntent?.fromWorldId !== fromWorldId || switchIntent?.toWorldId !== worldId) {
          switchIntent = {fromWorldId,toWorldId:worldId,switchId:crypto.randomUUID()};
        }
        const response = await fetch('/api/worlds/switch', {method:'POST',
          headers:{'Content-Type':'application/json','X-CSRF-Token':credentials.csrfToken},
          body:JSON.stringify(switchIntent)});
        if (!response.ok) throw new Error((await response.json()).error?.message || '原地图数据未能清理。');
      }
      pageUrl.searchParams.set('worldId', worldId);
      pageUrl.searchParams.delete('from');
      history.replaceState(history.state, '', pageUrl);
      location.assign(setReturnWorld(worldId));
    } catch (failure) {
      error.textContent = `进入地图失败。 ${failure.message}`;
      error.hidden = false;
      status.textContent = '';
    } finally {
      play.disabled = false;
    }
  });
  generate();
  if (/^[a-f0-9]{64}$/.test(returnWorld)) {
    const initialSeed = input.value;
    play.disabled = true;
    fetch('/api/model?worldId=' + encodeURIComponent(returnWorld)).then(async response => {
      if (response.status === 404 && pageUrl.searchParams.get('worldId') === returnWorld) {
        pageUrl.searchParams.delete('worldId');
        history.replaceState(history.state, '', pageUrl);
        setReturnWorld(null);
        switchNote.hidden = sourceMap() === undefined;
      }
      if (!response.ok) return;
      const {world} = await response.json();
      if (!world) return;
      savedMap = {worldId:returnWorld,world};
      if (input.value !== initialSeed || [...countFields].some(field => field.value)) return;
      input.value = world.seed;
      for (const field of countFields) field.value = String(world.options?.[field.name] ?? '');
      generate();
    }).catch(() => {}).finally(() => {play.disabled = false;});
  }
})();
