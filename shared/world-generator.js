(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrbitalWorldGenerator = factory();
})(globalThis, function () {
  'use strict';

  const VERSION = 'seeded-systems-v1';
  const SPATIAL_LAYOUT = 'spatial-v8';
  const FIRST_N_BODY_LAYOUT = 'spatial-v7';
  const PROCEDURAL_SPATIAL_LAYOUT = 'spatial-v6';
  const N_BODY_MOTION = 'nbody-v1';
  const N_BODY_SOFTENING = 20;
  const TRIPLE_SPATIAL_LAYOUT = 'spatial-v5';
  const SCATTER_SPATIAL_LAYOUT = 'spatial-v4';
  const RING_SPATIAL_LAYOUT = 'spatial-v3';
  const PROFILE_SPATIAL_LAYOUT = 'spatial-v2';
  const ORIGINAL_SPATIAL_LAYOUT = 'spatial-v1';
  const MAP_RADIUS = 90000;
  const TAU = 2 * Math.PI;
  const MU_PER_SOLAR_MASS = 200000;
  const STAR_COLORS = ['#a6caff', '#c0e7ff', '#edf2ff', '#ffe3a2', '#ffc488', '#ff9c78', '#ff7e87', '#d0b8ff'];
  const PLANET_COLORS = ['#83cec2', '#80a8dd', '#b3c79d', '#c6a3de', '#dbaf8f', '#ebc87e'];
  const MOON_COLORS = ['#cbd3df', '#e0cfb4', '#b4c2d9', '#b9b2cb'];
  const HOLE_COLORS = ['#b7abff', '#96dec5', '#dbaad3', '#f4be8c', '#92b6ed'];
  const SYSTEM_LABELS = Object.freeze({'black-hole-companions':'黑洞伴星', binary:'双星', 'hierarchical-triple':'层级三星'});
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
  const STAR_COUNT_WEIGHTS = [1,1,1,2,4,5,4,3];
  const LIMITS = Object.freeze({
    systems: Object.freeze({min: 2, max: 4, label: '星系数'}),
    blackHoles: Object.freeze({min: 0, max: 4, label: '黑洞数'}),
    stars: Object.freeze({min: 4, max: 32, label: '恒星数'}),
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

  function pairOrbits(parentId, separation, phase, firstMass, secondMass) {
    const totalMass = firstMass + secondMass;
    const angularSpeed = Math.sqrt(MU_PER_SOLAR_MASS * totalMass / separation ** 3);
    return [
      {parentId, radius: separation * secondMass / totalMass, phase, angularSpeed},
      {parentId, radius: separation * firstMass / totalMass, phase: (phase + Math.PI) % TAU, angularSpeed}
    ];
  }

  function sampleStar(random) {
    const draw = random();
    const bodyClass = stellarClasses[draw < .25 ? 0 : draw < .60 ? 1 : draw < .83 ? 2 : 3];
    const {mass,radius} = BODY_PROFILES[bodyClass];
    return {bodyClass, massSolar:mass[0] + (mass[1] - mass[0]) * random(),
      radius:radius[0] + (radius[1] - radius[0]) * random()};
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

  function validateCounts({layout, systems, blackHoles, stars, planets, moons}) {
    const counts = {systems, blackHoles, stars, planets, moons};
    for (const [key, value] of Object.entries(counts)) {
      if (value === undefined || (key === 'blackHoles' && value === 'required')) continue;
      const {min, max:currentMax, label} = LIMITS[key];
      const max=key==='stars'&&layout!==SPATIAL_LAYOUT?20:currentMax;
      if (!Number.isInteger(value) || value < min || value > max) {
        throw new RangeError(`${label}必须是 ${min}–${max} 的整数。`);
      }
    }
  }

  const incompatibleCounts = () => new RangeError('无法同时满足这些数量。请调整自定义数量，或将部分选项设为随机。');

  function planSystems(seed, {systems, blackHoles, stars, planets, moons}) {
    if ([systems, blackHoles, stars, planets, moons].every(value => value === undefined)) return null;

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
    if (!candidates.length) throw incompatibleCounts();

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

  function planSpatialSystems(seed, {layout, systems, blackHoles, stars}) {
    const triples = layout === TRIPLE_SPATIAL_LAYOUT;
    const choices = [
      {type:'binary', starCount:2, weight:triples ? 2 : 3},
      ...[3,4,5].map(starCount => ({type:'black-hole-companions', starCount, weight:1}))
    ];
    if (triples) choices.push({type:'hierarchical-triple', starCount:3, weight:1});
    const countRandom = randomFromSeed(`${layout}\0system-count\0${seed}`);
    let plan, bestCountPriority = Infinity;
    for (let count = LIMITS.systems.min; count <= LIMITS.systems.max; count++) {
      const countPriority = countRandom();
      if ((systems !== undefined && systems !== count) || countPriority >= bestCountPriority) continue;
      const random = randomFromSeed(`${layout}\0members\0${seed}\0${count}`);
      let best, bestPriority = Infinity;
      for (let choice = 0; choice < choices.length ** count; choice++) {
        let pattern = choice, holes = 0, starTotal = 0, weight = 1;
        const members = [];
        for (let index = 0; index < count; index++) {
          const member = choices[pattern % choices.length];
          pattern = Math.floor(pattern / choices.length);
          members.push(member);
          if (member.type === 'black-hole-companions') holes++;
          starTotal += member.starCount;
          weight *= member.weight;
        }
        // Keep equal prior odds for black-hole and stellar systems. Ranking excluded choices
        // too keeps the seed's original winner when a compatible constraint is added.
        const priority = -Math.log1p(-random()) / weight;
        if (blackHoles === 'required' ? holes === 0 : blackHoles !== undefined && holes !== blackHoles) continue;
        if (stars !== undefined && starTotal !== stars) continue;
        if (priority < bestPriority) {best = members; bestPriority = priority;}
      }
      if (best) {plan = best; bestCountPriority = countPriority;}
    }
    if (!plan) throw incompatibleCounts();
    return plan;
  }

  function planProceduralSystems(seed, {layout, systems, blackHoles, stars}) {
    const richer = layout===SPATIAL_LAYOUT;
    const maxPerSystem = richer?STAR_COUNT_WEIGHTS.length:5;
    const countRandom = randomFromSeed(`${layout}\0system-count\0${seed}`);
    let count, bestPriority = Infinity;
    for (let size=LIMITS.systems.min; size<=LIMITS.systems.max; size++) {
      const priority = countRandom();
      if ((systems !== undefined && size !== systems) || (Number.isInteger(blackHoles) && blackHoles > size) ||
        (stars !== undefined && (stars < size || stars > maxPerSystem * size))) continue;
      if (priority < bestPriority) {count = size; bestPriority = priority;}
    }
    if (!count) throw incompatibleCounts();

    const holeRandom = randomFromSeed(`${layout}\0holes\0${seed}\0${count}`);
    const holeOrder = Array.from({length:count}, (_, index) => ({index, priority:holeRandom()}))
      .sort((a,b) => a.priority - b.priority);
    const drawnHoles = holeOrder.filter(entry => entry.priority < .5).length;
    const holeCount = blackHoles === 'required' ? Math.max(1, drawnHoles) : blackHoles ?? drawnHoles;
    const holes = new Set(holeOrder.slice(0, holeCount).map(entry => entry.index));

    const starsRandom = randomFromSeed(`${layout}\0stars\0${seed}\0${count}`);
    let allocation;
    bestPriority = Infinity;
    for (let choice=0; choice<maxPerSystem**count; choice++) {
      const draw=starsRandom();
      if (!richer && draw>=bestPriority) continue;
      let pattern = choice, total = 0, weight = 1;
      const sizes = [];
      for (let index=0; index<count; index++) {
        const size = 1 + pattern % maxPerSystem;
        pattern = Math.floor(pattern / maxPerSystem);
        sizes.push(size);
        total += size;
        if(richer)weight*=STAR_COUNT_WEIGHTS[size-1];
      }
      if (stars === undefined ? total < LIMITS.stars.min : total !== stars) continue;
      // Keep the same weighted ranking when the user fixes a compatible count.
      const priority=richer?-Math.log1p(-draw)/weight:draw;
      if(priority>=bestPriority)continue;
      allocation = sizes;bestPriority = priority;
    }
    return allocation.map((starCount,index) => ({starCount, hasHole:holes.has(index)}));
  }

  function proceduralSystem(id, {starCount,hasHole}, seed, name) {
    const random = randomFromSeed(`${PROCEDURAL_SPATIAL_LAYOUT}\0orbits\0${seed}\0${id}`);
    const range = (min,max) => min + (max-min) * random();
    const take = items => items.splice(Math.floor(random() * items.length), 1)[0];
    const bodies = [], centers = [], colors = [...STAR_COLORS];
    function addBody(kind, physical, color) {
      const body = {id:`${id}-${bodies.length+1}`, name:name(kind), kind, ...physical, color, orbit:null};
      bodies.push(body);
      return {body, mass:body.massSolar, extent:body.radius * (kind === 'blackHole' ? 1.05 : 1)};
    }
    const groups = [];
    if (hasHole) {
      const massSolar = range(9,18);
      groups.push(addBody('blackHole',{massSolar,radius:massSolar*6.6},HOLE_COLORS[Math.floor(random()*HOLE_COLORS.length)]));
    }
    for (let i=0; i<starCount; i++) groups.push(addBody('star',sampleStar(random),take(colors)));

    let nextGroup = 0;
    while (groups.length > 1) {
      const a = take(groups), b = take(groups);
      groups.push({id:`${id}-group-${++nextGroup}`, children:[a,b], mass:a.mass+b.mass,
        spacing:range(1.3,2.0), baseSeparation:range(480,1180), phase:range(0,TAU)});
    }
    const root = groups[0];
    if (root.children) root.id = id;

    function sizeGroup(group, compact) {
      if (!group.children) return group.extent;
      const [a,b] = group.children;
      const extentA = sizeGroup(a,compact), extentB = sizeGroup(b,compact);
      const clearance = Math.max(extentA + extentB, a.separation ?? 0, b.separation ?? 0) + 60;
      const distance = compact ? clearance : Math.max(clearance * group.spacing, group.baseSeparation);
      group.separation = distance;
      group.orbits = pairOrbits(group.id,distance,group.phase,a.mass,b.mass);
      return Math.max(extentA + group.orbits[0].radius, extentB + group.orbits[1].radius);
    }
    function assignOrbits(group, orbit) {
      if (group.body) {group.body.orbit = orbit;return;}
      if (orbit) centers.push({id:group.id,orbit});
      group.children.forEach((child,index) => assignOrbits(child,group.orbits[index]));
    }
    let extent = Math.ceil(sizeGroup(root,false) + 240);
    // Keep the chosen grouping even when the looser orbit spacing exceeds the placement budget.
    if (extent > 14500) extent = Math.ceil(sizeGroup(root,true) + 240);
    assignOrbits(root,null);
    return {id,type:'procedural',name:bodies[0].name+'星区',extent,bodies,centers};
  }

  function systemLabel(system) {
    if (system.type !== 'procedural') return SYSTEM_LABELS[system.type];
    const stars = system.bodies.filter(body => body.kind === 'star').length;
    return system.bodies.length === stars ? `${stars} 颗恒星` : `黑洞 + ${stars} 颗恒星`;
  }

  function freeMotionSystem(id, configuration, seed, name, layout) {
    const random = randomFromSeed(`${layout}\0bodies\0${seed}\0${id}`);
    const velocity = randomFromSeed(`${layout}\0velocities\0${seed}\0${id}`);
    const radius = 10800, bodies = [], colors = [...STAR_COLORS];
    function vector(length,draw) {
      const z=2*draw()-1,azimuth=TAU*draw(),xy=length*Math.sqrt(1-z*z);
      return {x:xy*Math.cos(azimuth),y:xy*Math.sin(azimuth),z:length*z};
    }
    function add(kind,physical,color) {
      let initial;
      for(let attempt=0;attempt<256;attempt++){
        const point=vector((radius-physical.radius)*Math.cbrt(random()),random);
        if(bodies.every(body=>Math.hypot(point.x-body.initial.x,point.y-body.initial.y,point.z-body.initial.z)>=2800)){
          initial=point;break;
        }
      }
      if(!initial)throw new Error('无法为天体留出初始间距。');
      bodies.push({id:`${id}-${bodies.length+1}`,kind,name:name(kind),...physical,color,orbit:null,initial});
    }
    if(configuration.hasHole){
      const massSolar=9+9*random();
      add('blackHole',{massSolar,radius:massSolar*6.6},HOLE_COLORS[Math.floor(random()*HOLE_COLORS.length)]);
    }
    for(let i=0;i<configuration.starCount;i++)add('star',sampleStar(random),colors.splice(Math.floor(random()*colors.length),1)[0]);
    const speedScale=Math.sqrt(MU_PER_SOLAR_MASS*bodies.reduce((sum,body)=>sum+body.massSolar,0)/radius);
    for(const body of bodies){
      const {x:vx,y:vy,z:vz}=vector(speedScale*(.08+.92*velocity()),velocity);
      Object.assign(body.initial,{vx,vy,vz});
    }
    return {id,type:'procedural',name:bodies[0].name+'星区',extent:radius+240,bodies};
  }

  function generateWorld(input, options = {}) {
    const seed = typeof input === 'string' ? input.trim().normalize('NFC') : '';
    if (!seed || seed.length > 64) throw new RangeError('请输入 1–64 个字符的种子。');
    const freeMotion = options.layout === SPATIAL_LAYOUT || options.layout === FIRST_N_BODY_LAYOUT;
    const procedural = freeMotion || options.layout === PROCEDURAL_SPATIAL_LAYOUT;
    const scatter = procedural || options.layout === TRIPLE_SPATIAL_LAYOUT || options.layout === SCATTER_SPATIAL_LAYOUT;
    const includePlanets = !scatter && options.layout !== RING_SPATIAL_LAYOUT;
    const variedBodies = !includePlanets || options.layout === PROFILE_SPATIAL_LAYOUT;
    const spatial = variedBodies || options.layout === ORIGINAL_SPATIAL_LAYOUT;
    if ((options.layout !== undefined && !spatial) || (!spatial && options.moons !== undefined)) {
      throw new RangeError('天然卫星数量仅适用于 3D 地图。');
    }
    if (!includePlanets && (options.planets !== undefined || options.moons !== undefined)) {
      throw new RangeError('新版 3D 地图仅生成黑洞和恒星。');
    }
    validateCounts(options);
    const plan = procedural ? planProceduralSystems(seed,options) : scatter ? planSpatialSystems(seed, options) : planSystems(seed, options);
    const random = randomFromSeed(`${VERSION}\0layout\0${seed}`);
    const bodyRandom = randomFromSeed(`${PROFILE_SPATIAL_LAYOUT}\0bodies\0${seed}`);
    const range = (min, max) => min + (max - min) * random();
    const integer = (min, max) => Math.floor(range(min, max + 1));
    const pick = values => values[integer(0, values.length - 1)];
    const phase = () => range(0, TAU);
    const sample = ([min, max]) => min + (max - min) * bodyRandom();
    function sampleCompanion(massSolar) {
      const bodyClass = stellarClasses.find(key => massSolar < BODY_PROFILES[key].mass[1]) ?? 'supergiantStar';
      return {bodyClass, massSolar, radius: sample(BODY_PROFILES[bodyClass].radius)};
    }
    const name = generatedNames(seed);
    const count = plan?.length ?? integer(LIMITS.systems.min, LIMITS.systems.max);
    const orientation = scatter ? 0 : phase();
    const systems = [];

    for (let index = 0; index < count; index++) {
      const id = `system-${index + 1}`;
      const configuration = plan?.[index];
      if (procedural) {systems.push((freeMotion?freeMotionSystem:proceduralSystem)(id,configuration,seed,name,options.layout));continue;}
      const type = configuration?.type ?? (random() < .5 ? 'black-hole-companions' : 'binary');
      const bodies = [];
      const position = {};
      if (!scatter) {
        // Keep the legacy ring layout and its original random draw order.
        const direction = orientation + index * TAU / count + range(-.14, .14);
        const distance = range(35000, 52000);
        position.x = Math.round(Math.cos(direction) * distance * 1000) / 1000;
        position.y = Math.round(Math.sin(direction) * distance * 1000) / 1000;
      }
      let extent = 0;
      let binary, triple;
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
          const star = variedBodies ? sampleStar(bodyRandom) : legacy;
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
      } else if (type === 'hierarchical-triple') {
        const [primary,secondary] = [sampleStar(bodyRandom),sampleStar(bodyRandom)].sort((a,b) => b.massSolar - a.massSolar);
        const outer = sampleStar(bodyRandom);
        const innerId = `${id}-inner`;
        const innerSeparation = range(650, 1250);
        const outerSeparation = innerSeparation * range(7, 10);
        const [innerOrbit, outerOrbit] = pairOrbits(id, outerSeparation, phase(), primary.massSolar + secondary.massSolar, outer.massSolar);
        const innerOrbits = pairOrbits(innerId, innerSeparation, phase(), primary.massSolar, secondary.massSolar);
        triple = {innerId, innerOrbit, innerSeparation, outerSeparation};
        envelopes.set(innerId, innerOrbit.radius);
        const colors = [...STAR_COLORS];
        for (const [index, star] of [primary,secondary,outer].entries()) {
          const [color] = colors.splice(integer(0, colors.length - 1), 1);
          addBody('star', star.massSolar, star.radius, color, innerOrbits[index] ?? outerOrbit, star.bodyClass);
        }
      } else {
        const legacyPrimary = range(.85, 2.7);
        const primaryStar = variedBodies ? sampleStar(bodyRandom) : null;
        const primary = primaryStar?.massSolar ?? legacyPrimary;
        const minRatio = variedBodies ? Math.max(.32, BODY_PROFILES.dwarfStar.mass[0] / primary) : .32;
        const massRatio = range(minRatio, 1);
        const secondary = primary * massRatio;
        const totalMass = primary + secondary;
        const separation = range(820, 1850);
        const initialPhase = phase();
        const [primaryOrbit, secondaryOrbit] = pairOrbits(id, separation, initialPhase, primary, secondary);
        const primaryColor = pick(STAR_COLORS.slice(0, 3));
        const companionColor = pick(STAR_COLORS.slice(3, 7));
        const primaryRadius = range(33, 58), secondaryRadius = range(19, 41);
        const secondaryStar = variedBodies ? sampleCompanion(secondary) : null;
        addBody('star', primary, primaryStar?.radius ?? primaryRadius, primaryColor,
          primaryOrbit, primaryStar?.bodyClass);
        addBody('star', secondary, secondaryStar?.radius ?? secondaryRadius, companionColor,
          secondaryOrbit, secondaryStar?.bodyClass);
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

      const suffix = binary ? '双星区' : triple ? '三星区' : '伴星区';
      const system = {id, type, name: bodies[0].name + suffix, ...position, extent: Math.ceil(extent + 240), bodies};
      if (binary) system.binary = binary;
      if (triple) system.triple = triple;
      if (!scatter && (Math.hypot(system.x, system.y) + system.extent > MAP_RADIUS || systems.some(other =>
        Math.hypot(system.x - other.x, system.y - other.y) <= system.extent + other.extent))) {
        throw new Error('生成的星区超出地图边界或与相邻星区重叠。');
      }
      systems.push(system);
    }
    const world = {version: VERSION, seed, radius: MAP_RADIUS, systems};
    if(freeMotion)world.motion=N_BODY_MOTION;
    if (spatial) {
      if (scatter) scatterSystems(systems, seed, options.layout);
      else addSpatialLayout(systems, seed, options.moons, name);
      world.layout = options.layout;
      world.options = Object.fromEntries(['layout', 'systems', 'blackHoles', 'stars', 'planets', 'moons']
        .filter(key => options[key] !== undefined).map(key => [key, options[key]]));
    }
    return world;
  }

  function scatterSystems(systems, seed, layout) {
    const random = randomFromSeed(`${layout}\0positions\0${seed}`);
    const placed = [];
    const reserve = MAP_RADIUS / 2;
    const reserveCenters = [[reserve, 0, 0], [-reserve, 0, 0], [0, reserve, 0],
      [0, -reserve, 0], [0, 0, reserve], [0, 0, -reserve]];
    for (const system of systems) {
      const radiusLimit = MAP_RADIUS - system.extent - 1;
      const fits = ([x,y,z]) => Math.hypot(x,y,z) <= radiusLimit && placed.every(other =>
        Math.hypot(x-other.x,y-other.y,z-other.z) > system.extent + other.extent + 2000);
      let center;
      for (let attempt = 0; attempt < 128; attempt++) {
        // Sample distance directly so the outer shell does not dominate the map.
        const distance = radiusLimit * random();
        const height = 2 * random() - 1;
        const bearing = TAU * random();
        const horizontal = distance * Math.sqrt(1 - height ** 2);
        const candidate = [horizontal * Math.cos(bearing), horizontal * Math.sin(bearing), distance * height]
          .map(value => Math.round(value * 1000) / 1000);
        if (fits(candidate)) {center = candidate; break;}
      }
      // These sites are far enough apart that each placed system can block at most one.
      center ??= reserveCenters.find(fits);
      if (!center) throw new Error('无法为所有星区保留足够的三维间距。');
      [system.x, system.y, system.z] = center;
      placed.push(system);
    }
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
      if (system.centers) {
        const groupPlanes = new Map();
        for (const node of [...system.centers,...system.bodies]) {
          const parent = node.orbit?.parentId;
          if (!parent) continue;
          if (!groupPlanes.has(parent)) groupPlanes.set(parent,orbitalPlane(`procedural-orbit-v1\0${key}\0${parent}`));
          planes.set(node.id,groupPlanes.get(parent));
        }
        continue;
      }
      if (system.triple) {
        const outer = orbitalPlane(key);
        const random = randomFromSeed(`triple-tilt-v1\0${key}`);
        const outerInclination = Math.atan2(outer.sinInclination, outer.cosInclination);
        const tilt = .35 + .7 * random();
        const innerInclination = outerInclination + (outerInclination < Math.PI/2 ? tilt : -tilt);
        const inner = Object.freeze({...outer, cosInclination:Math.cos(innerInclination), sinInclination:Math.sin(innerInclination)});
        planes.set(system.triple.innerId, outer);
        for (const body of system.bodies) planes.set(body.id, body.orbit.parentId === system.triple.innerId ? inner : outer);
        continue;
      }
      const binaryPlane = system.binary ? orbitalPlane(key) : null;
      for (const body of system.bodies) {
        if (body.orbit) planes.set(body.id, binaryPlane && body.kind === 'star'
          ? binaryPlane : orbitalPlane(`${key}\0${body.id}`));
      }
    }
    return planes;
  }

  function bodyPositions(system, time = 0, planes) {
    if(system.bodies[0]?.initial)return system.bodies.map(body=>{
      const {x,y,z,vx,vy,vz}=body.initial;
      return {...body,x:system.x+x,y:system.y+y,z:system.z+z,vx,vy,vz};
    });
    const positions = new Map([[system.id, system]]);
    function place(body) {
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
    }
    if (system.triple) place({id:system.triple.innerId, orbit:system.triple.innerOrbit});
    for (const center of system.centers ?? []) place(center);
    return system.bodies.map(place);
  }

  return Object.freeze({VERSION, SPATIAL_LAYOUT, MAP_RADIUS, N_BODY_MOTION, N_BODY_SOFTENING, LIMITS, systemLabel, BODY_PROFILES, MU_PER_SOLAR_MASS, randomFromSeed, generateWorld, bodyPositions,
    orbitalPlane, orbitalOffset, worldOrbitalPlanes});
});
