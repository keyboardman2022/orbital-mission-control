'use strict';

(() => {
  const {VERSION, SPATIAL_LAYOUT, LIMITS, BODY_PROFILES, generateWorld, bodyPositions, worldOrbitalPlanes} = OrbitalWorldGenerator;
  const types = {'black-hole-companions': '黑洞伴星', binary: '双星'};
  const kinds = {blackHole: '黑洞', star: '恒星', planet: '行星', moon: '天然卫星'};
  const planetMarkerRadius = 1;
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
  const pageUrl = new URL(location.href);
  const spatial = pageUrl.searchParams.get('dimension') === '3';
  const returnPage = spatial ? 'map-3d.html' : 'mission.html';
  if (spatial) {
    document.title = '3D 种子地图 · ORBITAL';
    document.getElementById('page-title').textContent = '3D 种子地图预览';
    document.getElementById('planet-count').hidden = true;
    form.elements.planets.disabled = true;
    document.getElementById('count-help').textContent = '每个双星系统有 2 颗恒星。每个黑洞伴星系统有 1 个黑洞和 3–5 颗恒星。';
    const details = document.getElementById('body-profile-help');
    details.hidden = false;
    for (const [kind, {label, radius, mass}] of Object.entries(BODY_PROFILES)) {
      if (!kind.endsWith('Star')) continue;
      const item = document.createElement('li');
      item.textContent = `${label} · 半径 ${radius.join('–')} · 质量 ${mass.map(value => value < .001 ? value.toExponential() : value).join('–')} M☉`;
      details.querySelector('ul').append(item);
    }
  }
  function setReturnWorld(worldId) {
    const href = worldId?returnPage+'?worldId='+encodeURIComponent(worldId):returnPage;
    for (const link of document.querySelectorAll('.site-header a')) link.href = href;
    return href;
  }
  const returnWorld = pageUrl.searchParams.get('worldId');
  setReturnWorld(/^[a-f0-9]{64}$/.test(returnWorld)?returnWorld:null);
  const countFields = form.querySelectorAll('.count-fields select:not(:disabled)');
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

  function drawOverview(drawing, world, selected) {
    mapBackground(drawing, '全图 · 初始相位');
    drawing.setAttribute('aria-label', `种子 ${world.seed} 的全图，共 ${world.systems.length} 个星系`);
    const scale = 112 / world.radius;
    for (const radius of [37, 74, 112]) {
      svg(drawing, 'circle', {cx: 250, cy: 130, r: radius, fill: 'none', stroke: '#25344b'});
    }
    for (const [index, system] of world.systems.entries()) {
      const x = 250 + system.x * scale;
      const y = 130 - system.y * scale;
      const color = system.bodies[0].color;
      const active = system === selected;
      svg(drawing, 'circle', {cx: x, cy: y, r: Math.max(9, system.extent * scale), fill: color, 'fill-opacity': active ? .18 : .07, stroke: color, 'stroke-opacity': active ? .9 : .5});
      if (system.binary) {
        svg(drawing, 'path', {d: `M ${x} ${y - 4} L ${x + 4} ${y} L ${x} ${y + 4} L ${x - 4} ${y} Z`, fill: color});
      } else {
        svg(drawing, 'circle', {cx: x, cy: y, r: 4, fill: '#080d18', stroke: color, 'stroke-width': 1.5});
      }
      const onRight = x >= 250;
      svg(drawing, 'text', {x: x + (onRight ? 12 : -12), y: y + 4, 'text-anchor': onRight ? 'start' : 'end', fill: color, 'font-size': 11, stroke: '#080d18', 'stroke-width': 3, 'paint-order': 'stroke'}, `S0${index + 1} ${types[system.type]}`);
    }
  }

  function drawSystem(drawing, system, title) {
    mapBackground(drawing, `${title} · 初始相位`);
    drawing.setAttribute('aria-label', `${title}的成员位置与轨道`);
    const scale = 102 / system.extent;
    const project = ({x, y}) => ({x: 250 + (x - system.x) * scale, y: 130 - (y - system.y) * scale});
    const positions = bodyPositions(system);
    const centers = new Map([[system.id, system], ...positions.map(body => [body.id, body])]);
    const localPlanets = positions.filter(body => body.kind === 'planet' && body.orbit.parentId !== system.id);
    for (const body of positions) {
      if (!body.orbit) continue;
      const center = project(centers.get(body.orbit.parentId));
      svg(drawing, 'circle', {cx: center.x, cy: center.y, r: body.orbit.radius * scale, fill: 'none', stroke: body.color, 'stroke-opacity': .35});
    }
    for (const body of positions) {
      if (localPlanets.includes(body)) continue;
      const point = project(body);
      const radius = body.kind === 'planet' ? planetMarkerRadius : 4;
      svg(drawing, 'circle', {cx: point.x, cy: point.y, r: radius, fill: body.kind === 'blackHole' ? '#080d18' : body.color, stroke: body.color});
    }
    if (localPlanets.length) {
      svg(drawing, 'text', {x: 16, y: 49, fill: '#aab8d1', 'font-size': 11}, '行星局部放大');
      for (const [index, planet] of localPlanets.entries()) {
        const host = centers.get(planet.orbit.parentId);
        const cx = 62, cy = 86 + index * 88, radius = 22;
        svg(drawing, 'circle', {cx, cy, r: radius, fill: 'none', stroke: planet.color, 'stroke-opacity': .6});
        svg(drawing, 'circle', {cx, cy, r: 4, fill: host.color});
        svg(drawing, 'circle', {cx: cx + radius * Math.cos(planet.orbit.phase), cy: cy - radius * Math.sin(planet.orbit.phase), r: planetMarkerRadius, fill: planet.color});
        svg(drawing, 'text', {x: cx, y: cy + 36, fill: planet.color, 'font-size': 11, 'text-anchor': 'middle'}, `行星 ${index + 1}`);
      }
    }
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
    mapBackground(drawing, closeup ? '3D 近景 · 初始相位' : '3D 全图 · 初始相位');
    if (!closeup) {
      for (const [index, system] of world.systems.entries()) {
        const flat = project({...system, z: 0}), point = project(system);
        svg(drawing, 'line', {x1: flat.x, y1: flat.y, x2: point.x, y2: point.y,
          stroke: '#6b8bab', 'stroke-dasharray': '2 3'});
        svg(drawing, 'circle', {cx: point.x, cy: point.y, r: Math.max(8, system.extent * scale),
          fill: 'none', stroke: system.bodies[0].color, 'stroke-opacity': system === selected ? .85 : .28});
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
    const planes = spatial ? worldOrbitalPlanes(world) : null;
    const positions = spatial ? new Map(world.systems.map(system => [system.id, bodyPositions(system, 0, planes)])) : null;
    const initialView = {yaw: -.38, pitch: .6, zoom: 1};
    let view = {...initialView};
    let selected = world.systems.find(system => system.binary) ?? world.systems[0];
    let closeup = false;
    const counts = spatial ? {blackHole: 0, star: 0} : {blackHole: 0, star: 0, planet: 0};
    if (spatial) {
      card.classList.add('spatial-card');
      get('.spatial-tools').hidden = false;
      get('.inclination').hidden = false;
      drawing.classList.add('spatial');
      drawing.setAttribute('tabindex', '0');
      drawing.setAttribute('aria-label', '可旋转的三维星图预览');
    }
    for (const system of world.systems) {
      for (const body of system.bodies) counts[body.kind]++;
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
      button.textContent = `S0${index + 1} · ${types[system.type]}`;
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
      const title=selected.binary?`S0${index + 1} 双星区`:selected.name;
      toggle.textContent = closeup ? '返回全图' : '系统近景';
      toggle.setAttribute('aria-pressed', String(closeup));
      get('.map-key').hidden = closeup;
      if (!spatial) {
        if (closeup) drawSystem(drawing, selected, title);
        else drawOverview(drawing, world, selected);
      }
      choices.forEach((button, index) => button.setAttribute('aria-pressed', String(world.systems[index] === selected)));
      get('.detail-heading h3').textContent = title;
      get('.type-tag').textContent = types[selected.type];
      const neighbors = world.systems.filter(system => system !== selected);
      const nearest = Math.min(...neighbors.map(system => Math.hypot(system.x - selected.x, system.y - selected.y,
        spatial ? (system.z ?? 0) - (selected.z ?? 0) : 0)));
      const parameters = [`最近星区间距 ${formatter.format(nearest)}`];
      if (spatial) parameters.push(`中心高度 Z ${formatter.format(selected.z ?? 0)}`);
      if (selected.binary) {
        parameters.push(`双星间距 ${formatter.format(selected.binary.separation)}`, `次星／主星 ${ratio(selected.binary.massRatio)}`, `主星初相 ${degree(selected.binary.phase)}`);
      }
      get('.system-parameters').textContent = parameters.join(' · ');
      const table = get('tbody');
      table.replaceChildren();
      const primary = selected.bodies[0];
      const bodyNumbers = {star: 0, planet: 0, moon: 0};
      const names = new Map(selected.bodies.map(body => [
        body.id, body.kind === 'blackHole' ? body.name : `${kinds[body.kind]} ${++bodyNumbers[body.kind]}`
      ]));
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
        row.insertCell().textContent = body.orbit ? formatter.format(body.orbit.radius) : '—';
        row.insertCell().textContent = body.orbit ? degree(body.orbit.phase) : '—';
        if (spatial) {
          const plane = planes.get(body.id);
          row.insertCell().textContent = plane ? degree(Math.acos(plane.cosInclination)) : '—';
        }
      }
      if (spatial) {
        const target = focus.value;
        focus.replaceChildren(new Option('整个星系', ''));
        for (const body of selected.bodies) {
          if (body.kind !== 'moon') focus.add(new Option(names.get(body.id), body.id));
        }
        focus.value = target;
        redraw();
      }
    }

    function redraw() {
      spatialDrawing(drawing, world, selected, positions, closeup, focus.value, view);
    }
    if (spatial) {
      let drag;
      const updateView = (yaw, pitch, zoom) => {
        view = {yaw, pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch)),
          zoom: Math.max(.5, Math.min(8, zoom))};
        redraw();
      };
      drawing.addEventListener('pointerdown', event => {
        if (event.button !== 0 || drag) return;
        drag = {id: event.pointerId, x: event.clientX, y: event.clientY};
        drawing.setPointerCapture(event.pointerId);
      });
      drawing.addEventListener('pointermove', event => {
        if (drag?.id !== event.pointerId) return;
        updateView(view.yaw + (event.clientX - drag.x) * .009, view.pitch + (event.clientY - drag.y) * .009, view.zoom);
        drag.x = event.clientX;
        drag.y = event.clientY;
      });
      drawing.addEventListener('lostpointercapture', () => { drag = null; });
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
    }
    toggle.addEventListener('click', () => {
      closeup = !closeup;
      view.zoom = 1;
      renderSelection();
    });
    renderSelection();
    return card;
  }

  function generate() {
    const options = spatial ? {layout: SPATIAL_LAYOUT} : {};
    for (const field of countFields) {
      if (field.value) options[field.name] = field.value === 'required' ? 'required' : Number(field.value);
    }
    let world;
    try {
      world = generateWorld(input.value, options);
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
    status.textContent = `已生成 ${world.systems.length} 个星系。选择星系可查看各天体参数。`;
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
      const response = await fetch('/api/worlds', {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(configuration)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || '暂时无法保存地图。');
      pageUrl.searchParams.set('worldId', data.worldId);
      history.replaceState(history.state, '', pageUrl);
      location.assign(setReturnWorld(data.worldId));
    } catch (failure) {
      error.textContent = `进入地图失败。 ${failure.message}`;
      error.hidden = false;
      status.textContent = '';
    } finally {
      play.disabled = false;
    }
  });
  document.getElementById('generator-version').textContent = `生成器 ${VERSION}`;
  generate();
  if (spatial && /^[a-f0-9]{64}$/.test(returnWorld)) {
    const initialSeed = input.value;
    fetch('/api/model?worldId=' + encodeURIComponent(returnWorld)).then(async response => {
      if (!response.ok) return;
      const {world} = await response.json();
      if (!world || input.value !== initialSeed || [...countFields].some(field => field.value)) return;
      input.value = world.seed;
      for (const field of countFields) field.value = String(world.options?.[field.name] ?? '');
      generate();
    }).catch(() => {});
  }
})();
