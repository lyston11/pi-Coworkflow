/**
 * The module registry.
 *
 * Order is run order: `trellis` creates the `.trellis/` tree and `AGENTS.md`
 * that later modules edit, so it goes first. Runtime-only modules come last;
 * they contribute no install artifacts and are always active.
 *
 * Adding a layer means adding a directory under `modules/` and one line here —
 * nothing else in the package knows about the individual modules.
 *
 * A new module also states `newSwitchDefault` when it is a *gate* rather than a
 * capability: what an absent switch key means in a project whose config was
 * written before the module existed. The default is `"on"`, which is right for
 * a module that only observes, records, or adds something — an upgrade may start
 * those by itself. A module that can refuse work (block a dispatch, enforce a
 * limit, reject a plan) declares `"off"`, so it never begins policing a project
 * that did not opt in. Today every module keeps `"on"`: `capacity` is the one
 * that would declare `"off"` if it were added now, and changing it here would
 * alter what an existing config means, which this rule must never do.
 */

import type { WorkflowModule } from "../core/module.ts";
import { agentKindsModule } from "./agent-kinds/index.ts";
import { agentsModule } from "./agents/index.ts";
import { capacityModule } from "./capacity/index.ts";
import { dispatchModule } from "./dispatch/index.ts";
import { laneWorktreeModule } from "./lane-worktree/index.ts";
import { panelModule } from "./panel/index.ts";
import { subagentContextModule } from "./subagent-context/index.ts";
import { subagentsModule } from "./subagents/index.ts";
import { trellisModule } from "./trellis/index.ts";
import { worktreeModule } from "./worktree/index.ts";

export const MODULES: WorkflowModule[] = [
  trellisModule,
  worktreeModule,
  agentsModule,
  subagentsModule,
  subagentContextModule,
  agentKindsModule,
  laneWorktreeModule,
  capacityModule,
  dispatchModule,
  panelModule,
];

export function findModule(id: string): WorkflowModule | undefined {
  return MODULES.find((module) => module.id === id);
}

export function moduleIds(): string {
  return MODULES.map((module) => module.id).join(", ");
}
