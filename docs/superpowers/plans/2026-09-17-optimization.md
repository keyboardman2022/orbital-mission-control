# 轨迹存储与读取优化 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to execute bounded tasks and review results.

**Goal:** 减少轨迹写入与前端历史内存，同时保留积分、事件、恢复和完整已记录轨迹导出。

**Architecture:** 单写者 SQLite 保持 FULL/WAL。240 Hz 状态以一秒有界块进行时间插值误差简化；检查点原子提交精确恢复状态与简化点。不可变 gzip 分块归档与热数据通过同一读取接口访问；前端加载有界时间窗口；SSE 初次完整快照、随后轻量增量。

**Tech Stack:** Node.js 24 built-ins, SQLite, JavaScript Canvas.

**Spec:** 按用户授权实现误差控制采样、冷热归档、窗口读取与分页导出。位置容差0.1 km；严格速度模式0.1 km/s，默认相对速度模式max(0.1 km/s, 原始速度×0.001)。出生/终态/导出截止保留；仅保证积分采样时刻的回放误差，不改变物理模型。

## Global Constraints
- 不改 shared/simulation.js，不重写历史点；旧采样与新采样版本分别记录。
- 不降低 synchronous=FULL，不增加数据库并发写者，不删除不可恢复的记录。
- 一个块最多 240 次积分；每次检查点、终态、导出和关闭时 flush 部分块。
- 历史归档 gzip 无损；文件校验与原子发布先于 manifest+热行删除事务。
- 导出 cutoffSeq 固定，历史窗口包含相邻点，身份与乱序保护保持。
- 备份包含数据库 manifest 引用的不可变归档文件。
- 用户授权开发、合并与 push，最终提交备注为“优化”。

## Tasks
1. Sampler: server/trajectory-sampler.js + tests/sampler.test.cjs。Packed buffers; endpoint search with time-based position/velocity interpolation and verification of every chosen interval; test full raw orbits against reconstruction.
2. Engine: server/engine.js + tests/optimization-engine.test.cjs。Sampler map not public record; flush to pending; checkpoint persists sampler metadata/exact state; cached inserts; metrics. Test restart, no missing endpoint, lifecycle/cutoff, inner radius reduction.
3. Archive/export: server/trajectory-store.js, server/export-worker.js, server/backup.js + tests/trajectory-store.test.cjs。readPoints(db,filename,{id,after,fromTick,toTick,cutoffSeq,limit,boundaries}); archiveBatch(db,filename,{cutoffWorldTick,maxPoints}); gzip checksum, immutable files, atomic manifest/delete; paged export; snapshot backup with archive files. Test mixed archives/hot cursor, frozen cutoff, corruption, backup restore.
4. Frontend: mission.js + shared/history-window.js + tests/history-window.test.cjs。Window centered on target tick, full-lifetime timeline, bounded point cache, request cancellation/order guards; patch SSE merges into existing initial metadata. Test window bounds/interpolation/cache.
5. SSE/server: server/stream-snapshot.js + server/index.js + tests/stream-snapshot.test.cjs。Initial full records; changed current states thereafter, selected at 5Hz others at 1Hz, terminal immediately. Maintenance archive RPC and metrics. Validate ownership, reconnect.
6. Verification/docs: run full test suite, benchmark representative orbit point counts and reconstruction maxima, browser replay test with disposable localhost backend; online backup production before restart; merge main, commit “优化”, push and verify remote.

## Review checkpoints
Each task starts with a failing behavior test. Sampler and reader interfaces reviewed before engine integration. Whole diff reviewed for crash consistency, ownership, historical compatibility and resource bounds before commit.

## Recorded implementation decisions
- Compared real original sampling, strict absolute velocity mode increases circular point counts significantly. Optional precision question received no answer; proceed with stated recommended default 0.1% relative tolerance / 0.1 km/s floor, preserve strict configurable mode. Policy is pinned per satellite. Balanced raw reconstruction meets both bounds; old/new counts: near364/71, circular229/214, far386/386, capture38/33.
- Endpoint search replaces conservative binary midpoint splits. Feasibility is not assumed monotonic for correctness: each selected endpoint is actually checked against all raw intermediate states, guaranteed adjacent endpoint fallback; no minimum-point guarantee.
- Archive reader page transactions encompass manifest and hot rows, then release before async export writes; archive files remain immutable and are never pruned automatically.
- Review fixes: time-index hot window reads with cursor tick lower bound; exhausted cursors return without DB access; first history response immediately pins cutoff across cancelled pagination; replay controls hidden on show/clear; online backups pin a WAL snapshot and batch2048pages.
- Archive cadence one chunk/second (4096points cap) instead of one/five seconds; avoid maintenance when lag≥0.5s, expose archiveMs/error. Best effort, not a measured 1000-satellite concurrency guarantee.
