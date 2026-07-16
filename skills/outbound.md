# skill: outbound — run work through Ouro instead of ad hoc

A portable, harness-agnostic regime for deciding when a unit of work belongs in an Ouro Run and
how to wrap it. Copy this file into your harness's skill directory and adapt the trigger wording;
the procedure has no harness dependencies.

## When a unit of work qualifies as a Run

Wrap it when **all** of these hold:

1. It is deterministic given pinned inputs (a script, a gate suite, a replayable check) — not an
   open-ended agentic edit session.
2. Its success is decidable by a gate (exit code today).
3. Someone may later ask "what exactly ran, against what, and why did we trust the result?" —
   pinning and the event chain answer that question for free.

Typical fits: quality-gate suites, migrations with a verifier, data checks, replay of a reviewed
procedure. Typical non-fits: exploratory coding, conversations, anything whose procedure you would
be writing while it runs.

## Procedure

1. **Root the work**: a real tracker item (`owner/repo#n`) is the Work source. No tracker item —
   create one; a Run without a Work root is unattributable.
2. **Root the knowledge** (once per question): Experiment + ProcedureDefinition in Negura, so the
   ContextBundle and Evidence have somewhere to live. See `examples/quality-gate/README.md` for
   the minimal chain.
3. **Vendor the procedure** into the target repository (`procedures/…`) and commit it. Repository
   owns the bytes; the Run pins commit + digest.
4. **Generate the request** (`examples/quality-gate/make-run-request.mjs` or hand-write from
   `contracts/fixtures/run-request.valid.json`). Declare the honest permission tier.
5. **Execute**: `ouro run --spec … [--allow-tier …]`. The gate decides the outcome — report it as
   the Run reported it.
6. **Fan out the results**:
   - telemetry: `ouro events export --target fukuro --run RUN-n | fukuro import`
   - evidence: delivered on success; `ouro negura flush` replays if it was pending.
7. **On failure**: the Run and its bounded stdout/stderr artifacts are the diagnosis input. Fix
   the workspace or the procedure (new commit, new digest), then run again — never edit a Run.

## Quality bar

- One Run = one Work item = one pinned procedure. Batching unrelated checks into one Run destroys
  attribution.
- If you cannot state the gate before running, the work is not ready for Ouro yet.
- Zero Runs in a session is normal; do not wrap work just to produce Runs.
