# Trajectory Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap each satellite's lifetime trajectory history at 409,600 retained points, while its physics and live telemetry continue after the history is capped.

**Architecture:** Add a focused trajectory-budget policy module that owns legacy normalization, point admission, and public coverage metadata. The engine consults it at every retained-point boundary; capped satellites stop creating samplers while normal state checkpoints and lifecycle events continue. History, export, and UI use the resulting coverage endpoint instead of assuming that satellite lifetime and trajectory lifetime are identical.

**Tech Stack:** Node.js 24, `node:sqlite`, Worker Threads, native HTML/Canvas/JavaScript, Node test runner

**Spec:** `docs/superpowers/specs/2026-09-20-trajectory-budget-design.md`

## Global Constraints

- The nominal per-satellite lifetime trajectory budget is 104,857,600 bytes, represented by 409,600 points at 256 estimated bytes per point.
- SQLite hot points and gzip archive points share one lifetime budget; archiving never restores capacity.
- Physics continues at 240 Hz after capping, and current position, velocity, elapsed time, status, and lifecycle events remain durable.
- No coordinate point, including capture, observable-boundary, manual-termination, or export-cutoff points, may be added after the cap.
- Replay and export stop at the capped trajectory endpoint and explicitly disclose truncation.
- Existing records are upgraded from their durable `seq` and `lastSample` without rewriting historical points.
- No new runtime dependency or database table is introduced.

## Review Focus

- A sampler flush can return several points around the cap; only points through the exact maximum may be admitted.
- A capped active satellite can later terminate or cross the observable boundary; lifecycle state must change without moving the trajectory endpoint.
- Archived points are absent from the hot table; restart must use durable sequence metadata rather than recounting the hot table.
- Export creation normally adds a cutoff point; it must not do so for capped records.
- A trajectory query can request times later than coverage; the response must clamp cleanly rather than expose an empty misleading timeline.

---

### Task 1: Budget policy and engine admission

**Files:**
- Create: `server/trajectory-budget.js`
- Modify: `server/engine.js`
- Test: `tests/trajectory-budget.test.cjs`

**Interfaces:**
- Produces: `POLICY`, `createPolicy(maxPoints)`, `ensure(record, policy)`, `admit(record, point)`, `isCapped(record)`, and `coverage(record)`.
- `admit(record, point)` assigns the next sequence only when capacity remains and returns `true`; at the exact maximum it also fixes `cappedAt`.
- `coverage(record)` returns `{status, estimatedBytes, limitBytes, estimatedBytesPerPoint, maxPoints, lastSeq, endTick, endElapsedSeconds, truncated}`.

- [ ] **Step 1: Write failing budget and engine tests**

Create tests that use a three-point injected budget so the production limit need not be reached:

```js
test('third retained point caps a three-point lifetime budget',t=>{
  const {engine,user,satellite}=fixture(t,{trajectoryMaxPoints:3});
  engine.advanceTo(960);engine.checkpoint();
  const capped=engine.get(user,satellite.id),before=engine.trajectory(user,satellite.id,{limit:100}).points;
  assert.equal(capped.trajectoryCoverage.status,'capped');
  assert.equal(capped.trajectoryCoverage.lastSeq,3);
  engine.advanceTo(1920);engine.checkpoint();
  assert.equal(engine.trajectory(user,satellite.id,{limit:100}).points.length,3);
  assert.ok(engine.get(user,satellite.id).state.tick>capped.state.tick);
  assert.deepEqual(engine.trajectory(user,satellite.id,{limit:100}).points,before);
});

test('terminal state and restart do not append after trajectory cap',t=>{
  const f=fixture(t,{trajectoryMaxPoints:2});
  let engine=f.make(),p=engine.launch(f.user,launch);
  engine.advanceTo(480);engine.checkpoint();const endpoint=engine.get(f.user,p.id).trajectoryCoverage;
  engine.terminate(f.user,p.id);engine.close();engine=f.make();
  assert.equal(engine.get(f.user,p.id).status,'terminated');
  assert.deepEqual(engine.get(f.user,p.id).trajectoryCoverage,endpoint);
  assert.equal(engine.trajectory(f.user,p.id,{limit:100}).points.length,2);
});
```

Also test a legacy record at `seq === maxPoints`, a multi-point flush crossing the cap, and a record whose older points have been archived.

- [ ] **Step 2: Run the focused test and confirm the intended failures**

Run: `D:\node\node.exe --test tests/trajectory-budget.test.cjs`

Expected: FAIL because `server/trajectory-budget.js`, injected engine policy, and public coverage do not exist.

- [ ] **Step 3: Implement the pure budget policy**

Create `server/trajectory-budget.js` with immutable production constants and validation:

```js
const ESTIMATED_BYTES_PER_POINT=256;
const DEFAULT_MAX_POINTS=409600;
function createPolicy(maxPoints=DEFAULT_MAX_POINTS){
  if(!Number.isSafeInteger(maxPoints)||maxPoints<1)throw new TypeError('trajectory max points must be a positive safe integer');
  return Object.freeze({version:'point-budget-v1',estimatedBytesPerPoint:ESTIMATED_BYTES_PER_POINT,
    maxPoints,limitBytes:maxPoints*ESTIMATED_BYTES_PER_POINT});
}
const POLICY=createPolicy();
```

