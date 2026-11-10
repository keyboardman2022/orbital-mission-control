# Runtime-only Simulation Clock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Remove offline catch-up; preserve saved simulation state, immediately activate launches, and resume legacy queued satellites.

**Architecture:** The worker supplies bounded monotonic elapsed time to `Engine.advanceRealtime(seconds)`. Only actual fixed-step integration advances simulation time; downtime, sleep gaps, and unprocessed steps beyond the work budget are discarded. Persisted ticks, coordinates and trajectories remain unchanged on restart. Legacy queued records receive a single birth at the restored world tick.

**Tech Stack:** Existing Node.js worker, SQLite transactions, 240 Hz shared integrator, built-in test runner. No dependencies or physical model changes.

**Spec:** User instruction: “去除补算逻辑，没必要”. This means service downtime freezes simulation progress; restarting resumes the saved world rather than integrating wall-clock downtime.

## Global Constraints

- Preserve all committed coordinates, samples, identifiers, credentials and world ticks.
- New launches become active immediately; activate legacy queues once, atomically with the restored checkpoint.
- Retain clock-rollback detection on startup and existing session/authentication behavior.
- Clamp each runtime elapsed interval to 0.1 seconds; retain fractional integration ticks, discard unprocessed whole-tick backlog.
- Work in the current running checkout; keep unrelated local preview/data artifacts untouched.

## Review Focus

- Month-long downtime or backup restore must not add simulated age or trajectory points.
- Legacy queue migration must write exactly one birth and remain idempotent across restart.
- Timer suspension must not accelerate new satellites or create accumulating target ticks.
- A zero work budget and fractional sub-tick intervals must not grow hidden backlog or lose fractional time.
- Existing startup clock-error handling, exports, archive and physics must remain valid.

### Task 1: Backend clock and queue removal

**Files:** `server/engine.js`, `server/simulation-worker.js`, `tests/recovery-export.test.cjs`.

- [x] Replace offline recovery regression with persisted-state freeze plus live-resume assertions; add bounded runtime, immediate launch and legacy migration tests; observe failures.
- [x] Implement `advanceRealtime(seconds,{budgetMs=12})`; remove wall-clock target and catch-up queue creation, migrate pending births on load, and drive only bounded runtime deltas from the worker.
- [x] Run focused tests and full suite; review the change against clock rollback and data preservation.

### Task 2: Documentation and live adoption

**Files:** `README.md`, running local service.

- [x] Update runtime/downtime/restore wording; remove claims of offline catch-up.
- [x] Restart only the project's service and verify `running`, zero lag, no queued records, existing progress and new launch behavior.
- [x] Obtain focused read-only review, resolve introduced issues, verify final full suite.


## Verification result

- New behavior regressions failed against the previous scheduler and passed after implementation.
- Full suite: 193 passed, 0 failed. Independent review approved; reviewer ran 26 focused tests.
- Live service: running, runtime-only-v1, lagSeconds=0; roughly 2 simulated seconds over a 2-second sampling interval.
- Legacy queue: 0 remaining; the pending record is active, initial conditions unchanged, exactly one birth event, satellite count preserved.
- Database backed up before restart to `backups/before-runtime-only-2026-11-05.sqlite` with integrity validation. Browser shows connected/running and real-time observation.
