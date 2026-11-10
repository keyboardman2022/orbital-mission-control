# Procedural Multi-System World Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed single-black-hole scene with a persistent, deterministic world containing 2–4 fixed black holes and 3–7 orbiting stars per black hole, and provide an atomic, destructive “regenerate world” flow that deletes all mission history.

**Architecture:** Add a shared deterministic world generator, bind the simulation API to a persisted world at runtime, and keep celestial bodies on prescribed paths while all bodies influence satellite gravity and collision detection. The server owns world lifecycle and atomic reset; the browser consumes the same world document for simulation previews, rendering, camera fitting, and stale-response rejection.

**Tech Stack:** Node.js 24, CommonJS/UMD JavaScript, `node:sqlite`, Web Workers, Canvas 2D/WebGL, Server-Sent Events, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-29-procedural-multi-system-world-design.md`

## Global Constraints

- Work from the current working tree. It already contains user-requested multi-star, visual scaling, WebGL history-layer, and replay UI changes; do not discard or rewrite them.
- Before every commit, inspect `git diff` and `git diff --cached`. If an already-dirty file is touched, stage only the task’s hunks and leave unrelated pre-existing hunks unstaged.
- Preserve exact replay behavior for archived missions. A record must always be interpreted with its stored `worldId`, `modelVersion`, and `dynamicsVersion`.
- Never use `Math.random()` for world generation. The world document must be reproducible from `seed + generatorVersion`.
- Generate and validate the replacement world before deleting any database row or file.
- Database changes are authoritative. Filesystem cleanup is retryable and must never roll back a successfully committed database reset.
- Keep the exact WebGL history canvas as an independent DOM layer; do not reintroduce per-frame `drawImage` copies.
- Do not reduce physical body count to meet the browser FPS target. Reduce distant visual detail only.

## Review Focus

Each item below is an easy-to-miss failure class and must be covered by the named owning task.

1. **Pathological generator seeds and impossible packing** — Task 1 tests many seeds, all count/separation/envelope constraints, deterministic failure, and invalid-world rejection.
2. **Two bodies crossed in one integration step** — Task 2 proves collision resolution chooses the earliest swept intersection, not array order.
3. **Corrupt or unsupported persisted world** — Task 3 proves startup refuses it instead of silently generating or migrating a replacement.
4. **Reset races with launch/export and stale world IDs** — Task 5 proves mutation draining, `expectedWorldId` conflict handling, export cancellation, and SSE world epoch reset.
5. **Late browser responses from the old world** — Task 6 proves old HTTP, worker, and SSE payloads are discarded after a world switch.

## Public Interfaces and File Map

### New shared world module

Create `shared/world.js` as a UMD module exposed as `OrbitalWorld` in the browser and as CommonJS in Node:

```js
const GENERATOR_VERSION = 'procedural-multi-system-v1';
const LEGACY_WORLD = { /* exact current fixed-nine configuration */ };

generateWorld({ seed, worldId, generation, createdAt }) => WorldDocument
validateWorld(world) => { ok: true } | { ok: false, error }
stellarBodiesAtTick(world, fieldTick) => BodyState[]
worldBounds(world) => { minX, minY, maxX, maxY, radius }
```

`WorldDocument` owns `worldId`, `generatorVersion`, `seed`, `generation`, `createdAt`, `modelVersion`, `dynamicsVersion`, `tickRate`, `observation`, `blackHoles`, and `stars`. Generated worlds use `modelVersion: 'pw-2d-v4'` and `dynamicsVersion: 'multi-system-pw-v1'`. `LEGACY_WORLD` uses the existing `pw-2d-v3` / `multi-attractor-pw-v1` pair.

### Runtime-bound simulation

Extend `shared/simulation.js`:

```js
createRuntime(world) => {
  WORLD, MODEL,
  validateLaunch, createState, step, snapshot,
  acceleration, fieldAcceleration, stellarBodiesAtTick,
  circularSpeed, circularRadiusForPeriod, escapeSpeed,
  effectiveMu, energy, angularMomentum
}
```

The existing top-level exports remain bound to `LEGACY_WORLD` for old tests and callers. New server and browser code must use `createRuntime(world)`.

### Engine and reset lifecycle

Add these engine methods:

```js
engine.modelInfo() => { world, model }
engine.storageReferences() => { archiveFiles, exportIds }
engine.resetWorld(candidate, { expectedWorldId }) => {
  world, removed: { satelliteCount, pointCount, eventCount, chunkCount, exportCount },
  files: { archiveFiles, exportIds }
}
```

Add `POST /api/world/reset` with JSON:

```json
{
  "expectedWorldId": "current-world-id",
  "confirmation": "重新生成星系"
}
```

The endpoint remains subject to session, same-origin, CSRF, loopback-only, and a server-wide mutation barrier.

### Browser world ownership

`mission.js` owns `currentWorld` and `simulation = OrbitalModel.createRuntime(currentWorld)`. Every launch and asynchronous result carries a `worldId`; mismatched results are ignored. `preview-worker.js` receives the world document before running a preview.

---

## Task 1: Deterministic world generation and validation

**Files:**

- Create: `shared/world.js`
- Create: `tests/world-generation.test.cjs`

- [ ] Write failing generator contract tests.

```js
const World = require('../shared/world.js');

