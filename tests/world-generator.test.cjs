const {test} = require('node:test');
const assert = require('node:assert/strict');
const {generateWorld, bodyPositions} = require('../shared/world-generator.js');

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
