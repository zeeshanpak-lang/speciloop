import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evidenceSubmissionFromSession,
  loadEvidenceRecord,
  saveEvidenceRecord,
  sessionFromEvidenceRecord,
} from "./evidence-client.js";
import { primaryDemoCase } from "./domain/cases.js";
import { INPUT_MODES, inputModeLabel } from "./domain/evidence-contract.js";

const session = {
  id: "44444444-4444-4444-8444-444444444444",
  order: primaryDemoCase,
  audit: [
    { kind: "SESSION_STARTED", at: "2026-09-02T12:00:00.000Z", message: "ignored" },
    {
      kind: "CALLOUT_ACCEPTED",
      at: "2026-09-02T12:00:01.000Z",
      transcript: "Left thyroid lobe, permanent pathology, one container.",
      inputMode: INPUT_MODES.LIVE_TRANSCRIPTION,
      rawAudio: "never-send",
    },
    {
      kind: "READBACK_ACCEPTED",
      at: "2026-09-02T12:00:02.000Z",
      transcript: "Left thyroid lobe, permanent pathology, one container.",
      inputMode: INPUT_MODES.EDITED_TRANSCRIPT,
    },
    {
      kind: "LABEL_ACCEPTED",
      at: "2026-09-02T12:00:03.000Z",
      transcript: "SL-OR204-01",
      inputMode: INPUT_MODES.CAMERA_QR,
    },
    {
      kind: "HUMAN_CONFIRMED",
      at: "2026-09-02T12:00:04.000Z",
      inputMode: INPUT_MODES.USER_ASSERTION,
    },
  ],
};

const record = {
  recordId: "SL-1234567890ABCDEF",
  evidenceHash: "a".repeat(64),
  sourceSessionId: session.id,
  caseId: "OR-204",
  status: "COMPLETE",
  order: { labelCode: "SL-OR204-01" },
  audit: session.audit,
};

describe("browser evidence client", () => {
  it("51 sends only the server evidence contract and excludes raw audio", () => {
    const submission = evidenceSubmissionFromSession(session);
    assert.deepEqual(Object.keys(submission), ["version", "clientSessionId", "caseId", "events"]);
    assert.doesNotMatch(JSON.stringify(submission), /rawAudio|never-send|message/);
    assert.equal(submission.version, 2);
    assert.equal(submission.events[1].inputMode, INPUT_MODES.LIVE_TRANSCRIPTION);
  });

  it("52 posts a completed session and returns its server receipt", async () => {
    let observed;
    const stored = await saveEvidenceRecord(session, async (url, options) => {
      observed = { url, options };
      return new Response(JSON.stringify({ record }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    assert.equal(observed.url, "/api/evidence-records");
    assert.equal(observed.options.method, "POST");
    assert.equal(JSON.parse(observed.options.body).clientSessionId, session.id);
    assert.equal(stored.recordId, record.recordId);
  });

  it("53 loads and reconstructs a completed session from a receipt", async () => {
    const loaded = await loadEvidenceRecord(record.recordId, async () => new Response(
      JSON.stringify({ record }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const restored = sessionFromEvidenceRecord(loaded, primaryDemoCase);
    assert.equal(restored.phase, "COMPLETE");
    assert.equal(restored.scannedLabel, "SL-OR204-01");
    assert.equal(restored.calloutInputMode, INPUT_MODES.LIVE_TRANSCRIPTION);
  });

  it("54 times out evidence save and load requests explicitly", async () => {
    const neverCompletes = async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    await assert.rejects(() => saveEvidenceRecord(session, neverCompletes, { timeoutMs: 5 }), /saving timed out/i);
    await assert.rejects(() => loadEvidenceRecord(record.recordId, neverCompletes, { timeoutMs: 5 }), /loading timed out/i);
  });

  it("55 retries the identical completion candidate after a lost response", async () => {
    const bodies = [];
    await assert.rejects(
      () => saveEvidenceRecord(session, async (_url, options) => {
        bodies.push(options.body);
        throw new TypeError("response lost");
      }),
      /response lost/,
    );
    const stored = await saveEvidenceRecord(session, async (_url, options) => {
      bodies.push(options.body);
      return new Response(JSON.stringify({ record }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    assert.equal(bodies[0], bodies[1]);
    assert.equal(stored.recordId, record.recordId);
  });

  it("56 labels client-reported input modes distinctly", () => {
    assert.equal(inputModeLabel(INPUT_MODES.LIVE_TRANSCRIPTION), "Live transcription");
    assert.equal(inputModeLabel(INPUT_MODES.EDITED_TRANSCRIPT), "Edited transcript");
    assert.equal(inputModeLabel(INPUT_MODES.SCRIPTED_SAMPLE), "Scripted sample input");
    assert.equal(inputModeLabel(INPUT_MODES.CAMERA_QR), "Camera-decoded QR label");
    assert.equal(inputModeLabel(INPUT_MODES.MANUAL_LABEL), "Manually entered label");
  });
});
