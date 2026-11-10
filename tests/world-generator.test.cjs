const {test} = require('node:test');
const assert = require('node:assert/strict');
const {generateWorld, bodyPositions, worldOrbitalPlanes, SPATIAL_LAYOUT} = require('../shared/world-generator.js');
const {createHash} = require('node:crypto');

function countWorld(world) {
  const counts = {systems: world.systems.length, blackHoles: 0, stars: 0, planets: 0};
  const keys = {blackHole: 'blackHoles', star: 'stars', planet: 'planets'};
  for (const body of world.systems.flatMap(system => system.bodies)) counts[keys[body.kind]]++;
  return counts;
}

test('custom seeds reproduce a map with the exact requested totals', () => {
  const options = {systems: 4, blackHoles: 2, stars: 13, planets: 7};
  for (let index = 0; index < 25; index++) {
    const seed = `custom-${index}`;
    const world = generateWorld(seed, options);
    assert.deepEqual(countWorld(world), options);
    assert.deepEqual(world, generateWorld(seed, {stars: 13, planets: 7, systems: 4, blackHoles: 2}));
    assert.notDeepEqual(world, generateWorld(`${seed}-other`, options));
    for (const system of world.systems) {
      const stars = system.bodies.filter(body => body.kind === 'star').length;
      assert.ok(system.binary ? stars === 2 : stars >= 3 && stars <= 5);
    }
  }
});

test('partial options can exclude or require black holes and infer compatible counts', () => {
  assert.equal(countWorld(generateWorld('no-holes', {blackHoles: 0})).blackHoles, 0);
  for (let index = 0; index < 20; index++) {
    assert.ok(countWorld(generateWorld(`required-${index}`, {blackHoles: 'required'})).blackHoles >= 1);
  }
  assert.deepEqual(countWorld(generateWorld('largest', {stars: 20, planets: 8})), {
    systems: 4, blackHoles: 4, stars: 20, planets: 8
  });
  assert.deepEqual(generateWorld('ORBITAL-06', {}), generateWorld('ORBITAL-06'));
});

test('impossible totals and invalid options give a clear error', () => {
  for (const options of [
    {systems: 2, blackHoles: 0, stars: 5},
    {systems: 2, planets: 5},
    {systems: 2, blackHoles: 3},
    {blackHoles: 'required', stars: 4}
  ]) assert.throws(() => generateWorld('invalid', options), /无法同时满足/);
  assert.throws(() => generateWorld('invalid', {stars: 6.5}), /恒星数/);
  assert.throws(() => generateWorld('invalid', {blackHoles: '0'}), /黑洞数/);
});

test('a seed reproduces the complete configuration, including generated planet names', () => {
  const world = generateWorld('双星实验 A');
  assert.deepEqual(world, generateWorld('双星实验 A'));
  const bodies = world.systems.flatMap(system => system.bodies);
  const planets = bodies.filter(body => body.kind === 'planet');
  assert.ok(planets.length >= world.systems.length);
  assert.equal(new Set(bodies.map(body => body.name)).size, bodies.length);
  assert.notDeepEqual(planets.map(body => body.name), generateWorld('双星实验 B').systems.flatMap(system => system.bodies.filter(body => body.kind === 'planet').map(body => body.name)));
  assert.throws(() => generateWorld('   '), RangeError);
  assert.throws(() => generateWorld('x'.repeat(65)), RangeError);
});