test('same seed and generator version produce identical bodies', () => {
  const input = { seed: 'seed-a', worldId: 'w-a', generation: 1, createdAt: '2026-09-29T00:00:00.000Z' };
  assert.deepEqual(World.generateWorld(input), World.generateWorld(input));
});

test('generated worlds obey body-count, separation, and observation constraints', () => {
  for (let i = 0; i < 500; i += 1) {
    const world = World.generateWorld({ seed: `seed-${i}`, worldId: `w-${i}`, generation: 1, createdAt: '2026-09-29T00:00:00.000Z' });
    assert.equal(World.validateWorld(world).ok, true);
    assert.ok(world.blackHoles.length >= 2 && world.blackHoles.length <= 4);
    assert.ok(world.stars.length <= 24);
  }
});
```

Also assert: each black hole owns 3–7 stars; primary is at `(0, 0)`; secondary centers stay inside the observation envelope; black-hole centers are at least `26_000` units apart; each system envelope is at most `12_000`; star orbital radii are strictly increasing per host and span near/far bands; IDs are unique; masses, radii, colors, inclinations, phases, and direction signs are finite and in range. Include intentionally malformed documents and a deterministic impossible-packing fixture.

- [ ] Run `node --test tests/world-generation.test.cjs` and confirm it fails because `shared/world.js` does not exist.

- [ ] Implement a small fixed-seed PRNG, stable ID derivation, world generation, body-at-tick projection, bounds calculation, and strict validation.

Generation rules to encode as named constants: 2–4 black holes, 3–7 stars per black hole, 24-star total cap, primary at origin, secondary center radius `28_000..72_000`, minimum center separation `26_000`, system envelope `12_000`, observation radius `90_000`, and bounded placement attempts. Return an error on exhausted placement; never relax constraints implicitly.

- [ ] Run `node --test tests/world-generation.test.cjs`; expect all tests to pass.

- [ ] Commit only Task 1 files with message `feat: add deterministic multi-system world generator`.

## Task 2: Bind physics to a world and add multi-body gravity/collisions

**Files:**

- Modify: `shared/simulation.js`
- Create: `tests/multi-system.test.cjs`
- Modify as required: `tests/simulation.test.cjs`, `tests/multi-star.test.cjs`, `tests/two-body.test.cjs`

- [ ] Write failing runtime tests for procedural and legacy worlds.

Cover these contracts:

```js
const Simulation = require('../shared/simulation.js');
const World = require('../shared/world.js');
const runtime = Simulation.createRuntime(World.generateWorld(fixture));

