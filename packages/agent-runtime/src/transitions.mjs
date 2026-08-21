export const RUN_TRANSITIONS = Object.freeze({
  queued: ["running", "cancelled"],
  running: ["waiting_approval", "waiting_retry", "cancel_requested", "completed", "failed"],
  waiting_approval: ["running", "cancelled"],
  waiting_retry: ["running", "cancelled", "failed"],
  cancel_requested: ["cancelled"],
  completed: [],
  failed: [],
  cancelled: []
});

export const TOOL_TRANSITIONS = Object.freeze({
  queued: ["running", "cancelled"],
  running: ["waiting_approval", "waiting_retry", "cancel_requested", "succeeded", "failed"],
  waiting_approval: ["running", "cancelled"],
  waiting_retry: ["running", "cancelled", "failed"],
  cancel_requested: ["cancelled"],
  succeeded: [],
  failed: [],
  cancelled: []
});

export function canTransition(table, from, to) {
  return table[from]?.includes(to) ?? false;
}
