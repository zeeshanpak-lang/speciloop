import { MAX_EVIDENCE_EVENTS } from "./domain/evidence-contract.js";

const completionEventsNeeded = Object.freeze({
  AWAIT_CALLOUT: 4,
  AWAIT_READBACK: 3,
  AWAIT_LABEL: 2,
  AWAIT_CONFIRMATION: 1,
});

export function canCompleteWithinEventLimit(session, maximumEvents = MAX_EVIDENCE_EVENTS) {
  const required = completionEventsNeeded[session.phase];
  if (!required) return session.phase === "COMPLETE";
  return session.audit.length + required <= maximumEvents;
}

export function eventsNeededForCompletion(phase) {
  return completionEventsNeeded[phase];
}