`ensure` must preserve a record's birth policy, infer legacy metadata from `seq` and `lastSample`, and mark a legacy record capped when `seq >= maxPoints`. `admit` must refuse capped records, assign `point.seq = ++record.seq`, update `lastSample`, and set the immutable `cappedAt` on the exact maximum.

- [ ] **Step 4: Integrate admission with every engine path**

Add `trajectoryMaxPoints=409600` to `Engine` constructor options and store `this.trajectoryPolicy=createPolicy(trajectoryMaxPoints)`. Normalize loaded live records before creating samplers. Initialize new records with the engine policy.

Change engine methods with these exact rules:

```js
enqueuePoint(r,p){
  if(!Budget.admit(r,p))return false;
  this.pending.push({id:r.id,p});this.dirty.add(r.id);
  if(Budget.isCapped(r))this.samplers.delete(r.id);
  return true;
}
```

`ensureSampler` returns `null` for capped records. `flushSampler` stops admitting at the first rejected point and never creates a kind-only fallback after cap. `advanceTo` pushes into a sampler only when non-null. `finish` still queues its event and dirty record when sampling is disabled.

- [ ] **Step 5: Run focused engine and recovery tests**

Run: `D:\node\node.exe --test tests/trajectory-budget.test.cjs tests/engine.test.cjs tests/recovery-export.test.cjs`

Expected: PASS with capped point counts fixed across advancement, termination, restart, and archive movement.

- [ ] **Step 6: Commit the engine budget unit**

```powershell
git add server/trajectory-budget.js server/engine.js tests/trajectory-budget.test.cjs
git commit -m "优化：限制单颗卫星轨迹存储预算"
```

### Task 2: Coverage-aware query and export

**Files:**
- Modify: `server/engine.js`
- Modify: `server/export-worker.js`
- Test: `tests/trajectory-budget.test.cjs`
- Test: `tests/recovery-export.test.cjs`
- Test: `tests/trajectory-store.test.cjs`

**Interfaces:**
- Consumes: `Budget.coverage(record)` from Task 1.
- Produces: `trajectoryCoverage` on public satellite records and trajectory responses; export records carry the same immutable coverage snapshot.

- [ ] **Step 1: Write failing query and export tests**

Add assertions for a capped active satellite:

```js
const result=e.trajectory(user,id,{fromTick:0,toTick:Number.MAX_SAFE_INTEGER,limit:100});
assert.equal(result.cutoffTick,result.trajectoryCoverage.endTick);
assert.equal(result.points.at(-1).seq,result.trajectoryCoverage.lastSeq);
const job=e.prepareExport(user,id,'json');
assert.equal(job.cutoffTick,result.trajectoryCoverage.endTick);
assert.equal(job.cutoffSeq,result.trajectoryCoverage.lastSeq);
assert.equal(job.trajectoryCoverage.truncated,true);
```

Run an export worker and assert JSON top-level `trajectoryCoverage` is capped, the last point is the capped endpoint, the current satellite state tick is later, and the description does not say “完整追踪时段”. Assert CSV first-row metadata contains `"truncated":true`.

- [ ] **Step 2: Run export tests and verify failure**

Run: `D:\node\node.exe --test tests/trajectory-budget.test.cjs tests/recovery-export.test.cjs tests/trajectory-store.test.cjs`

Expected: FAIL because query/export use `r.state.tick`, add active cutoff samples, and omit coverage metadata.

- [ ] **Step 3: Publish coverage and clamp history queries**

In `publicRecord`, attach `trajectoryCoverage: Budget.coverage(r)`. In `trajectory`, compute coverage after the existing consistency checkpoint and use:

```js
const requestedTo=integer(query.toTick,coverage.endTick);
const to=Math.min(requestedTo,coverage.endTick);
const cutoffSeq=integer(query.cutoffSeq,coverage.lastSeq,0,coverage.lastSeq);
```

Return the same coverage object beside `cutoffTick`, `cutoffSeq`, sampling, and calibration. Preserve boundary samples only within the capped sequence.

- [ ] **Step 4: Make export cutoff coverage-aware**

In `prepareExport`, call `sample(r,'cutoff')` only when the record is active and not capped. After checkpointing, snapshot coverage and use its `endTick` and `lastSeq` as export cutoffs. Keep the current public satellite record in the job so later current state remains visible.

In `server/export-worker.js`, add `trajectoryCoverage` to JSON/CSV metadata. Choose the description by `record.trajectoryCoverage.truncated`; the capped description must say the coordinates cover birth through the storage cap and later state/events may exist outside that coordinate series.

- [ ] **Step 5: Run query/export tests**

Run: `D:\node\node.exe --test tests/trajectory-budget.test.cjs tests/recovery-export.test.cjs tests/trajectory-store.test.cjs tests/api.test.cjs`

