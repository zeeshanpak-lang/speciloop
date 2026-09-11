import { INPUT_MODES, inputModeAllowedForEvent } from "./evidence-contract.js";
import { verifyLabel, verifyReadbackAgainstCallout, verifyStatement } from "./verifier.js";

function makeEvent(session, kind, actor, message, transcript, inputMode) {
  if (!inputModeAllowedForEvent(kind, inputMode)) {
    throw new Error(`Unsupported input mode ${inputMode || "none"} for ${kind}.`);
  }
  return {
    id: `${session.id}-${session.audit.length + 1}`,
    sequence: session.audit.length + 1,
    at: new Date().toISOString(),
    kind,
    actor,
    message,
    ...(transcript ? { transcript } : {}),
    ...(inputMode ? { inputMode } : {}),
  };
}

function append(session, event) {
  return { ...session, audit: [...session.audit, event] };
}

export function createSession(order) {
  const session = {
    id: crypto.randomUUID(),
    order,
    phase: "AWAIT_CALLOUT",
    audit: [],
  };
  return append(
    session,
    makeEvent(session, "SESSION_STARTED", "SYSTEM", `Synthetic case ${order.caseId} loaded.`),
  );
}

export function submitCallout(session, transcript, inputMode = INPUT_MODES.MANUAL_TEXT) {
  if (session.phase !== "AWAIT_CALLOUT") throw new Error(`Callout rejected in phase ${session.phase}.`);
  const result = verifyStatement(session.order, transcript);
  const accepted = result.status === "ACCEPT";
  const next = append(
    session,
    makeEvent(
      session,
      accepted ? "CALLOUT_ACCEPTED" : "CALLOUT_REJECTED",
      "SURGEON",
      result.summary,
      transcript,
      inputMode,
    ),
  );
  return {
    session: accepted
      ? { ...next, phase: "AWAIT_READBACK", callout: result.parsed, calloutInputMode: inputMode }
      : next,
    result,
  };
}

export function submitReadback(session, transcript, inputMode = INPUT_MODES.MANUAL_TEXT) {
  if (session.phase !== "AWAIT_READBACK" || !session.callout) {
    throw new Error(`Read-back rejected in phase ${session.phase}.`);
  }
  const result = verifyReadbackAgainstCallout(session.order, session.callout, transcript);
  const accepted = result.status === "ACCEPT";
  const next = append(
    session,
    makeEvent(
      session,
      accepted ? "READBACK_ACCEPTED" : "READBACK_REJECTED",
      "NURSE",
      result.summary,
      transcript,
      inputMode,
    ),
  );
  return {
    session: accepted
      ? { ...next, phase: "AWAIT_LABEL", readback: result.parsed, readbackInputMode: inputMode }
      : next,
    result,
  };
}

export function scanLabel(session, labelCode, inputMode = INPUT_MODES.MANUAL_LABEL) {
  if (session.phase !== "AWAIT_LABEL") throw new Error(`Label rejected in phase ${session.phase}.`);
  const result = verifyLabel(session.order, labelCode);
  const accepted = result.status === "ACCEPT";
  const next = append(
    session,
    makeEvent(
      session,
      accepted ? "LABEL_ACCEPTED" : "LABEL_REJECTED",
      "NURSE",
      result.summary,
      result.normalizedCode,
      inputMode,
    ),
  );
  return {
    session: accepted
      ? {
        ...next,
        phase: "AWAIT_CONFIRMATION",
        scannedLabel: result.normalizedCode,
        labelInputMode: inputMode,
      }
      : next,
    result,
  };
}

export function confirmHandoff(session) {
  if (session.phase !== "AWAIT_CONFIRMATION") {
    throw new Error(`Confirmation rejected in phase ${session.phase}.`);
  }
  const event = makeEvent(
    session,
    "HUMAN_CONFIRMED",
    "NURSE",
    "User asserted that the displayed synthetic evidence matched.",
    undefined,
    INPUT_MODES.USER_ASSERTION,
  );
  return { ...append(session, event), phase: "COMPLETE" };
}

export function pauseSession(session, reason = "Unresolved discrepancy; completion was not authorized.") {
  if (session.phase === "COMPLETE" || session.phase === "UNRESOLVED") {
    throw new Error(`Pause rejected in phase ${session.phase}.`);
  }
  const event = makeEvent(session, "SESSION_PAUSED", "SYSTEM", reason);
  return { ...append(session, event), phase: "UNRESOLVED", unresolvedReason: reason };
}
