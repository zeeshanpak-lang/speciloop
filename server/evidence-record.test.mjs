import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  computeEvidenceHash,
  createEvidenceRecord,
  EvidenceValidationError,
  verifyEvidenceRecordIntegrity,
} from "./evidence-record.mjs";
import { AppendOnlyEvidenceStore } from "./evidence-store.mjs";
import { INPUT_MODES } from "../src/domain/evidence-contract.js";

const clientSessionId = "11111111-1111-4111-8111-111111111111";
const good = "Left thyroid lobe, permanent pathology, one container.";
const wrong = "Right thyroid lobe, permanent pathology, one container.";

function event(kind, second, transcript) {
  return {
    kind,
    at: `2026-09-02T12:00:${String(second).padStart(2, "0")}.000Z`,
    ...(transcript ? { transcript } : {}),
  };
}

function validPayload() {
  return {
    version: 1,
    clientSessionId,
    caseId: "OR-204",
    events: [
      event("SESSION_STARTED", 0),
      event("CALLOUT_ACCEPTED", 1, good),
      event("READBACK_REJECTED", 2, wrong),
      event("READBACK_ACCEPTED", 3, good),
      event("LABEL_REJECTED", 4, "SL-OR318-02"),
      event("LABEL_ACCEPTED", 5, "SL-OR204-01"),
      event("HUMAN_CONFIRMED", 6),
    ],
  };
}

function validPayloadV2() {
  const payload = validPayload();
  payload.version = 2;
  for (const entry of payload.events) {
    if (entry.kind.startsWith("CALLOUT_") || entry.kind.startsWith("READBACK_")) {
      entry.inputMode = INPUT_MODES.LIVE_TRANSCRIPTION;
    } else if (entry.kind.startsWith("LABEL_")) {
      entry.inputMode = INPUT_MODES.CAMERA_QR;
    } else if (entry.kind === "HUMAN_CONFIRMED") {
      entry.inputMode = INPUT_MODES.USER_ASSERTION;
    }
  }
  return payload;
}

