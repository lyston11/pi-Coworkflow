/**
 * The module registry.
 *
 * Order is run order: `trellis` creates the `.trellis/` tree and `AGENTS.md`
 * that later modules edit, so it goes first. Runtime-only modules come last;
 * they contribute no install artifacts and are always active.
 *
 * Adding a layer means adding a directory under `modules/` and one line here —
 * nothing else in the package knows about the individual modules.
 */

import type { WorkflowModule } from "../core/module.ts";
import { agentsMdModule } from "./agents-md/index.ts";
import { capacityModule } from "./capacity/index.ts";
import { laneWorktreeModule } from "./lane-worktree/index.ts";
import { panelModule } from "./panel/index.ts";
import { subagentContextModule } from "./subagent-context/index.ts";
import { subagentsModule } from "./subagents/index.ts";
import { trellisModule } from "./trellis/index.ts";
import { worktreeModule } from "./worktree/index.ts";

export const MODULES: WorkflowModule[] = [
  trellisModule,
  worktreeModule,
  agentsMdModule,
  subagentsModule,
  subagentContextModule,
  laneWorktreeModule,
  capacityModule,
  panelModule,
];

export function findModule(id: string): WorkflowModule | undefined {
  return MODULES.find((module) => module.id === id);
}

export function moduleIds(): string {
  return MODULES.map((module) => module.id).join(", ");
}
