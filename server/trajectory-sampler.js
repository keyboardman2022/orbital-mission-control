'use strict';
const {SCALE} = require('../shared/units.js');

const POLICY = Object.freeze({
  version:'time-linear-error-v1', blockTicks:240,
  positionToleranceKm:0.1, velocityToleranceKmS:0.1,
  velocityRelativeTolerance:0.001,
  interpolation:'linear-time', guarantee:'sampled-integrator-times'
});
const FIELDS = ['tick','elapsedSeconds','x','y','vx','vy'];
const WIDTH = FIELDS.length, CAPACITY = POLICY.blockTicks + 1;

function policyFor(calibration = SCALE, options = {}) {
  if (!calibration || !Number.isFinite(calibration.kmPerUnit) || calibration.kmPerUnit <= 0 ||
      !Number.isFinite(calibration.kmSPerUnit) || calibration.kmSPerUnit <= 0) {
    throw new TypeError('Sampler calibration requires positive finite position and velocity scales');
  }
  const relative = options.velocityRelativeTolerance === undefined
    ? POLICY.velocityRelativeTolerance : options.velocityRelativeTolerance;
  if (!Number.isFinite(relative) || relative < 0 || relative > 0.01) {
    throw new TypeError('Sampler relative velocity tolerance must be finite and between 0 and 0.01');
  }
  return Object.freeze({...POLICY, velocityRelativeTolerance:relative, calibrationVersion:calibration.version,
    positionToleranceScene:POLICY.positionToleranceKm / calibration.kmPerUnit,
    velocityToleranceScene:POLICY.velocityToleranceKmS / calibration.kmSPerUnit});
}

// Numeric states stay packed until a block is flushed. The stored anchor has
// already been emitted by the caller; each flush emits only subsequent states.
function createSampler(anchor, calibration = SCALE, options = {}) {
  const policy = policyFor(calibration,options);
  const values = new Float64Array(CAPACITY * WIDTH);
  const kinds = new Array(CAPACITY);
  const retained = new Uint8Array(CAPACITY);
  let count = 0;
  function push(snapshot) {
    if (count === CAPACITY) throw new RangeError('Sampler block is full; flush before push');
    if (!snapshot || !Number.isSafeInteger(snapshot.tick) || snapshot.tick < 0 ||
        !Number.isFinite(snapshot.elapsedSeconds) || snapshot.elapsedSeconds < 0) {
      throw new TypeError('Sampler requires an exact tick and finite elapsedSeconds');
    }
    const offset = count * WIDTH;
    if (count && (snapshot.tick < values[offset - WIDTH] || snapshot.elapsedSeconds < values[offset - WIDTH + 1])) {
      throw new RangeError('Sampler snapshots must be ordered by tick and elapsedSeconds');
    }
    for (let field = 0; field < WIDTH; field++) values[offset + field] = snapshot[FIELDS[field]];
    kinds[count] = snapshot.kind ?? 'sample';
    count++;
  }
  function snapshotAt(index) {
    const result = {};
    for (let field = 0; field < WIDTH; field++) result[FIELDS[field]] = values[index * WIDTH + field];
    result.kind = kinds[index];
    return result;
  }
  function flush() {
    if (count === 1) return [];
    retained.fill(0);
    retained[0] = retained[count - 1] = 1;
    for (let i = 1; i < count; i++) {
      if (kinds[i] !== 'sample') retained[i] = 1;
      // Equal-time samples have no interpolation interval. Preserve both,
      // including an error/termination event with zero substep duration.
      if (values[i * WIDTH + 1] === values[(i - 1) * WIDTH + 1]) retained[i - 1] = retained[i] = 1;
    }
    function fits(begin,end) {
      if (end - begin <= 1) return true;
      const a = begin * WIDTH, b = end * WIDTH;
      const duration = values[b + 1] - values[a + 1];
      if (!(duration > 0)) return false;
      for (let i = begin + 1; i < end; i++) {
        const offset = i * WIDTH;
        const fraction = (values[offset + 1] - values[a + 1]) / duration;
        const error = field => values[offset + field] -
          (values[a + field] + (values[b + field] - values[a + field]) * fraction);
        const positionError = Math.hypot(error(2), error(3)) / policy.positionToleranceScene;
        const velocityLimit = Math.max(policy.velocityToleranceScene,
          policy.velocityRelativeTolerance * Math.hypot(values[offset + 4],values[offset + 5]));
        const velocityError = Math.hypot(error(4), error(5)) / velocityLimit;
        // Invalid integrator states must survive as exact error evidence.
        const ratio = Number.isFinite(positionError) && Number.isFinite(velocityError)
          ? Math.max(positionError, velocityError) : Infinity;
        if (ratio > 1) return false;
      }
      return true;
    }
    const boundaries=[];
    for (let i=0;i<count;i++) if(retained[i]) boundaries.push(i);
    for (let segment=1;segment<boundaries.length;segment++) {
      let begin=boundaries[segment-1];const boundary=boundaries[segment];
      while(begin<boundary) {
        let end=boundary;
        if(!fits(begin,end)) {
          let low=begin+1,high=boundary;
          while(low+1<high) {
            const middle=Math.floor((low+high)/2);
            if(fits(begin,middle)) low=middle;else high=middle;
          }
          // Feasibility need not be monotonic. Every chosen interval was
          // actually checked; the search is conservative, not optimal.
          end=low;
        }
        retained[end]=1;begin=end;
      }
    }
    const result = [];
    for (let i = 1; i < count; i++) if (retained[i]) result.push(snapshotAt(i));
    const last = count - 1;
    values.copyWithin(0, last * WIDTH, (last + 1) * WIDTH);
    kinds[0] = kinds[last];
    kinds.fill(undefined, 1);
    count = 1;
    return result;
  }
  push(anchor);
  return Object.freeze({push, flush, get size() { return count; }});
}

module.exports = {POLICY, policyFor, createSampler};