test('a seed sweep varies system counts, templates and physical and visual parameters', () => {
  const worlds = Array.from({length: 40}, (_, index) => generateWorld(`comparison-${index}`));
  assert.deepEqual(new Set(worlds.map(world => world.systems.length)), new Set([2, 3, 4]));
  const systems = worlds.flatMap(world => world.systems);
  assert.deepEqual(new Set(systems.map(system => system.type)), new Set(['black-hole-companions', 'binary']));
  const pairs = systems.filter(system => system.type === 'binary');
  for (const key of ['massRatio', 'separation', 'phase']) {
    assert.ok(new Set(pairs.map(system => system.binary[key])).size > 10, key);
  }
  const pairColors = pairs.map(system => system.bodies.filter(body => body.kind === 'star').map(body => body.color));
  assert.ok(pairColors.every(([a, b]) => a !== b));
  assert.ok(new Set(pairColors.map(colors => colors.join(','))).size > 10);

  for (const world of worlds) {
    assert.ok(world.systems.flatMap(system => system.bodies).filter(body => body.kind === 'star').length <= 24);
    for (const [index, system] of world.systems.entries()) {
      assert.ok(Math.hypot(system.x, system.y) + system.extent <= world.radius);
      for (const other of world.systems.slice(index + 1)) {
        assert.ok(Math.hypot(system.x - other.x, system.y - other.y) > system.extent + other.extent);
      }
      for (const time of [0, 50, 500]) {
        const positions = bodyPositions(system, time);
        for (const body of positions) {
          assert.ok(Math.hypot(body.x - system.x, body.y - system.y) + body.radius <= system.extent + 1e-7);
          assert.match(body.color, /^#[0-9a-f]{6}$/i);
        }
        for (const [index, body] of positions.entries()) {
          for (const other of positions.slice(index + 1)) {
            assert.ok(Math.hypot(body.x - other.x, body.y - other.y) > body.radius + other.radius);
          }
        }
      }
    }
  }
});

test('binary members keep their separation and weighted center while orbiting', () => {
  const system = Array.from({length: 20}, (_, index) => generateWorld(`pair-${index}`).systems).flat().find(system => system.type === 'binary');
  const starsAt = time => bodyPositions(system, time).filter(body => body.kind === 'star');
  const [initial, initialCompanion] = starsAt(0);
  assert.ok(Math.abs(initialCompanion.massSolar / initial.massSolar - system.binary.massRatio) < 1e-10);
  assert.ok(Math.abs(Math.atan2(initial.y - system.y, initial.x - system.x) - Math.atan2(Math.sin(system.binary.phase), Math.cos(system.binary.phase))) < 1e-8);
  for (const time of [0, 50, 500]) {
    const [a, b] = starsAt(time);
    const mass = a.massSolar + b.massSolar;
    assert.ok(Math.abs(Math.hypot(a.x - b.x, a.y - b.y) - system.binary.separation) < 1e-8);
    assert.ok(Math.abs((a.x * a.massSolar + b.x * b.massSolar) / mass - system.x) < 1e-8);
    assert.ok(Math.abs((a.y * a.massSolar + b.y * b.massSolar) / mass - system.y) < 1e-8);
  }
  assert.notEqual(starsAt(50)[0].x, initial.x);
});

test('3D seeds scatter systems in space and keep all orbital envelopes apart', () => {
  const options = {layout:SPATIAL_LAYOUT, systems:4, blackHoles:4, stars:20};
  let nearCenter=false, farFromCenter=false, sameSide=false, closeDirections=false;
  for (let index=0; index<200; index++) {
    const seed=`spatial-scatter-${index}`;
    const world=generateWorld(seed,options);
    assert.deepEqual(world,generateWorld(seed,options));
    for (const [i, a] of world.systems.entries()) {
      const distance=Math.hypot(a.x,a.y,a.z);
      assert.ok(distance+a.extent<=world.radius);
      nearCenter ||= distance<15000;
      farFromCenter ||= distance>65000;
      for (const b of world.systems.slice(i+1)) {
        assert.ok(Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)>a.extent+b.extent);
        const angle=Math.atan2(a.y,a.x)-Math.atan2(b.y,b.x);
        closeDirections ||= Math.cos(angle)>Math.cos(Math.PI/6);
      }
      if(i>0)sameSide ||= Math.sign(a.z)===Math.sign(world.systems[i-1].z);
    }
  }
  assert.ok(nearCenter&&farFromCenter,'systems can be near the center or far out');
  assert.ok(sameSide&&closeDirections,'systems can share a side of the map or a direction');
});

test('fixing one 3D quantity preserves the seed’s other choices where feasible', () => {
  const options={layout:SPATIAL_LAYOUT};
  for(let index=0;index<100;index++){
    const seed=`independent-count-${index}`;
    const baseline=generateWorld(seed,options);
    const {systems,blackHoles,stars}=countWorld(baseline);
    for(const fixed of [{systems},{blackHoles},{stars}]){
      assert.deepEqual(generateWorld(seed,{...options,...fixed}).systems,baseline.systems);
    }
    const required=generateWorld(seed,{...options,blackHoles:'required'});
    const counts=countWorld(required);
    assert.equal(counts.systems,systems);
    assert.ok(counts.blackHoles>=1);
  }
  assert.equal(generateWorld('forced-count',{...options,stars:32}).systems.length,4);
});

