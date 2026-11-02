---
name: stockharness-fork
description: Development now happens on the StockHarness fork, not upstream OpenHarness
metadata:
  type: project
---

As of 2026-10-23 the local checkout at /home/azureuser/projects/OpenHarness develops against
the user's fork **StockHarness**, for purpose-built stock features — not upstream OpenHarness.

- `origin` = `git@github.com:bhajian/StockHarness.git` (all commits/pushes/PRs go here).
- `upstream` = `git@github.com:deepfinery/OpenHarness.git` (pull upstream changes via
  `git fetch upstream && git merge upstream/main` when wanted).
- Local `main` tracks `origin/main`. Per [[AGENTS.md]] workflow, feature branches + PRs are now
  against StockHarness.
- The stock-data-sync work (FMP → MongoDB harness) lives in `deploy/stock-data-sync/` and is
  deployed live per [[aws-eks-deployment]].
