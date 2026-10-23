# Parent acceptance of B1 filesystem delivery

Native run 2252fa68 / workflow 7509d482 remains FAILED: provider tool-call stream ended with incomplete JSON and the required structured/acceptance report was absent. Do not rewrite those runtime records or treat that run as successful.

The actual B1 implementation and B1-handoff.md were both saved. Parent inspected per-host state, schedule/generation/late-disposal logic, passive error storage and persistent-listener handling. Parent reran `npm run typecheck` (pass) and `node --experimental-strip-types --test scripts/runtime-lifecycle.test.ts` (11/11 pass). No supervisor requests were pending. The filesystem delivery is accepted for continuing to B2; final cross-stage review is still required. No Stage A/B1 rerun.

Installed host correction: current docs/types describe `pi.on` returning an unsubscribe, so void-on handling is backward-compatible defense, not a claim that current host returns void.

Still outstanding and assigned to B2: public protocol fidelity, canonical worktree/task verification, registered-resource direct invocation validation, capability floor, ambiguous spawn handling, explicit worktree:false and semantic output validation. Registration must not expose a usable workflow if required child-extension registration has not succeeded; direct workflow resolution must enforce the same readiness as /Coworkflow:run.

For continuation only, use liu-dada/gpt-6-astra (the current parent provider/model) for bounded children after this provider tool-stream failure. Do not alter project/global model defaults, do not weaken structured output/acceptance or silently retry failed runs. The continuation skips stages[0] and starts public-contracts. The child whose saved artifacts are accepted is not relaunched.