assert.equal(runtime.WORLD.worldId, fixture.worldId);
assert.equal(runtime.MODEL.dynamics.version, 'multi-system-pw-v1');
```

Test vector-summed acceleration from all black holes and stars; one shared celestial-body calculation per tick; slow motion for distant stars; collisions against every body; legacy top-level exports still reproducing current fixed-nine results; and a swept step intersecting two bodies choosing the smaller intersection fraction even when that body appears later in the array.

- [ ] Run `node --test tests/multi-system.test.cjs tests/simulation.test.cjs tests/multi-star.test.cjs tests/two-body.test.cjs`; expect the new tests to fail on missing `createRuntime`.

- [ ] Refactor the current constants/functions behind `createRuntime(world)` without duplicating the integrator.

Compute black-hole Paczyński–Wiita acceleration around each black-hole center. Compute softened Newtonian acceleration for each star. Cache immutable body states by `fieldTick` inside the runtime so all satellites advanced at that tick share the same body array. Collision sweeping must compare intersection fractions for all bodies and return the earliest hit with `{ kind, bodyId, hostId, x, y }`.

- [ ] Keep compatibility dispatch for `two-body-pw-v1` and `multi-attractor-pw-v1`; reject an unknown dynamics version explicitly.

- [ ] Run the focused test command again; expect all tests to pass.

- [ ] Commit Task 2 hunks with message `feat: simulate satellites in persisted multi-system worlds`.

## Task 3: Persist worlds and migrate the current database safely

**Files:**

- Modify: `server/engine.js`
- Modify: `server/simulation-worker.js`
- Modify: `tests/engine.test.cjs`
- Create: `tests/world-persistence.test.cjs`

- [ ] Write failing persistence and migration tests using temporary databases.

Test fresh database creation; exact world preservation across close/reopen; an existing `pw-2d-v3` database with no world metadata registering `LEGACY_WORLD`; backfilling missing record `worldId`/`worldVersion` without changing points; new launches carrying the active world ID; and startup failure for malformed JSON, unsupported generator versions, or model/world version disagreement.

- [ ] Run `node --test tests/world-persistence.test.cjs tests/engine.test.cjs`; expect failures on missing world metadata/runtime ownership.

- [ ] Make `Engine` load and validate `meta.world`, create `this.simulation`, and replace static `M.*` use with the runtime.

Use one startup transaction for the exact legacy migration. Do not generate a procedural world during startup. `modelInfo()` must return the full active world plus runtime model; the worker’s `model` RPC must call it instead of returning the static model. Include `worldId` and `worldVersion` in new records, public records, trajectory/export metadata, and health/model responses.

- [ ] Add worker allow-list entries for the read-only world/model methods.

- [ ] Run the focused tests; expect all to pass.

- [ ] Commit Task 3 hunks with message `feat: persist active world and migrate legacy databases`.

## Task 4: Implement the atomic engine reset transaction

**Files:**

- Modify: `server/engine.js`
- Modify: `server/trajectory-store.js` if a transactional chunk-deletion hook is needed
- Create: `tests/world-reset-engine.test.cjs`

- [ ] Write failing engine reset tests.

Cover candidate validation before mutation; optimistic `expectedWorldId` conflict; successful deletion of satellites, points, events, trajectory chunks, and exports while retaining users/sessions; generation increment; clock reset; in-memory record/sampler reset; old satellite lookup returning not found; and the returned list of files that need cleanup.

Add a deliberate SQLite trigger failure midway through reset and assert that the old world and every mission row remain intact after rollback.

- [ ] Run `node --test tests/world-reset-engine.test.cjs`; expect failure because `resetWorld` is absent.

- [ ] Implement `Engine.resetWorld(candidate, { expectedWorldId })` as one SQLite transaction.

The method validates the complete candidate before opening the transaction, verifies the expected ID again inside the transaction, deletes mission-owned rows in foreign-key-safe order, writes `meta.world`, writes the candidate model metadata, resets the clock, commits, then swaps the in-memory runtime. It returns archive/export references but performs no filesystem operations.

- [ ] Implement `storageReferences()` for startup orphan reconciliation.

- [ ] Run the focused test; expect all tests to pass.

- [ ] Commit Task 4 hunks with message `feat: reset world and mission data atomically`.

## Task 5: Expose guarded reset API, reset SSE epochs, and clean orphan files

**Files:**

- Modify: `server/index.js`
- Modify: `server/simulation-worker.js`
- Modify: `server/stream-snapshot.js`
- Create: `server/storage-cleanup.js`
- Modify: `tests/api.test.cjs`
- Modify: `tests/stream-snapshot.test.cjs`
- Create: `tests/storage-cleanup.test.cjs`

- [ ] Write failing API, concurrency, snapshot, and cleanup tests.

Test unauthenticated, missing-CSRF, wrong-origin, non-loopback, incorrect confirmation, and stale `expectedWorldId` requests. Test a reset waiting for an in-flight launch/export mutation barrier, then rejecting new mutations while reset is active. Test queued/running exports are cancelled before reset RPC. Test SSE clears its known-record cache when `worldId` changes and emits a full snapshot for the new epoch.

For cleanup, test only canonical files under `data-v3/archives` and `data-v3/exports` can be removed; missing files are success; other failures are reported and left for startup retry; referenced files are never treated as orphans.

- [ ] Run `node --test tests/api.test.cjs tests/stream-snapshot.test.cjs tests/storage-cleanup.test.cjs`; expect new tests to fail.

- [ ] Add `resetWorld` and `storageReferences` to the simulation worker RPC allow-list.

- [ ] Add a server mutation barrier with these semantics: set reset mode; stop admitting launch/terminate/delete/export mutations; drain admitted mutations; generate and validate the candidate in memory; cancel queued/running exports; call worker reset with `expectedWorldId`; run best-effort file cleanup; release reset mode in `finally`.

Generate `worldId` with `randomUUID()` and the seed with 128 cryptographic bits. Return `409` for stale world, `423` while reset is active, and a structured cleanup warning without claiming the database reset failed.

- [ ] Add loopback detection based on the actual socket remote address, including IPv4-mapped loopback, rather than trusting headers.

- [ ] Make every stream snapshot include `worldId`; update `createSnapshotState` to remember it and clear `known` on change.

- [ ] Run startup orphan reconciliation after the engine reports ready, and after each reset cleanup attempt.

- [ ] Run the focused tests; expect all tests to pass.

- [ ] Commit Task 5 hunks with message `feat: expose guarded world regeneration endpoint`.

## Task 6: Make browser simulation and workers world-aware

**Files:**

- Modify: `server/index.js` static-file allow-list
- Modify: `mission.html`
- Modify: `mission.js`
- Modify: `preview-worker.js`
- Modify: `tests/launcher.test.cjs`
- Modify: `tests/live-trajectory.test.cjs`
- Create: `tests/browser-world-switch.test.cjs`

- [ ] Write failing browser-harness tests for model bootstrap and world switching.

Test that `/api/model` creates the runtime used by launch validation and preview; launch bodies contain the current `worldId`; preview requests carry both request ID and world ID; and switching to a new world clears selected satellite, history window/cache, WebGL exact trail, sweep results, pending preview, interpolation samples, and event lists.

Explicitly resolve an old-world fetch, worker message, and SSE message after the switch and assert none can repopulate cleared state.

- [ ] Run `node --test tests/browser-world-switch.test.cjs tests/launcher.test.cjs tests/live-trajectory.test.cjs`; expect failures on static-model assumptions.

- [ ] Serve and load `shared/world.js` before `shared/simulation.js`.

- [ ] In `mission.js`, separate the module (`OrbitalModel`) from the active runtime (`simulation`). Apply server model responses through one `applyWorld(world)` function that validates the document, creates a new runtime, updates `currentWorldId`, and performs the complete state reset.

- [ ] Include `worldId` in launch, history, and preview coordination. Drop mismatched asynchronous results at their final application point, not only when requests begin.

- [ ] In `preview-worker.js`, cache runtimes by world ID only after validating the supplied world. Return `{ requestId, worldId, ... }` and reject unsupported versions.

- [ ] Run the focused tests; expect all tests to pass.

- [ ] Commit Task 6 hunks with message `feat: switch browser simulation with world epochs`.

## Task 7: Render multiple systems and fit the camera to the world

**Files:**

- Modify: `camera.js`
- Modify: `camera.test.cjs`
- Modify: `orbital-visuals.js`
- Modify: `mission.html`
- Modify: `mission.css`
- Modify: `mission.js`
- Modify: `tests/visual-scale.test.cjs`
- Modify: `tests/multi-star.test.cjs`

- [ ] Write failing camera and rendering-harness tests.

Add `fitBounds(width, height, bounds, padding)` tests for asymmetric multi-system bounds, minimum/maximum zoom clamps, and resize stability. Test one marker per black hole, one capture-radius ring per black hole, star orbit rings around the assigned host, star scale following camera zoom, and per-body collision highlights.

Test the far-star visual detail threshold changes particle/ring work only; body position, size hitbox, gravity, and collision data must remain identical.

- [ ] Run `node --test camera.test.cjs tests/visual-scale.test.cjs tests/multi-star.test.cjs`; expect new assertions to fail.

- [ ] Add `Camera.fitBounds` and a reusable clamped world-marker helper while retaining existing origin helpers for compatibility.

- [ ] Replace the single `#blackHoleMarker` assumption with a marker container populated from the world. Preserve accessible button labels and focus behavior.

