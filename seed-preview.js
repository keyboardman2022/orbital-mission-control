'use strict';

(() => {
  const {VERSION, LIMITS, generateWorld, bodyPositions} = OrbitalWorldGenerator;
  const types = {'black-hole-companions': '黑洞伴星', binary: '双星'};
  const kinds = {blackHole: '黑洞', star: '恒星', planet: '行星'};
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
  const countFields = form.querySelectorAll('.count-fields select');
  for (const field of countFields) {
    const {min, max} = LIMITS[field.name];
    for (let count = min; count <= max; count++) {
      field.add(new Option(count === 0 ? '0 个（无黑洞）' : String(count), String(count)));
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
      const radius = body.kind === 'planet' ? 2.4 : 4;
      svg(drawing, 'circle', {cx: point.x, cy: point.y, r: radius, fill: body.kind === 'blackHole' ? '#080d18' : body.color, stroke: body.color});
    }
    if (localPlanets.length) {
      svg(drawing, 'text', {x: 16, y: 49, fill: '#aab8d1', 'font-size': 11}, '行星局部放大');
      for (const [index, planet] of localPlanets.entries()) {
        const host = centers.get(planet.orbit.parentId);
        const cx = 62, cy = 86 + index * 88, radius = 22;
        svg(drawing, 'circle', {cx, cy, r: radius, fill: 'none', stroke: planet.color, 'stroke-opacity': .6});
        svg(drawing, 'circle', {cx, cy, r: 4, fill: host.color});
        svg(drawing, 'circle', {cx: cx + radius * Math.cos(planet.orbit.phase), cy: cy - radius * Math.sin(planet.orbit.phase), r: 3, fill: planet.color});
        svg(drawing, 'text', {x: cx, y: cy + 36, fill: host.color, 'font-size': 11, 'text-anchor': 'middle'}, planet.name);
      }
    }
  }

  function renderMap(world) {
    const card = template.content.firstElementChild.cloneNode(true);
    const get = selector => card.querySelector(selector);
    get('.seed-name').textContent = world.seed;
    const drawing = get('.map-drawing');
    const toggle = get('.view-toggle');
    let selected = world.systems.find(system => system.binary) ?? world.systems[0];
    let closeup = false;
    const counts = {blackHole: 0, star: 0, planet: 0};
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
      if (closeup) drawSystem(drawing, selected, title);
      else drawOverview(drawing, world, selected);
      choices.forEach((button, index) => button.setAttribute('aria-pressed', String(world.systems[index] === selected)));
      get('.detail-heading h3').textContent = title;
      get('.type-tag').textContent = types[selected.type];
      const neighbors = world.systems.filter(system => system !== selected);
      const nearest = Math.min(...neighbors.map(system => Math.hypot(system.x - selected.x, system.y - selected.y)));
      const parameters = [`最近星区间距 ${formatter.format(nearest)}`];
      if (selected.binary) {
        parameters.push(`双星间距 ${formatter.format(selected.binary.separation)}`, `次星／主星 ${ratio(selected.binary.massRatio)}`, `主星初相 ${degree(selected.binary.phase)}`);
      }
      get('.system-parameters').textContent = parameters.join(' · ');
      const table = get('tbody');
      table.replaceChildren();
      const primary = selected.bodies[0];
      let starNumber = 0;
      const names = new Map(selected.bodies.map(body => [body.id, body.kind === 'star' ? `恒星 ${++starNumber}` : body.name]));
      for (const body of selected.bodies) {
        const row = table.insertRow();
        const first = row.insertCell();
        const swatch = document.createElement('span');
        swatch.className = 'body-swatch';
        swatch.style.backgroundColor = body.color;
        swatch.setAttribute('aria-hidden', 'true');
        const color = document.createElement('span');
        color.className = 'body-color';
        color.textContent = `${kinds[body.kind]} · ${body.color.toUpperCase()}`;
        first.append(swatch, names.get(body.id), color);
        if (body.orbit) {
          const host = document.createElement('span');
          host.className = 'body-host';
          host.textContent = `绕行 ${names.get(body.orbit.parentId) ?? '双星质心'}`;
          first.append(host);
        }
        row.insertCell().textContent = ratio(body.massSolar / primary.massSolar);
        row.insertCell().textContent = body.orbit ? formatter.format(body.orbit.radius) : '—';
        row.insertCell().textContent = body.orbit ? degree(body.orbit.phase) : '—';
      }
    }

    toggle.addEventListener('click', () => {
      closeup = !closeup;
      renderSelection();
    });
    renderSelection();
    return card;
  }

  function generate() {
    const options = {};
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
      location.assign('mission.html?worldId=' + encodeURIComponent(data.worldId));
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
})();