test('explicit legacy spatial seeds still reproduce the original map byte for byte', () => {
  for(const [layout,seed,counts,hash] of [
    ['spatial-v3','legacy-layout-archive',{systems:4,blackHoles:2,stars:12},'6d538b6fcf9d34da686fdf71cdd233cfc92293923cf07ee740af0a87f90856c3'],
    ['spatial-v4','legacy-layout-archive',{systems:4,blackHoles:2,stars:12},'190eebdd717e6bdd6fe79aa18c0614b3dfd327f608d3ec064aaf3f10e04e6df3'],
    ['spatial-v5','三星试飞',{systems:2,blackHoles:0,stars:5},'31884811cf3f92e62bc6232fc4799d4b2ef4706d7bcf46975fb7de83f6956047'],
    ['spatial-v7','body field',{systems:2,blackHoles:1,stars:4},'9f3e2a7d353b60ec2c88aa722e90e056db13202eccf41b2227d3f8802f068428']
  ]){
    const world=generateWorld(seed,{layout,...counts});
    assert.equal(createHash('sha256').update(JSON.stringify(world)).digest('hex'),hash);
  }
});

test('new maps support more stars and usually generate richer counts by default',()=>{
  let previous=0,current=0;
  for(let index=0;index<200;index++){
    const seed='richer-world-'+index;
    previous+=countWorld(generateWorld(seed,{layout:'spatial-v7'})).stars;
    current+=countWorld(generateWorld(seed,{layout:SPATIAL_LAYOUT})).stars;
  }
  assert.ok(current>1.5*previous);
  const dense=generateWorld('max stars',{layout:SPATIAL_LAYOUT,systems:4,blackHoles:4,stars:32});
  assert.deepEqual(countWorld(dense),{systems:4,blackHoles:4,stars:32,planets:0});
  assert.ok(dense.systems.every(system=>system.bodies.length===9));
});

test('equal-sized procedural systems can group their stars into different orbital trees',()=>{
  const options={layout:'spatial-v6',systems:2,blackHoles:0,stars:8};
  const rootShapes=new Set();
  for(let i=0;i<100;i++){
    const seed='random-groups-'+i,world=generateWorld(seed,options);
    assert.deepEqual(generateWorld(seed,options),world);
    const planes=worldOrbitalPlanes(world);
    for(const system of world.systems.filter(system=>system.bodies.length===4)){
      const members=[...system.centers,...system.bodies];
      const children=id=>members.filter(node=>node.orbit?.parentId===id);
      const leafCount=node=>children(node.id).reduce((sum,child)=>sum+leafCount(child),0)||1;
      rootShapes.add(children(system.id).map(leafCount).sort().join('+'));
      const separation=id=>children(id).reduce((sum,member)=>sum+member.orbit.radius,0);
      assert.ok(system.centers.every(center=>separation(center.orbit.parentId)>separation(center.id)));
      for(const t of [0,200,2000]){
        const positions=bodyPositions(system,t,planes);
        assert.equal(positions.length,4,'only actual stars appear in the field');
        const axes=['x','y','z'];
        const mass=positions.reduce((sum,star)=>sum+star.massSolar,0);
        for(const axis of axes)assert.ok(Math.abs(positions.reduce((sum,star)=>
          sum+(star[axis]-system[axis])*star.massSolar,0)/mass)<1e-8);
        for(const [index,a] of positions.entries()){
          assert.ok(Math.hypot(a.x-system.x,a.y-system.y,a.z-system.z)+a.radius<=system.extent);
          for(const b of positions.slice(index+1))assert.ok(Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)>a.radius+b.radius);
        }
      }
    }
  }
  assert.deepEqual([...rootShapes].sort(),['1+3','2+2']);
  const solo=generateWorld('single-star-group',{layout:'spatial-v6',systems:4,blackHoles:0,stars:4});
  assert.ok(solo.systems.every(system=>system.bodies.length===1&&system.bodies[0].orbit===null));
});