Expected: PASS for capped and uncapped JSON/CSV, archived reads, fixed export cutoffs, and ownership.

- [ ] **Step 6: Commit coverage-aware APIs and exports**

```powershell
git add server/engine.js server/export-worker.js tests/trajectory-budget.test.cjs tests/recovery-export.test.cjs tests/trajectory-store.test.cjs
git commit -m "优化：按轨迹覆盖范围回放和导出"
```

### Task 3: Mission-control cap presentation

**Files:**
- Modify: `mission.js`
- Modify: `mission.html`
- Test: `tests/history-window.test.cjs`

**Interfaces:**
- Consumes: satellite and trajectory `trajectoryCoverage` objects from Task 2.
- Produces: capped list/detail labels, bounded replay timeline, and export completion copy that distinguishes trajectory cutoff from satellite state.

- [ ] **Step 1: Write failing mission harness tests**

Extend the harness satellite with capped coverage and assert:

```js
assert.match(h.node('detailMeta').textContent,/轨迹记录已达约 100 MiB 上限/);
await h.node('history').onclick();
assert.equal(Number(h.node('timeline').max),coverage.endElapsedSeconds);
assert.match(h.node('historyMessage').textContent,/轨迹仅记录到存储上限/);
```

Add a recording-coverage case proving the existing lifecycle timeline remains unchanged. Add a capped export-poll result and assert the ready message says “轨迹截止” rather than “完整记录”.

- [ ] **Step 2: Run the mission tests and verify failure**

Run: `D:\node\node.exe --test tests/history-window.test.cjs`

Expected: FAIL because mission controls currently use `state.elapsedSeconds` and generic complete-export copy.

- [ ] **Step 3: Bind replay and labels to coverage**

Add a formatter that returns an empty string for recording trajectories and this disclosure for capped trajectories:

```js
const trajectoryNotice=s=>s?.trajectoryCoverage?.status==='capped'
  ? `轨迹记录已达约 100 MiB 上限 · 记录至 ${s.trajectoryCoverage.endElapsedSeconds.toFixed(3)} 模拟秒`
  : '';
```

Append the disclosure to list/detail metadata. When entering history, set the timeline maximum and initial seek from `trajectoryCoverage.endElapsedSeconds`. Preserve live current telemetry outside replay. Use the trajectory response coverage as the pinned request boundary.

Change export-ready copy to “轨迹导出已就绪 · 截止 tick …” and append the capped disclosure when applicable.

- [ ] **Step 4: Bump mission cache keys and run frontend tests**

Update `mission.js` cache key in `mission.html` to `trajectory-budget-1`.

Run: `D:\node\node.exe --test tests/history-window.test.cjs camera.test.cjs tests/visual-scale.test.cjs`

Expected: PASS with capped replay ending exactly at coverage and live HUD continuing from current state.

- [ ] **Step 5: Commit mission-control presentation**

```powershell
git add mission.js mission.html tests/history-window.test.cjs
git commit -m "优化：显示轨迹存储上限和截断范围"
```

### Task 4: Full verification, backup, deployment, and publication

**Files:**
- Modify only if verification exposes a defect in files from Tasks 1–3.

**Interfaces:**
- Consumes all previous task outputs.
- Produces a verified running service, an online-consistent pre-deployment backup, and pushed Git commits.

- [ ] **Step 1: Run the complete automated suite**

Run: `D:\node\node.exe --test physics.test.cjs camera.test.cjs tests/*.test.cjs`

Expected: all tests pass with zero failures, cancellations, or skipped tests.

- [ ] **Step 2: Check diff hygiene and policy constants**

Run:

```powershell
git diff --check
rg -n "104857600|409600|point-budget-v1|trajectoryCoverage" server mission.js tests
git status --short
```

Expected: no whitespace errors, policy values appear in the policy module and tests, and `.idea/` remains untracked.

- [ ] **Step 3: Create an online-consistent backup**

Run with a timestamped unused target:

```powershell
D:\node\node.exe server/backup.js backups/pre-trajectory-budget-20260920.sqlite
```

Expected: SQLite integrity and referenced trajectory sidecars validate before the backup is published.

- [ ] **Step 4: Restart and check the local service**

Stop only the PID recorded in `data/server.lock`, start `server/index.js` hidden with dedicated stdout/stderr logs, then request `http://127.0.0.1:4174/health`.

Expected: HTTP 200, `status: "running"`, no clock error, and prior satellite records remain readable.

- [ ] **Step 5: Browser-check capped behavior with an isolated data directory**

Start an ignored validation server on port 4175, open `http://localhost:4175/mission.html` in a hidden in-app browser tab, launch a test satellite under a small injected validation budget, and confirm the detail disclosure, replay endpoint, live telemetry continuation, and JSON export metadata. Close the tab and stop only the validation PID.

- [ ] **Step 6: Commit any verification fixes and push**

If verification required changes, commit only the affected tracked files. Push through `data/push-private.cjs`, then run `D:\node\node.exe data/push-private.cjs verify` and confirm the remote `main` hash equals local `HEAD`.

