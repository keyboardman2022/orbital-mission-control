(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrbitalWorldGenerator = factory();
})(globalThis, function () {
  'use strict';

  const VERSION = 'seeded-systems-v1';
  const MAP_RADIUS = 90000;
  const TAU = 2 * Math.PI;
  const MU_PER_SOLAR_MASS = 200000;
  const STAR_COLORS = ['#a6caff', '#c0e7ff', '#edf2ff', '#ffe3a2', '#ffc488', '#ff9c78', '#ff7e87', '#d0b8ff'];
  const PLANET_COLORS = ['#83cec2', '#80a8dd', '#b3c79d', '#c6a3de', '#dbaf8f', '#ebc87e'];
  const HOLE_COLORS = ['#b7abff', '#96dec5', '#dbaad3', '#f4be8c', '#92b6ed'];
  const NAME_STARTS = [...'苍玄辰曦霁霜澜绯洛曜瑶暮银岚云逐沧星青弦'];
  const NAME_ENDS = [...'渊穹汐川枢宸芒歌翎屿砂弧焰环湾璃澈羽痕庭'];
  const NAME_SUFFIX = {star: '星', planet: '行星', blackHole: '黑洞'};
  const LIMITS = Object.freeze({
    systems: Object.freeze({min: 2, max: 4, label: '星系数'}),
    blackHoles: Object.freeze({min: 0, max: 4, label: '黑洞数'}),
    stars: Object.freeze({min: 4, max: 20, label: '恒星数'}),
    planets: Object.freeze({min: 2, max: 8, label: '行星数'})
  });

  function randomFromSeed(seed) {
    let state = 2166136261;
    for (const character of seed) {
      state = Math.imul(state ^ character.codePointAt(0), 16777619);
    }
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let mixed = Math.imul(state ^ (state >>> 15), state | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
  }

  function generatedNames(seed) {
    const random = randomFromSeed(`${VERSION}\0names\0${seed}`);
    const used = new Set();
    return kind => {
      const start = NAME_STARTS[Math.floor(random() * NAME_STARTS.length)];
      const end = NAME_ENDS[Math.floor(random() * NAME_ENDS.length)];
      const base = start + end + NAME_SUFFIX[kind];
      let name = base;
      for (let suffix = 2; used.has(name); suffix++) name = `${base} ${suffix}`;
      used.add(name);
      return name;
    };
  }

  function circularOrbit(parentId, radius, phase, centralMass, schwarzschildRadius = 0) {
    const angularSpeed = Math.sqrt(MU_PER_SOLAR_MASS * centralMass / radius) / (radius - schwarzschildRadius);
    return {parentId, radius, phase, angularSpeed};
  }

  function distributeCount(total, slots, min, max, integer) {
    if (total === undefined) return [];
    return Array.from({length: slots}, (_, index) => {
      const remaining = slots - index - 1;
      const count = integer(Math.max(min, total - max * remaining), Math.min(max, total - min * remaining));
      total -= count;
      return count;
    });
  }

  function planSystems(seed, {systems, blackHoles, stars, planets}) {
    const counts = {systems, blackHoles, stars, planets};
    for (const [key, value] of Object.entries(counts)) {
      if (value === undefined || (key === 'blackHoles' && value === 'required')) continue;
      const {min, max, label} = LIMITS[key];
      if (!Number.isInteger(value) || value < min || value > max) {
        throw new RangeError(`${label}必须是 ${min}–${max} 的整数。`);
      }
    }
    if (Object.values(counts).every(value => value === undefined)) return null;

    const candidates = [];
    for (let count = systems ?? LIMITS.systems.min; count <= (systems ?? LIMITS.systems.max); count++) {
      if (planets !== undefined && (planets < count || planets > 2 * count)) continue;
      for (let holes = 0; holes <= count; holes++) {
        if (blackHoles === 'required' ? holes === 0 : blackHoles !== undefined && holes !== blackHoles) continue;
        const binaryStars = 2 * (count - holes);
        if (stars !== undefined && (stars < binaryStars + 3 * holes || stars > binaryStars + 5 * holes)) continue;
        candidates.push({count, holes, binaryStars});
      }
    }
    if (!candidates.length) throw new RangeError('无法同时满足这些数量。请调整自定义数量，或将部分选项设为随机。');

    const random = randomFromSeed(`${VERSION}\0counts\0${seed}`);
    const integer = (min, max) => min + Math.floor(random() * (max - min + 1));
    const {count, holes, binaryStars} = candidates[integer(0, candidates.length - 1)];
    const companionCounts = distributeCount(stars === undefined ? undefined : stars - binaryStars, holes, 3, 5, integer);
    const planetCounts = distributeCount(planets, count, 1, 2, integer);
    let remainingHoles = holes;
    return Array.from({length: count}, (_, index) => {
      const hasHole = integer(1, count - index) <= remainingHoles;
      const starCount = hasHole ? companionCounts[holes - remainingHoles] : 2;
      if (hasHole) remainingHoles--;
      return {type: hasHole ? 'black-hole-companions' : 'binary', starCount, planetCount: planetCounts[index]};
    });
  }

  function generateWorld(input, options = {}) {
    const seed = typeof input === 'string' ? input.trim().normalize('NFC') : '';
    if (!seed || seed.length > 64) throw new RangeError('请输入 1–64 个字符的种子。');
    const plan = planSystems(seed, options);
    const random = randomFromSeed(`${VERSION}\0layout\0${seed}`);
    const range = (min, max) => min + (max - min) * random();
    const integer = (min, max) => Math.floor(range(min, max + 1));
    const pick = values => values[integer(0, values.length - 1)];
    const phase = () => range(0, TAU);
    const name = generatedNames(seed);
    const count = plan?.length ?? integer(LIMITS.systems.min, LIMITS.systems.max);
    const orientation = phase();
    const systems = [];

    for (let index = 0; index < count; index++) {
      const id = `system-${index + 1}`;
      const configuration = plan?.[index];
      const type = configuration?.type ?? (random() < .5 ? 'black-hole-companions' : 'binary');
      // Angular sectors keep system envelopes apart while allowing different distances and orientations.
      const direction = orientation + index * TAU / count + range(-.14, .14);
      const distance = range(35000, 52000);
      const x = Math.round(Math.cos(direction) * distance * 1000) / 1000;
      const y = Math.round(Math.sin(direction) * distance * 1000) / 1000;
      const bodies = [];
      let extent = 0;
      let binary;
      const envelopes = new Map([[id, 0]]);
      const addBody = (kind, massSolar, radius, color, orbit = null) => {
        const body = {id: `${id}-${bodies.length + 1}`, name: name(kind), kind, massSolar, radius, color, orbit};
        const reach = orbit ? envelopes.get(orbit.parentId) + orbit.radius : 0;
        envelopes.set(body.id, reach);
        extent = Math.max(extent, reach + radius);
        bodies.push(body);
        return body;
      };

      if (type === 'black-hole-companions') {
        const mass = range(9, 18);
        const hole = addBody('blackHole', mass, mass * 6.6, pick(HOLE_COLORS));
        const starCount = configuration?.starCount ?? integer(3, 5);
        let orbitRadius = range(3000, 3900);
        for (let i = 0; i < starCount; i++) {
          const stellarMass = range(.55, 2.8);
          addBody('star', stellarMass, range(20, 51), pick(STAR_COLORS), circularOrbit(hole.id, orbitRadius, phase(), mass, hole.radius));
          orbitRadius += range(1700, 2250);
        }
        const planetCount = configuration?.planetCount ?? integer(1, 2);
        for (let i = 0; i < planetCount; i++) {
          const host = bodies[1 + i];
          addBody('planet', range(.000002, .00004), range(5, 13), pick(PLANET_COLORS), circularOrbit(host.id, range(115, 175), phase(), host.massSolar));
        }
      } else {
        const primary = range(.85, 2.7);
        const massRatio = range(.32, 1);
        const secondary = primary * massRatio;
        const totalMass = primary + secondary;
        const separation = range(820, 1850);
        const initialPhase = phase();
        const angularSpeed = Math.sqrt(MU_PER_SOLAR_MASS * totalMass / separation ** 3);
        const primaryColor = pick(STAR_COLORS.slice(0, 3));
        const companionColor = pick(STAR_COLORS.slice(3, 7));
        addBody('star', primary, range(33, 58), primaryColor, {parentId: id, radius: separation * secondary / totalMass, phase: initialPhase, angularSpeed});
        addBody('star', secondary, range(19, 41), companionColor, {parentId: id, radius: separation * primary / totalMass, phase: (initialPhase + Math.PI) % TAU, angularSpeed});
        binary = {massRatio, separation, phase: initialPhase};
        const planetCount = configuration?.planetCount ?? integer(1, 2);
        let orbitRadius = separation * range(4.2, 5.3);
        for (let i = 0; i < planetCount; i++) {
          addBody('planet', range(.000002, .00004), range(5, 13), pick(PLANET_COLORS), circularOrbit(id, orbitRadius, phase(), totalMass));
          orbitRadius += range(1100, 1900);
        }
      }

      const system = {id, type, name: type === 'binary' ? `${bodies[0].name}双星区` : `${bodies[0].name}伴星区`, x, y, extent: Math.ceil(extent + 240), bodies};
      if (binary) system.binary = binary;
      if (Math.hypot(x, y) + system.extent > MAP_RADIUS || systems.some(other => Math.hypot(x - other.x, y - other.y) <= system.extent + other.extent)) {
        throw new Error('生成的星区超出地图边界或与相邻星区重叠。');
      }
      systems.push(system);
    }
    return {version: VERSION, seed, radius: MAP_RADIUS, systems};
  }

  function bodyPositions(system, time = 0) {
    const positions = new Map([[system.id, system]]);
    return system.bodies.map(body => {
      const parent = body.orbit ? positions.get(body.orbit.parentId) : system;
      const angle = body.orbit ? (body.orbit.phase + body.orbit.angularSpeed * time) % TAU : 0;
      const radius = body.orbit?.radius ?? 0;
      const position = {...body, x: parent.x + radius * Math.cos(angle), y: parent.y + radius * Math.sin(angle)};
      positions.set(body.id, position);
      return position;
    });
  }

  return Object.freeze({VERSION, LIMITS, MU_PER_SOLAR_MASS, generateWorld, bodyPositions});
});
