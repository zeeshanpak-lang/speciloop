import { createHash } from "node:crypto";
import { primaryDemoCase } from "../src/domain/cases.js";
import {
  EVENT_TIME_FUTURE_TOLERANCE_MS,
  MAX_EVIDENCE_EVENTS,
  inputModeAllowedForEvent,
} from "../src/domain/evidence-contract.js";
import {
  confirmHandoff,
  createSession,
  scanLabel,
  submitCallout,
  submitReadback,
} from "../src/domain/session.js";

const MAX_TRANSCRIPT_LENGTH = 500;
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const supportedKinds = new Set([
  "SESSION_STARTED",
  "CALLOUT_ACCEPTED",
  "CALLOUT_REJECTED",
  "READBACK_ACCEPTED",
  "READBACK_REJECTED",
  "LABEL_ACCEPTED",
  "LABEL_REJECTED",
  "HUMAN_CONFIRMED",
]);

export class EvidenceValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "EvidenceValidationError";
  }
}

function fail(message) {
  throw new EvidenceValidationError(message);
}

function requireObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(message);
}

function validateTimestamp(value, previousTimestamp, latestAllowedTimestamp) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    fail("Every evidence event must have a valid client-reported timestamp.");
  }
  const timestamp = Date.parse(value);
  if (timestamp < previousTimestamp) fail("Client-reported evidence timestamps must be in sequence.");
  if (timestamp > latestAllowedTimestamp) {
    fail("A client-reported evidence timestamp is unreasonably far in the future.");
  }
  return timestamp;
}

function transcriptFor(event) {
  if (typeof event.transcript !== "string") fail(`${event.kind} requires text or a label code.`);
  const transcript = event.transcript.trim();
  if (!transcript) fail(`${event.kind} requires text or a label code.`);
  if (transcript.length > MAX_TRANSCRIPT_LENGTH) {
    fail(`Evidence text cannot exceed ${MAX_TRANSCRIPT_LENGTH} characters.`);
  }
  return transcript;
}

function inputModeFor(event, version) {
  if (version === 1) return undefined;
  if (!inputModeAllowedForEvent(event.kind, event.inputMode)) {
    fail(`${event.kind} has an unsupported or missing client-reported input mode.`);
  }
  return event.inputMode;
}

function canonicalEvent(generated, sourceEvent, clientSessionId, sequence, version) {
  const base = {
    id: `${clientSessionId}-${sequence}`,
    sequence,
    at: sourceEvent.at,
    kind: generated.kind,
    actor: generated.actor,
    message: generated.message,
    ...(generated.transcript ? { transcript: generated.transcript } : {}),
  };
  if (version === 1 || generated.kind === "SESSION_STARTED") return base;
  return {
    ...base,
    inputMode: sourceEvent.inputMode,
    inputModeVerification: "CLIENT_REPORTED_UNVERIFIED",
    eventTimeBasis: "CLIENT_REPORTED_UNVERIFIED",
  };
}

function recordCore(record) {
  const core = {
    schemaVersion: record.schemaVersion,
    sourceSessionId: record.sourceSessionId,
    caseId: record.caseId,
    status: record.status,
    order: record.order,
    audit: record.audit,
  };
  if (record.schemaVersion >= 2) {
    core.receiptDescription = record.receiptDescription;
    core.limitations = record.limitations;
    core.hashScope = record.hashScope;
  }
  return core;
}

export function computeEvidenceHash(record) {
  return createHash("sha256").update(JSON.stringify(recordCore(record))).digest("hex");
}

export function verifyEvidenceRecordIntegrity(record) {
  if (![1, 2].includes(record?.schemaVersion)) return false;
  if (typeof record?.evidenceHash !== "string" || computeEvidenceHash(record) !== record.evidenceHash) {
    return false;
  }
  return record.recordId === `SL-${record.evidenceHash.slice(0, 16).toUpperCase()}`;
}