- [ ] Draw every black hole with body-specific apparent size, disk hue, tilt, and phase; draw capture rings and orbit guides around each host center. Reuse cached textures and avoid allocating gradients/particle arrays per frame.

- [ ] Keep the existing visual-only size multipliers. Camera zoom changes must transform black holes, stars, their particle effects, orbit guides, and collision effects through the same world-to-screen scale.

- [ ] Add distant-star LOD based on projected radius: retain core/glow and reduce only decorative particles/rings below the threshold.

- [ ] Make “reset view” call `fitBounds` over `OrbitalWorld.worldBounds(currentWorld)`.

- [ ] Run the focused tests; expect all tests to pass.

- [ ] Commit Task 7 hunks with message `feat: render and frame multiple stellar systems`.

## Task 8: Add the destructive regenerate-world dialog

**Files:**

- Modify: `mission.html`
- Modify: `mission.css`
- Modify: `mission.js`
- Create: `tests/world-reset-ui.test.cjs`

- [ ] Write failing DOM-harness tests.

Test the danger button opens a modal dialog; confirmation stays disabled until the exact text `重新生成星系` is entered; cancel is non-destructive; submitting sends CSRF plus the current `expectedWorldId`; controls are locked while pending; a success applies the returned world and visibly reports cleanup warnings; `409` reloads current model without retrying; and focus returns safely when the dialog closes.

