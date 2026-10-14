# GATE B Phase Baseline — 2026-10-14 (recorded BEFORE any change)

## Frozen state
- HEAD: `1ba60de` (tree clean, verified).
- Failing runs: 38517345801 (commit `c1ad52d`), 38519250546 (`a017e90`), 38519687136 (`407e107`) — GATE B fails identically on ubuntu+mac in all three; Windows green in all three.
- Decisive evidence (run 5, ubuntu): `Child PID must be terminated [state=S comm=MainThread cmdline=.../node/24.21.0/.../node /tmp/forge-gates-ws-*/child.js]` ~8 s after group SIGKILL. Rules out zombie (Z), PID reuse (cmdline match), timing (8 s poll).
- Standing fact: parent dead + grandchild dead + middle child (S, matching cmdline) alive after `process.kill(-pgid, SIGKILL)` where pgid = parent PID.

## Reproduction command (exact)
`node --import tsx --test test/capabilities/step6-empirical-gates.test.ts` — full file; the GATE B test is self-contained (spawns parent→child→grandchild, aborts, asserts death + heartbeat silence).

## Implementation under investigation (read-only so far)
- `src/environments/local.ts` `exec()`: `detached: true` on POSIX (group leader = direct child), `signal: opts.signal` (Node ALSO kills direct child natively on abort), `killSignal: "SIGKILL"`, `onAbort` → `process.kill(-pid, SIGKILL)` fallback `child.kill()`.
- `src/environments/execution/process-tree.ts` `killProcessTree()`: POSIX `process.kill(-hostPid, SIGKILL)` fallback direct kill (not on this test's path — the test aborts via `localEnv.exec` signal).
- Test fixture (`test/capabilities/step6-empirical-gates.test.ts:228-340`): parent/child scripts use plain `spawn` (no `detached`, no `setsid`), so all three MUST share the direct child's group — unless observed otherwise.

## Open hypotheses (ranked, to be discriminated by pgid evidence)
1. **H-group:** child.js is NOT in the parent's group at kill time (spawn/detached subtlety) → group SIGKILL provably misses it. Discriminator: pre-abort `pgid(child) != parentPid`.
2. **H-delivery:** group correct but signal not delivered as expected (double-killer race between Node-native abort kill and `onAbort`) → needs strace/`ps` at abort instant.
3. **H-identity:** pid-file crossing (asserting the wrong PID) → discriminated by cmdline match (already matching — weakens this hypothesis, does not kill it if files were swapped symmetrically).
4. **H-reaping:** ruled out (S ≠ Z). **H-reuse:** ruled out (cmdline match). **H-timing:** ruled out (8 s poll).

## Phase rule
Instrument (test-only `ps` snapshots, per-OS guarded) → CI observe → fix ONLY the demonstrated mechanism → CI prove. No `src/` edits until step 3 resolves to a mechanism.