export function createEvidenceRecord(
  payload,
  recordedAt = new Date().toISOString(),
  {
    now = () => Date.now(),
    futureToleranceMs = EVENT_TIME_FUTURE_TOLERANCE_MS,
  } = {},
) {
  requireObject(payload, "Evidence submission must be a JSON object.");
  if (![1, 2].includes(payload.version)) fail("Unsupported evidence submission version.");
  if (!sessionIdPattern.test(String(payload.clientSessionId || ""))) {
    fail("A valid client session ID is required.");
  }
  if (payload.caseId !== primaryDemoCase.caseId) fail("Only the active synthetic case is supported.");
  if (!Array.isArray(payload.events) || payload.events.length < 3) {
    fail("A complete evidence event sequence is required.");
  }
  if (payload.events.length > MAX_EVIDENCE_EVENTS) {
    fail(`Evidence cannot exceed ${MAX_EVIDENCE_EVENTS} events.`);
  }
  if (!Number.isFinite(Date.parse(recordedAt))) fail("Server receipt time is invalid.");
  const nowMs = Number(now());
  if (!Number.isFinite(nowMs) || !Number.isFinite(futureToleranceMs) || futureToleranceMs < 0) {
    throw new TypeError("Evidence timestamp validation requires a valid clock and tolerance.");
  }
  const latestAllowedTimestamp = nowMs + futureToleranceMs;

  const first = payload.events[0];
  requireObject(first, "Every evidence event must be an object.");
  if (first.kind !== "SESSION_STARTED") fail("The evidence sequence must begin with SESSION_STARTED.");
  if (payload.version === 2 && first.inputMode !== undefined) {
    fail("SESSION_STARTED must not claim an input mode.");
  }

  let previousTimestamp = validateTimestamp(first.at, Number.NEGATIVE_INFINITY, latestAllowedTimestamp);
  let replay = createSession(primaryDemoCase);
  const canonicalAudit = [canonicalEvent(replay.audit[0], first, payload.clientSessionId, 1, payload.version)];

  for (let index = 1; index < payload.events.length; index += 1) {
    const event = payload.events[index];
    requireObject(event, "Every evidence event must be an object.");
    if (!supportedKinds.has(event.kind) || event.kind === "SESSION_STARTED") {
      fail(`Unsupported evidence event at sequence ${index + 1}.`);
    }
    previousTimestamp = validateTimestamp(event.at, previousTimestamp, latestAllowedTimestamp);
    const inputMode = inputModeFor(event, payload.version);

    try {
      if (event.kind.startsWith("CALLOUT_")) {
        replay = submitCallout(replay, transcriptFor(event), inputMode).session;
      } else if (event.kind.startsWith("READBACK_")) {
        replay = submitReadback(replay, transcriptFor(event), inputMode).session;
      } else if (event.kind.startsWith("LABEL_")) {
        replay = scanLabel(replay, transcriptFor(event), inputMode).session;
      } else if (event.kind === "HUMAN_CONFIRMED") {
        if (index !== payload.events.length - 1) fail("User confirmation must be the final event.");
        replay = confirmHandoff(replay);
      }
    } catch (error) {
      if (error instanceof EvidenceValidationError) throw error;
      fail(`Invalid evidence sequence at event ${index + 1}.`);
    }

    const generated = replay.audit.at(-1);
    if (generated.kind !== event.kind) {
      fail(`Claimed verdict does not match deterministic verification at event ${index + 1}.`);
    }
    canonicalAudit.push(canonicalEvent(generated, event, payload.clientSessionId, index + 1, payload.version));
  }

  if (replay.phase !== "COMPLETE") fail("Evidence must include a successful user confirmation assertion.");

  const record = {
    schemaVersion: payload.version,
    sourceSessionId: payload.clientSessionId,
    caseId: primaryDemoCase.caseId,
    status: "COMPLETE",
    order: {
      specimenName: primaryDemoCase.specimenName,
      anatomicalStructure: primaryDemoCase.anatomicalStructure,
      laterality: primaryDemoCase.laterality,
      disposition: primaryDemoCase.disposition,
      containerCount: primaryDemoCase.containerCount,
      labelCode: primaryDemoCase.labelCode,
    },
    audit: canonicalAudit,
    ...(payload.version >= 2 ? {
      receiptDescription: "Server-replayed synthetic session receipt.",
      limitations: [
        "Workflow roles, input modes, event times, and submitted text are client-reported and unverified.",
        "The receipt does not prove that speech occurred, that a physical container was scanned, or that omitted attempts never occurred.",
        "The receipt does not verify patient identity, individual physical containers, or clinical safety.",
      ],
      hashScope: "SHA-256 covers the schema version, source session ID, synthetic case ID, status, expected-order snapshot, canonical replayed audit, receipt description, limitations, and this scope statement. It excludes the receipt ID and server receipt time.",
    } : {}),
  };
  const evidenceHash = computeEvidenceHash(record);
  return {
    recordId: `SL-${evidenceHash.slice(0, 16).toUpperCase()}`,
    recordedAt,
    ...record,
    evidenceHash,
  };
}
