# Quality-gate golden path

Runs a repository's declared quality gates as a pinned, gated, replayable Ouro Run — with
knowledge roots in Negura and telemetry piped into Fukuro. This is the smallest real (non-demo)
outbound loop across the three tools.

## One-time setup

1. **Vendor the procedure into the target repository.** Procedure bytes are repository-owned:
   Ouro refuses artifacts outside the workspace.

   ```bash
   mkdir -p <target-repo>/procedures
   cp examples/quality-gate/procedure.mjs <target-repo>/procedures/quality-gate.mjs
   git -C <target-repo> add procedures && git -C <target-repo> commit -m "chore: vendor the ouro quality-gate procedure"
   ```

2. **Root the run in Negura knowledge** (once per question):

   ```bash
   negura claim      --title "Quality gates decide HEAD health" --statement "..."
   negura question   --title "Does <repo> HEAD pass its quality gates?" --question "..." --closure-rule "An Ouro run's exit_code gate decides."
   negura hypothesis --title "<repo> HEAD is gate-clean" --claim CLM-n --question QST-n --closes-when "..."
   negura experiment --title "Run <repo> quality gates under Ouro" --question QST-n --hypothesis HYP-n --success "Every declared command exits 0."
   negura procedure  --title "quality-gate procedure" --purpose "Run a declared command list and gate on the first failure." \
     --implementation-uri <repo procedures/quality-gate.mjs URL> --implementation-version pinned-per-run
   ```

## Each run

```bash
node examples/quality-gate/make-run-request.mjs \
  --work "owner/repo#123" \
  --workspace /abs/path/to/target-repo \
  --commands '[["npx","tsc"],["npm","test"]]' \
  --experiment EXP-n --procedure PROC-n > run-request.json

node dist/bin/ouro.js run --spec run-request.json --allow-tier workspace-write
node dist/bin/ouro.js events export --target fukuro --run RUN-n | npx fukuro import
node dist/bin/ouro.js negura flush   # deliver (or replay) the Evidence command
```

The generator pins the artifact from the workspace itself: `version` is the workspace HEAD
commit and `digest` is the sha256 of the vendored bytes, so `doctor` can verify the Run snapshot
and a replay executes exactly what was reviewed.

`workspace-write` is required because gate commands write caches and build outputs inside the
workspace. The tier is a declaration, not a sandbox — run untrusted repositories elsewhere.

## What lands where

- **Ouro**: the Run, Attempts, gate results, bounded stdout/stderr artifacts.
- **Negura**: one Evidence entry (idempotency-keyed) answering the Experiment's Question.
- **Fukuro**: the Run as loop `ouro:RUN-n` — `loop_start` / `tick` / `loop_end` pair in ledgers
  and KPIs like any native loop; re-imports skip on `sourceEventId`.
