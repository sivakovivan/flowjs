import type { Mutation } from "./mutations";
import type { VersionRecord } from "./store";

/*
 * Decision memory: what flow.js changed and how the developer reacted. It is
 * recalled into the next optimization so the runtime does not keep proposing a
 * change someone already undid. Storage is pluggable (BackBoard in the demo).
 */

export interface RecalledMemory {
  content: string;
  createdAt: string | null;
}

export interface FlowMemory {
  remember(content: string, metadata: Record<string, unknown>): Promise<void>;
  /** The most recent decisions for this application, newest first. */
  recall(limit: number): Promise<RecalledMemory[]>;
  reset(): Promise<void>;
}

export const RECALL_LIMIT = 6;

function describeMutations(mutations: Mutation[]): string {
  return mutations
    .map((m) => {
      switch (m.type) {
        case "MOVE":
          return `MOVE ${m.element} ${m.position} ${m.target}`;
        case "REORDER":
          return `REORDER ${m.element} to index ${m.index}`;
        case "RESIZE":
          return `RESIZE ${m.element} to ${m.size}`;
        case "SWAP_VARIANT":
          return `SWAP_VARIANT ${m.element} to ${m.variant}`;
        default:
          return `${m.type} ${m.element}`;
      }
    })
    .join("; ");
}

const label = (version: VersionRecord) =>
  `${version.id} "${version.reason}"${version.mutations.length ? ` (${describeMutations(version.mutations)})` : ""}`;

export const decisionMemory = {
  applied: (appId: string, version: VersionRecord, mode: "auto" | "manual", sessions: number) =>
    `[${appId}] flow.js applied ${label(version)} on top of ${version.parentVersionId}, ${
      mode === "auto" ? "automatically" : "approved by the developer"
    }, based on ${sessions} sessions.`,
  undone: (appId: string, undone: VersionRecord, active: VersionRecord) =>
    `[${appId}] The developer undid ${label(undone)} and returned to ${active.id}. Do not re-propose these mutations unless the evidence is materially stronger.`,
  restored: (appId: string, version: VersionRecord) => `[${appId}] The developer restored ${label(version)}.`,
};
