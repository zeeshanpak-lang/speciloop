import { EVIDENCE_SUBMISSION_VERSION } from "./domain/evidence-contract.js";
import { parseStatement } from "./domain/verifier.js";

const DEFAULT_TIMEOUT_MS = 8000;

export function evidenceSubmissionFromSession(session) {
  return {
    version: EVIDENCE_SUBMISSION_VERSION,
    clientSessionId: session.id,
    caseId: session.order.caseId,
    events: session.audit.map((event) => ({
      kind: event.kind,
      at: event.at,
      ...(event.transcript ? { transcript: event.transcript } : {}),
      ...(event.inputMode ? { inputMode: event.inputMode } : {}),
    })),
  };
}

async function responseBody(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function fetchWithTimeout(fetchImplementation, url, options, timeoutMs, timeoutMessage) {
  const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), duration);
  try {
    return await fetchImplementation(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") throw new Error(timeoutMessage);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function saveEvidenceRecord(
  session,
  fetchImplementation = fetch,
  { timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const response = await fetchWithTimeout(
    fetchImplementation,
    "/api/evidence-records",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(evidenceSubmissionFromSession(session)),
    },
    timeoutMs,
    "Evidence saving timed out. The same completion candidate is ready to retry.",
  );
  const body = await responseBody(response);
  if (!response.ok || !body.record) {
    throw new Error(body.error || "The evidence record could not be stored.");
  }
  return body.record;
}

export async function loadEvidenceRecord(
  recordId,
  fetchImplementation = fetch,
  { timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const response = await fetchWithTimeout(
    fetchImplementation,
    `/api/evidence-records/${encodeURIComponent(recordId)}`,
    { cache: "no-store" },
    timeoutMs,
    "Evidence receipt loading timed out.",
  );
  const body = await responseBody(response);
  if (!response.ok || !body.record) {
    throw new Error(body.error || "The evidence receipt could not be loaded.");
  }
  return body.record;
}

export function sessionFromEvidenceRecord(record, order) {
  if (record.caseId !== order.caseId || record.status !== "COMPLETE" || !Array.isArray(record.audit)) {
    throw new Error("The stored evidence receipt is invalid for this synthetic case.");
  }
  const calloutEvent = record.audit.findLast?.((event) => event.kind === "CALLOUT_ACCEPTED")
    ?? [...record.audit].reverse().find((event) => event.kind === "CALLOUT_ACCEPTED");
  const readbackEvent = record.audit.findLast?.((event) => event.kind === "READBACK_ACCEPTED")
    ?? [...record.audit].reverse().find((event) => event.kind === "READBACK_ACCEPTED");
  const labelEvent = record.audit.findLast?.((event) => event.kind === "LABEL_ACCEPTED")
    ?? [...record.audit].reverse().find((event) => event.kind === "LABEL_ACCEPTED");
  if (!calloutEvent?.transcript || !readbackEvent?.transcript || !labelEvent?.transcript) {
    throw new Error("The stored evidence receipt is missing accepted synthetic evidence.");
  }
  return {
    id: record.sourceSessionId,
    order,
    phase: "COMPLETE",
    audit: record.audit,
    callout: parseStatement(order, calloutEvent.transcript),
    readback: parseStatement(order, readbackEvent.transcript),
    scannedLabel: labelEvent.transcript,
    calloutInputMode: calloutEvent.inputMode,
    readbackInputMode: readbackEvent.inputMode,
    labelInputMode: labelEvent.inputMode,
    restoredFromReceipt: true,
  };
}