- [ ] Run `node --test tests/world-reset-ui.test.cjs`; expect failure because the controls do not exist.

- [ ] Add a semantic `<dialog>` with explanatory copy that explicitly says all satellites, trajectories, events, and exports are deleted. Do not hide this action inside the normal launch form.

- [ ] Implement one submit path using the existing authenticated API helper. Keep the UI locked until `applyWorld` completes; never optimistically clear the current world before server success.

- [ ] Run the focused test; expect all tests to pass.

- [ ] Commit Task 8 hunks with message `feat: add confirmed world regeneration controls`.

## Task 9: Enforce performance gates and finish integration documentation

**Files:**

- Create: `tools/benchmark-multi-system.cjs`
- Create: `tests/multi-system-performance.test.cjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `方案.md`
- Modify as required: `tests/recovery-export.test.cjs`, `tests/optimization-engine.test.cjs`, `tests/history-webgl.test.cjs`

- [ ] Write a deterministic max-world fixture: 4 black holes, 24 stars, and 1,000 active satellites.

- [ ] Add a correctness-oriented performance test that verifies one celestial-body projection per tick and the expected number of satellite/body acceleration evaluations without relying on wall-clock timing.

- [ ] Add `npm run benchmark:multi-system`, which warms up the runtime, runs multiple one-simulated-second samples, reports median/p95, and exits nonzero when median exceeds `800 ms` on the designated development machine.

- [ ] Run `node --test tests/multi-system-performance.test.cjs`; expect it to fail until shared per-tick calculation is observable/instrumented.

- [ ] Implement minimal benchmark instrumentation that is disabled by default and does not allocate in production stepping.

- [ ] Run `npm run benchmark:multi-system`; expect median below `800 ms`. Record the measured median/p95 in the implementation handoff, not as a hard-coded README claim.

- [ ] Run browser performance QA at maximum generated world size and confirm at least `45 FPS` on the current development machine during live view and history replay. If it misses, profile and reduce only distant decorative detail.

- [ ] Update README and `方案.md` with world persistence, manual reset behavior, destructive confirmation, startup command, model/generator versions, and benchmark command.

- [ ] Run the full verification suite:

```powershell
npm test
npm run benchmark:multi-system
```

Expect every test to pass, no unhandled worker/SSE errors, and benchmark success.

- [ ] Start the server with `npm start`, open the mission page, generate at least three worlds, restart once without regeneration, and verify: restart preserves the world; regeneration changes it; old satellite/history/export URLs return not found; reset view frames every system; distant stars orbit slowly; zoom scales all celestial visuals together.

- [ ] Review `git status --short`, `git diff`, and `git diff --cached` to confirm no user-owned unrelated change was discarded or accidentally included.

- [ ] Commit final integration files with message `test: verify procedural multi-system world lifecycle`.

## Final Review Checklist

- [ ] Compare every accepted design-spec section with at least one implementation task and one automated or manual verification.
- [ ] Confirm the five Review Focus failures have explicit automated tests in their owning tasks.
- [ ] Confirm the persisted world is the single source of truth for server physics, preview physics, visuals, camera bounds, exports, and replay.
- [ ] Confirm ordinary restart never regenerates or deletes a world.
- [ ] Confirm reset can leave retryable orphan files but cannot leave a partially reset database.
- [ ] Confirm legacy `pw-2d-v3` databases open without data loss and unsupported versions fail loudly.
- [ ] Confirm no code path silently substitutes a fresh world after parse, validation, or version failure.
- [ ] Confirm history WebGL remains a standalone overlay and replay does not regain removed speed/distance telemetry.
