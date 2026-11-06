(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrbitalWorldGenerator = factory();
})(globalThis, function () {
  'use strict';

  const VERSION = 'seeded-systems-v1';
  const SPATIAL_LAYOUT = 'spatial-v3';
  const PROFILE_SPATIAL_LAYOUT = 'spatial-v2';
  const ORIGINAL_SPATIAL_LAYOUT = 'spatial-v1';
  const MAP_RADIUS = 90000;
  const TAU = 2 * Math.PI;
  const MU_PER_SOLAR_MASS = 200000;
  const STAR_COLORS = ['#a6caff', '#c0e7ff', '#edf2ff', '#ffe3a2', '#ffc488', '#ff9c78', '#ff7e87', '#d0b8ff'];
  const PLANET_COLORS = ['#83cec2', '#80a8dd', '#b3c79d', '#c6a3de', '#dbaf8f', '#ebc87e'];
  const MOON_COLORS = ['#cbd3df', '#e0cfb4', '#b4c2d9', '#b9b2cb'];
  const HOLE_COLORS = ['#b7abff', '#96dec5', '#dbaad3', '#f4be8c', '#92b6ed'];
  const NAME_STARTS = [...'苍玄辰曦霁霜澜绯洛曜瑶暮银岚云逐沧星青弦'];
  const NAME_ENDS = [...'渊穹汐川枢宸芒歌翎屿砂弧焰环湾璃澈羽痕庭'];
  const NAME_SUFFIX = {star: '星', planet: '行星', moon: '卫星', blackHole: '黑洞'};
  // These are gameplay ranges in solar masses and scene radius units.
  const BODY_PROFILES = Object.freeze({
    dwarfStar: {label: '矮星', mass: [.15, .65], radius: [8, 18]},
    regularStar: {label: '普通恒星', mass: [.65, 2], radius: [19, 37]},
    giantStar: {label: '巨星', mass: [2, 5], radius: [40, 65]},
    supergiantStar: {label: '超巨星', mass: [5, 9], radius: [68, 85]},
    dwarfPlanet: {label: '矮行星', mass: [1e-8, 2e-6], radius: [2, 4]},
    planet: {label: '行星', mass: [2e-6, 4e-5], radius: [5, 13]}
  });
  const stellarClasses = ['dwarfStar', 'regularStar', 'giantStar', 'supergiantStar'];
  const LIMITS = Object.freeze({
    systems: Object.freeze({min: 2, max: 4, label: '星系数'}),
    blackHoles: Object.freeze({min: 0, max: 4, label: '黑洞数'}),
    stars: Object.freeze({min: 4, max: 20, label: '恒星数'}),
    planets: Object.freeze({min: 2, max: 8, label: '行星数'}),
    moons: Object.freeze({min: 0, max: 16, label: '天然卫星数'})
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

  function planSystems(seed, {systems, blackHoles, stars, planets, moons}) {
    const counts = {systems, blackHoles, stars, planets, moons};
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
      if (moons > 2 * (planets ?? 2 * count)) continue;
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
    const totalPlanets = planets ?? (moons > 0 ? integer(Math.max(count, Math.ceil(moons / 2)), 2 * count) : undefined);
    const planetCounts = distributeCount(totalPlanets, count, 1, 2, integer);
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
    const includePlanets = options.layout !== SPATIAL_LAYOUT;
    const variedBodies = !includePlanets || options.layout === PROFILE_SPATIAL_LAYOUT;
    const spatial = variedBodies || options.layout === ORIGINAL_SPATIAL_LAYOUT;
    if ((options.layout !== undefined && !spatial) || (!spatial && options.moons !== undefined)) {
      throw new RangeError('天然卫星数量仅适用于 3D 地图。');
    }
    if (!includePlanets && (options.planets !== undefined || options.moons !== undefined)) {
      throw new RangeError('新版 3D 地图仅生成黑洞和恒星。');
    }
    const plan = planSystems(seed, options);
    const random = randomFromSeed(`${VERSION}\0layout\0${seed}`);
    const bodyRandom = randomFromSeed(`${PROFILE_SPATIAL_LAYOUT}\0bodies\0${seed}`);
    const range = (min, max) => min + (max - min) * random();
    const integer = (min, max) => Math.floor(range(min, max + 1));
    const pick = values => values[integer(0, values.length - 1)];
    const phase = () => range(0, TAU);
    const sample = ([min, max]) => min + (max - min) * bodyRandom();
    function sampleStar() {
      const draw = bodyRandom();
      const bodyClass = stellarClasses[draw < .25 ? 0 : draw < .60 ? 1 : draw < .83 ? 2 : 3];
      const profile = BODY_PROFILES[bodyClass];
      return {bodyClass, massSolar: sample(profile.mass), radius: sample(profile.radius)};
    }
    function sampleCompanion(massSolar) {
      const bodyClass = stellarClasses.find(key => massSolar < BODY_PROFILES[key].mass[1]) ?? 'supergiantStar';
      return {bodyClass, massSolar, radius: sample(BODY_PROFILES[bodyClass].radius)};
    }
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
      const addBody = (kind, massSolar, radius, color, orbit = null, bodyClass) => {
        const body = {id: `${id}-${bodies.length + 1}`, name: name(kind), kind, massSolar, radius, color, orbit,
          ...(bodyClass ? {bodyClass} : {})};
        const reach = orbit ? envelopes.get(orbit.parentId) + orbit.radius : 0;
        envelopes.set(body.id, reach);
        extent = Math.max(extent, reach + radius);
        bodies.push(body);
        return body;
      };
      const addPlanet = (hostId, centralMass, orbitRadius) => {
        let massSolar = range(.000002, .00004), radius = range(5, 13), bodyClass;
        if (variedBodies) {
          bodyClass = bodyRandom() < .25 ? 'dwarfPlanet' : 'planet';
          const profile = BODY_PROFILES[bodyClass];
          massSolar = sample(profile.mass);
          radius = sample(profile.radius);
        }
        addBody('planet', massSolar, radius, pick(PLANET_COLORS),
          circularOrbit(hostId, orbitRadius ?? range(115, 175), phase(), centralMass), bodyClass);
      };

      if (type === 'black-hole-companions') {
        const mass = range(9, 18);
        const hole = addBody('blackHole', mass, mass * 6.6, pick(HOLE_COLORS));
        const starCount = configuration?.starCount ?? integer(3, 5);
        let orbitRadius = range(3000, 3900);
        for (let i = 0; i < starCount; i++) {
          const legacy = {massSolar: range(.55, 2.8), radius: range(20, 51)};
          const star = variedBodies ? sampleStar() : legacy;
          addBody('star', star.massSolar, star.radius, pick(STAR_COLORS),
            circularOrbit(hole.id, orbitRadius, phase(), mass, hole.radius), star.bodyClass);
          orbitRadius += range(1700, 2250);
        }
        if (includePlanets) {
          const planetCount = configuration?.planetCount ?? integer(1, 2);
          for (let i = 0; i < planetCount; i++) {
            const host = bodies[1 + i];
            addPlanet(host.id, host.massSolar);
          }
        }
      } else {
        const legacyPrimary = range(.85, 2.7);
        const primaryStar = variedBodies ? sampleStar() : null;
        const primary = primaryStar?.massSolar ?? legacyPrimary;
        const minRatio = variedBodies ? Math.max(.32, BODY_PROFILES.dwarfStar.mass[0] / primary) : .32;
        const massRatio = range(minRatio, 1);
        const secondary = primary * massRatio;
        const totalMass = primary + secondary;
        const separation = range(820, 1850);
        const initialPhase = phase();
        const angularSpeed = Math.sqrt(MU_PER_SOLAR_MASS * totalMass / separation ** 3);
        const primaryColor = pick(STAR_COLORS.slice(0, 3));
        const companionColor = pick(STAR_COLORS.slice(3, 7));
        const primaryRadius = range(33, 58), secondaryRadius = range(19, 41);
        const secondaryStar = variedBodies ? sampleCompanion(secondary) : null;
        addBody('star', primary, primaryStar?.radius ?? primaryRadius, primaryColor,
          {parentId: id, radius: separation * secondary / totalMass, phase: initialPhase, angularSpeed}, primaryStar?.bodyClass);
        addBody('star', secondary, secondaryStar?.radius ?? secondaryRadius, companionColor,
          {parentId: id, radius: separation * primary / totalMass, phase: (initialPhase + Math.PI) % TAU, angularSpeed}, secondaryStar?.bodyClass);
        binary = {massRatio, separation, phase: initialPhase};
        if (includePlanets) {
          const planetCount = configuration?.planetCount ?? integer(1, 2);
          let orbitRadius = separation * range(4.2, 5.3);
          for (let i = 0; i < planetCount; i++) {
            addPlanet(id, totalMass, orbitRadius);
            orbitRadius += range(1100, 1900);
          }
        }
      }

      const system = {id, type, name: type === 'binary' ? `${bodies[0].name}双星区` : `${bodies[0].name}伴星区`, x, y, extent: Math.ceil(extent + 240), bodies};
      if (binary) system.binary = binary;
      if (Math.hypot(x, y) + system.extent > MAP_RADIUS || systems.some(other => Math.hypot(x - other.x, y - other.y) <= system.extent + other.extent)) {
        throw new Error('生成的星区超出地图边界或与相邻星区重叠。');
      }
      systems.push(system);
    }
    const world = {version: VERSION, seed, radius: MAP_RADIUS, systems};
    if (spatial) {
      addSpatialLayout(systems, seed, options.moons, name);
      world.layout = options.layout;
      world.options = Object.fromEntries(['layout', 'systems', 'blackHoles', 'stars', 'planets', 'moons']
        .filter(key => options[key] !== undefined).map(key => [key, options[key]]));
    }
    return world;
  }

  function addSpatialLayout(systems, seed, moonTotal, name) {
    const random = randomFromSeed(`${ORIGINAL_SPATIAL_LAYOUT}\0${seed}`);
    const range = (min, max) => min + (max - min) * random();
    const integer = (min, max) => Math.floor(range(min, max + 1));
    const planets = systems.flatMap(system => system.bodies.filter(body => body.kind === 'planet'));
    const counts = distributeCount(moonTotal ?? integer(planets.length, planets.length * 2), planets.length, 0, 2, integer);
    const moonCounts = new Map(planets.map((planet, index) => [planet.id, counts[index]]));
    const firstSign = random() < .5 ? -1 : 1;
    for (const [index, system] of systems.entries()) {
      system.z = Math.round(firstSign * (-1) ** index * range(9000, 22000));
      for (const planet of system.bodies.filter(body => body.kind === 'planet')) {
        for (let i = 0; i < moonCounts.get(planet.id); i++) {
          const orbitRadius = planet.radius + 9 + i * 17 + range(0, 7);
          system.bodies.push({
            id: `${system.id}-${system.bodies.length + 1}`, name: name('moon'), kind: 'moon',
            massSolar: planet.massSolar * range(.008, .035), radius: planet.radius * range(.19, .32),
            color: MOON_COLORS[integer(0, MOON_COLORS.length - 1)],
            orbit: circularOrbit(planet.id, orbitRadius, range(0, TAU), planet.massSolar)
          });
        }
      }
    }
  }

  function orbitalPlane(key) {
    const random = randomFromSeed(`spatial-orbit-v1\0${key}`);
    const node = TAU * random(), tilt = .24 + 1.04 * random();
    const inclination = random() < .25 ? Math.PI - tilt : tilt;
    return Object.freeze({
      cosNode: Math.cos(node), sinNode: Math.sin(node),
      cosInclination: Math.cos(inclination), sinInclination: Math.sin(inclination)
    });
  }

  function orbitalOffset(radius, angle, plane) {
    const alongNode = radius * Math.cos(angle), acrossNode = radius * Math.sin(angle);
    const flat = acrossNode * plane.cosInclination;
    return {x: alongNode * plane.cosNode - flat * plane.sinNode,
      y: alongNode * plane.sinNode + flat * plane.cosNode, z: acrossNode * plane.sinInclination};
  }

  function worldOrbitalPlanes(world) {
    const planes = new Map();
    for (const system of world.systems) {
      const key = `${world.seed}\0${system.id}`;
      const binaryPlane = system.binary ? orbitalPlane(key) : null;
      for (const body of system.bodies) {
        if (body.orbit) planes.set(body.id, binaryPlane && body.kind === 'star'
          ? binaryPlane : orbitalPlane(`${key}\0${body.id}`));
      }
    }
    return planes;
  }

  function bodyPositions(system, time = 0, planes) {
    const positions = new Map([[system.id, system]]);
    return system.bodies.map(body => {
      const parent = body.orbit ? positions.get(body.orbit.parentId) : system;
      const angle = body.orbit ? (body.orbit.phase + body.orbit.angularSpeed * time) % TAU : 0;
      const radius = body.orbit?.radius ?? 0;
      const plane = planes?.get(body.id);
      if (plane) {
        const offset = orbitalOffset(radius, angle, plane);
        const position = {...body, plane, x:parent.x+offset.x, y:parent.y+offset.y, z:(parent.z??0)+offset.z};
        positions.set(body.id, position);
        return position;
      }
      const position = {...body, x: parent.x + radius * Math.cos(angle), y: parent.y + radius * Math.sin(angle)};
      if (planes) position.z = parent.z ?? 0;
      positions.set(body.id, position);
      return position;
    });
  }

  return Object.freeze({VERSION, SPATIAL_LAYOUT, LIMITS, BODY_PROFILES, MU_PER_SOLAR_MASS, generateWorld, bodyPositions,
    orbitalPlane, orbitalOffset, worldOrbitalPlanes});
});