describe("server-verified evidence records", () => {
  it("42 replays accepted and rejected attempts into a complete canonical record", () => {
    const record = createEvidenceRecord(validPayload(), "2026-09-02T12:01:00.000Z");
    assert.equal(record.status, "COMPLETE");
    assert.deepEqual(record.audit.map(({ kind }) => kind), validPayload().events.map(({ kind }) => kind));
    assert.equal(record.audit[4].transcript, "SL-OR318-02");
    assert.ok(verifyEvidenceRecordIntegrity(record));
  });

  it("43 creates the same receipt ID and hash for the same evidence", () => {
    const first = createEvidenceRecord(validPayload(), "2026-09-02T12:01:00.000Z");
    const second = createEvidenceRecord(validPayload(), "2026-09-02T12:02:00.000Z");
    assert.equal(first.recordId, second.recordId);
    assert.equal(first.evidenceHash, second.evidenceHash);
    const alteredIdentity = { ...first, recordId: "SL-0000000000000000" };
    assert.equal(verifyEvidenceRecordIntegrity(alteredIdentity), false);
  });

  it("44 rejects an incomplete sequence without human confirmation", () => {
    const payload = validPayload();
    payload.events.pop();
    assert.throws(() => createEvidenceRecord(payload), EvidenceValidationError);
  });

  it("45 rejects a forged accepted verdict", () => {
    const payload = validPayload();
    payload.events[1].transcript = wrong;
    assert.throws(
      () => createEvidenceRecord(payload),
      /Claimed verdict does not match deterministic verification/,
    );
  });

  it("46 rejects an out-of-order read-back", () => {
    const payload = validPayload();
    payload.events[1] = event("READBACK_ACCEPTED", 1, good);
    assert.throws(() => createEvidenceRecord(payload), /Invalid evidence sequence/);
  });

  it("47 rejects unsupported case data", () => {
    const payload = validPayload();
    payload.caseId = "OR-999";
    assert.throws(() => createEvidenceRecord(payload), /active synthetic case/);
  });

  it("48 rejects oversized evidence histories", () => {
    const payload = validPayload();
    payload.events = Array.from({ length: 51 }, (_, index) => event("SESSION_STARTED", index));
    assert.throws(() => createEvidenceRecord(payload), /cannot exceed 50 events/);
  });

  it("49 never copies an unexpected raw-audio field into the record", () => {
    const payload = validPayload();
    payload.rawAudio = "not-stored";
    payload.events[1].rawAudio = "also-not-stored";
    const record = createEvidenceRecord(payload);
    assert.doesNotMatch(JSON.stringify(record), /rawAudio|not-stored/);
  });

  it("50 stores one append-only line and treats the same receipt as idempotent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "speciloop-store-"));
    const filePath = join(directory, "evidence.ndjson");
    try {
      const store = new AppendOnlyEvidenceStore(filePath);
      const record = createEvidenceRecord(validPayload(), "2026-09-02T12:01:00.000Z");
      const retryAfterLostResponse = createEvidenceRecord(validPayload(), "2026-09-02T12:02:00.000Z");
      assert.equal((await store.save(record)).created, true);
      const duplicate = await store.save(retryAfterLostResponse);
      assert.equal(duplicate.created, false);
      assert.equal(duplicate.record.recordedAt, "2026-09-02T12:01:00.000Z");
      assert.equal((await store.find(record.recordId)).evidenceHash, record.evidenceHash);
      const lines = (await readFile(filePath, "utf8")).trim().split("\n");
      assert.equal(lines.length, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("50a records input modes as client-reported and unverified in schema 2", () => {
    const record = createEvidenceRecord(validPayloadV2(), "2026-09-02T12:01:00.000Z");
    assert.equal(record.schemaVersion, 2);
    assert.equal(record.receiptDescription, "Server-replayed synthetic session receipt.");
    assert.equal(record.audit[1].inputMode, INPUT_MODES.LIVE_TRANSCRIPTION);
    assert.equal(record.audit[1].inputModeVerification, "CLIENT_REPORTED_UNVERIFIED");
    assert.match(record.hashScope, /excludes.*server receipt time/i);
    assert.ok(record.limitations.some((value) => /does not prove that speech occurred/i.test(value)));
    assert.ok(verifyEvidenceRecordIntegrity(record));
  });

  it("50b rejects missing or incompatible schema-2 input modes", () => {
    const missing = validPayloadV2();
    delete missing.events[1].inputMode;
    assert.throws(() => createEvidenceRecord(missing), /missing client-reported input mode/);
    const wrong = validPayloadV2();
    wrong.events[1].inputMode = INPUT_MODES.CAMERA_QR;
    assert.throws(() => createEvidenceRecord(wrong), /unsupported.*input mode/);
  });

  it("50c rejects unreasonable future client event times using an injectable clock", () => {
    const payload = validPayloadV2();
    payload.events[0].at = "2026-09-02T12:05:00.001Z";
    assert.throws(
      () => createEvidenceRecord(payload, "2026-09-02T12:00:00.000Z", {
        now: () => Date.parse("2026-09-02T12:00:00.000Z"),
      }),
      /unreasonably far in the future/,
    );
  });

  it("50d accepts client event time at the documented five-minute tolerance", () => {
    const payload = validPayloadV2();
    payload.events = payload.events.map((entry, index) => ({
      ...entry,
      at: new Date(Date.parse("2026-09-02T12:04:50.000Z") + index * 1000).toISOString(),
    }));
    assert.doesNotThrow(() => createEvidenceRecord(payload, "2026-09-02T12:00:00.000Z", {
      now: () => Date.parse("2026-09-02T12:00:00.000Z"),
    }));
  });

  it("50e includes provenance fields in schema-2 integrity coverage", () => {
    const record = createEvidenceRecord(validPayloadV2());
    const altered = structuredClone(record);
    altered.audit[1].inputMode = INPUT_MODES.SCRIPTED_SAMPLE;
    assert.equal(verifyEvidenceRecordIntegrity(altered), false);
  });

  it("50e2 explicitly excludes server receipt time from the content-derived hash", () => {
    const record = createEvidenceRecord(validPayloadV2(), "2026-09-02T12:01:00.000Z");
    const laterReceiptTime = { ...record, recordedAt: "2026-09-02T12:02:00.000Z" };
    assert.equal(verifyEvidenceRecordIntegrity(laterReceiptTime), true);
    assert.match(record.hashScope, /excludes.*server receipt time/i);
  });

  it("50f continues to verify a schema-1 receipt shape", () => {
    const legacy = createEvidenceRecord(validPayload(), "2026-09-02T12:01:00.000Z");
    assert.equal(legacy.schemaVersion, 1);
    assert.equal("receiptDescription" in legacy, false);
    assert.equal("inputMode" in legacy.audit[1], false);
    assert.ok(verifyEvidenceRecordIntegrity(legacy));
    assert.equal(computeEvidenceHash(legacy), legacy.evidenceHash);
  });
});
