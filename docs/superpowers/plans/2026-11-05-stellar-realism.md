# Stellar Realism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the accepted realistic stellar preview into mission control, retaining the black hole and approved relative sizes.

**Architecture:** A shared offscreen WebGL renderer batches visible stars and composites them into the existing 2D scene. Linear artistic stellar radii preserve the preview ratio relative to the unchanged black-hole shadow. A stellar close-up selector uses the existing camera.

**Tech Stack:** Vanilla JavaScript, Canvas 2D, WebGL 1, Node.js built-in test runner.

**Spec:** `docs/superpowers/specs/2026-11-05-stellar-realism-design.md`

## Global Constraints

- Preserve existing uncommitted work, black-hole drawing and physical simulation.
- No dependencies, external images, model changes, database migrations or trajectory changes.
- Use the current checkout because the requested live integration builds on its uncommitted preview and prior fixes. Do not stage or commit unrelated work.
- Maximum zoom 64, minimum zoom derived from existing observable range.

## Review Focus

- Rendering unavailable/lost/restored: keep the mission usable with a 2D fallback, then restore details.
- Nine overlapping or offscreen stars: clip drawing work and preserve alpha composition and scene order.
- Pause, recovery and replay: retain current authoritative/observed/replay time separation.
- Close-up and manual camera gestures: release stellar tracking when panning, resetting or following satellites.
- Very small and very large views: linear ratios, fading subpixels, fresh procedural detail at near zoom.

### Task 1: Stellar renderer and proportional visual sizes

**Files:** `stellar-renderer.js`, `orbital-visuals.js`, `tests/stellar-renderer.test.cjs`, `tests/visual-scale.test.cjs`.

**Interfaces:** `OrbitalStellar.createRenderer(canvas)` produces `{ available, render({bodies,width,height,dpr,time}), destroy() }`; bodies contain `{x,y,radius,star}`. `OrbitalVisuals.stellarAppearance(scale,star)` retains its fields but uses the accepted linear artistic radius.

- [x] Add failing size and renderer lifecycle/batching tests.
- [x] Implement the accepted procedural shader, clipping, alpha composition, context recovery and Canvas fallback.
- [x] Run focused tests and compare unchanged black-hole function bodies against the pre-task snapshot.

### Task 2: Mission integration, camera and delivery

**Files:** `mission.js`, `mission.html`, `mission.css`, `server/index.js`, `tests/history-window.test.cjs`, `tests/api.test.cjs`, `README.md`.

- [x] Add failing mission tests for batching the field, selected-star tracking, camera reset and enlarged zoom.
- [x] Integrate the renderer, fallback, existing observation clock, close-up selector and max zoom 64; expose/version the new script.
- [x] Run focused tests, full `npm test`, and browser QA of live mission scene, close-up and recovery motion.
- [x] Restart the local service to load the static-file whitelist while preserving existing database progress; verify served assets and `/health`.
- [x] Obtain a focused read-only review and resolve introduced defects.
