# Seed Map Preview Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan. Steps use checkbox syntax for tracking.

**Goal:** Generate and compare two seed maps containing black-hole companion systems and binary stars in a read-only preview.

**Architecture:** A shared browser and Node generator returns versioned map data and resolves body positions from orbit parents. A static page displays two independently generated maps and their parameters, using the application's existing static asset allowlist.

**Tech Stack:** Vanilla JavaScript, SVG, CSS and the Node test runner.

**Spec:** [Seeded system templates](../specs/2026-11-05-seeded-system-templates-design.md), with the user-approved first-phase scope and seed-generated body names.

## Constraints

- Support black-hole companion systems and binary stars, with 2–4 systems per map.
- Generate distinct names for the bodies in each map, including preview planets. Names must be deterministic for a seed and version.
- Use the shared position resolver for map drawings. Use read-only static preview assets and perform generation in the browser.
- Preserve existing simulation and persistence behavior.

## Tasks

- [x] Add focused generator tests for repeatability, parameter diversity, generated names, geometric limits and binary center of mass. Run them before implementation.
- [x] Implement `generateWorld(seed)` and `bodyPositions(system, time)` in `shared/world-generator.js` and run the focused tests.
- [x] Build `seed-preview.html`, `seed-preview.css` and `seed-preview.js`. Serve them with the generator through `server/index.js` and link the page from the mission header.
- [x] Verify the HTTP entry point, browser comparison, invalid input and responsive layout. Run the full test suite.
