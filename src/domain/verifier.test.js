import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { primaryDemoCase, syntheticCases } from "./cases.js";
import {
  confirmHandoff,
  createSession,
  scanLabel,
  submitCallout,
  submitReadback,
} from "./session.js";
import { parseStatement, verifyLabel, verifyStatement } from "./verifier.js";

const good = "Left thyroid lobe, permanent pathology, one container.";

describe("deterministic spoken verification", () => {
  it("1 accepts an exact match", () => assert.equal(verifyStatement(primaryDemoCase, good).status, "ACCEPT"));
  it("2 blocks a left/right swap", () => {
    const result = verifyStatement(primaryDemoCase, "Right thyroid lobe, permanent pathology, one container.");
    assert.equal(result.status, "BLOCK");
    assert.equal(result.differences[0].field, "laterality");
    assert.equal(result.summary, "Laterality mismatch: expected left, but heard right.");
  });
  it("3 retries omitted laterality", () => assert.equal(verifyStatement(primaryDemoCase, "Thyroid lobe, permanent pathology, one container.").status, "RETRY"));
  it("4 retries referential side language", () => assert.equal(verifyStatement(primaryDemoCase, "Same side thyroid lobe, permanent pathology, one container.").status, "RETRY"));
  it("5 blocks conflicting laterality", () => assert.equal(verifyStatement(primaryDemoCase, "Left right thyroid lobe permanent pathology one container").status, "BLOCK"));
  it("6 retries omitted container count", () => assert.equal(verifyStatement(primaryDemoCase, "Left thyroid lobe, permanent pathology.").status, "RETRY"));
  it("7 blocks the wrong container count", () => assert.equal(verifyStatement(primaryDemoCase, "Left thyroid lobe permanent pathology two containers").status, "BLOCK"));
  it("8 blocks the wrong disposition", () => assert.equal(verifyStatement(primaryDemoCase, "Left thyroid lobe fresh one container").status, "BLOCK"));
  it("9 retries the wrong anatomical structure", () => assert.equal(verifyStatement(primaryDemoCase, "Left breast tissue permanent pathology one container").status, "RETRY"));
  it("10 retries an unrecognized anatomy transcription", () => assert.equal(verifyStatement(primaryDemoCase, "Left tired lobe permanent pathology one container").status, "RETRY"));
  it("11 rejects a single yes", () => assert.equal(verifyStatement(primaryDemoCase, "yes").status, "RETRY"));
  it("12 rejects silence", () => assert.equal(verifyStatement(primaryDemoCase, "").status, "RETRY"));
  it("13 surfaces missing critical fields", () => assert.deepEqual(verifyStatement(primaryDemoCase, "Left thyroid lobe").missing, ["disposition", "containerCount"]));
  it("14 normalizes punctuation and capitalization", () => assert.equal(verifyStatement(primaryDemoCase, "LEFT—THYROID LOBE! PERMANENT; ONE CONTAINER").status, "ACCEPT"));
  it("15 supports an approved anatomy alias", () => assert.equal(verifyStatement(primaryDemoCase, "Left lobe of thyroid permanent pathology one container").status, "ACCEPT"));
  it("16 parses numeric container counts", () => assert.equal(parseStatement(primaryDemoCase, "left thyroid lobe permanent pathology 1 container").containerCount, 1));
  it("17 flags uncertain language", () => assert.equal(verifyStatement(primaryDemoCase, "Probably left thyroid lobe permanent pathology one container").status, "RETRY"));
  it("18 flags I think language", () => assert.equal(verifyStatement(primaryDemoCase, "I think left thyroid lobe permanent pathology one container").status, "RETRY"));
  it("19 blocks a wrong synthetic label", () => assert.equal(verifyLabel(primaryDemoCase, "SL-OR318-02").status, "BLOCK"));
  it("20 accepts the correct synthetic label case-insensitively", () => assert.equal(verifyLabel(primaryDemoCase, "sl-or204-01").status, "ACCEPT"));
  it("21 blocks conflicting dispositions", () => assert.equal(verifyStatement(primaryDemoCase, "Left thyroid lobe permanent pathology fresh one container").status, "BLOCK"));
  it("22 blocks conflicting container counts", () => assert.equal(verifyStatement(primaryDemoCase, "Left thyroid lobe permanent pathology one container two containers").status, "BLOCK"));
  it("23 blocks a negated laterality", () => assert.equal(verifyStatement(primaryDemoCase, "Not left thyroid lobe permanent pathology one container").status, "BLOCK"));
  it("24 blocks a negated disposition", () => assert.equal(verifyStatement(primaryDemoCase, "Left thyroid lobe not permanent pathology one container").status, "BLOCK"));
  it("25 blocks a negated container count", () => assert.equal(verifyStatement(primaryDemoCase, "Left thyroid lobe permanent pathology not one container").status, "BLOCK"));
  it("26 exposes the normalized scanned label", () => assert.equal(verifyLabel(primaryDemoCase, " sl-or204-01 ").normalizedCode, "SL-OR204-01"));
  it("26a never accepts a negated complete statement", () => {
    assert.notEqual(verifyStatement(primaryDemoCase, "This is not a left thyroid lobe, permanent pathology, one container.").status, "ACCEPT");
  });
  it("26b never accepts additional anatomy", () => {
    assert.notEqual(verifyStatement(primaryDemoCase, "Left thyroid lobe and parathyroid gland, permanent pathology, one container.").status, "ACCEPT");
  });
  it("26c never accepts uncertainty appended to a match", () => {
    assert.notEqual(verifyStatement(primaryDemoCase, "Left thyroid lobe, permanent pathology, one container, but I am unsure.").status, "ACCEPT");
  });
  it("26d requires a fresh statement after self-correction", () => {
    const result = verifyStatement(primaryDemoCase, "Left thyroid lobe, permanent pathology, one container. Actually two.");
    assert.equal(result.status, "RETRY");
    assert.match(result.summary, /fresh complete statement/i);
  });
  it("26e never accepts multiple count statements", () => {
    assert.notEqual(verifyStatement(primaryDemoCase, "Left thyroid lobe, permanent pathology, 1 container and 10 containers.").status, "ACCEPT");
  });
  it("26f never accepts conflicting case information", () => {
    assert.notEqual(verifyStatement(primaryDemoCase, `${good} Case OR-318.`).status, "ACCEPT");
  });
  it("26g never accepts patient identity appended to a match", () => {
    const result = verifyStatement(primaryDemoCase, `${good} Patient B.`);
    assert.equal(result.status, "RETRY");
    assert.match(result.summary, /patient identity/i);
  });
  it("26h blocks explicit stop language", () => {
    const result = verifyStatement(primaryDemoCase, `${good} Do not proceed.`);
    assert.equal(result.status, "BLOCK");
    assert.match(result.summary, /do not proceed/i);
  });
  it("26i rejects preservation media as outside disposition scope", () => {
    const result = verifyStatement(primaryDemoCase, "Left thyroid lobe, permanent pathology in formalin, one container.");
    assert.equal(result.status, "RETRY");
    assert.match(result.summary, /preservation medium/i);
  });
  it("26j rejects unsupported counts", () => {
    const result = verifyStatement(primaryDemoCase, "Left thyroid lobe, permanent pathology, 11 containers.");
    assert.equal(result.status, "RETRY");
    assert.match(result.summary, /unsupported container count/i);
  });
  it("26k keeps supported aliases, number formats, articles, and jar wording", () => {
    for (const statement of [
      "Left thyroid lobe permanent pathology 1 container",
      "The left lobe of thyroid permanent one jar",
      "LEFT—THYROID LOBE! PERMANENT PATHOLOGY; ONE CONTAINER",
    ]) assert.equal(verifyStatement(primaryDemoCase, statement).status, "ACCEPT", statement);
  });
});

describe("server-owned session sequence", () => {
  it("27 starts at callout with an audit event", () => {
    const session = createSession(primaryDemoCase);
    assert.equal(session.phase, "AWAIT_CALLOUT");
    assert.equal(session.audit.length, 1);
  });
  it("28 does not advance after a wrong callout", () => {
    const { session } = submitCallout(createSession(primaryDemoCase), "Right thyroid lobe permanent pathology one container");
    assert.equal(session.phase, "AWAIT_CALLOUT");
  });
  it("29 advances after a correct callout", () => assert.equal(submitCallout(createSession(primaryDemoCase), good).session.phase, "AWAIT_READBACK"));
  it("30 keeps read-back blocked until fully corrected", () => {
    const called = submitCallout(createSession(primaryDemoCase), good).session;
    const wrong = submitReadback(called, "Right thyroid lobe permanent pathology one container");
    assert.equal(wrong.session.phase, "AWAIT_READBACK");
    assert.equal(submitReadback(wrong.session, good).session.phase, "AWAIT_LABEL");
  });
  it("31 rejects an out-of-order read-back", () => assert.throws(() => submitReadback(createSession(primaryDemoCase), good)));
  it("32 rejects an out-of-order label", () => assert.throws(() => scanLabel(createSession(primaryDemoCase), primaryDemoCase.labelCode)));
  it("33 remains at label after a wrong scan", () => {
    const called = submitCallout(createSession(primaryDemoCase), good).session;
    const read = submitReadback(called, good).session;
    assert.equal(scanLabel(read, syntheticCases[1].labelCode).session.phase, "AWAIT_LABEL");
  });
  it("34 advances after the correct label and records its normalized code", () => {
    const called = submitCallout(createSession(primaryDemoCase), good).session;
    const read = submitReadback(called, good).session;
    const labelled = scanLabel(read, " sl-or204-01 ").session;
    assert.equal(labelled.phase, "AWAIT_CONFIRMATION");
    assert.equal(labelled.scannedLabel, "SL-OR204-01");
    assert.equal(labelled.audit.at(-1).transcript, "SL-OR204-01");
  });
  it("35 rejects confirmation before all evidence matches", () => assert.throws(() => confirmHandoff(createSession(primaryDemoCase))));
  it("36 completes only after explicit human confirmation", () => {
    const called = submitCallout(createSession(primaryDemoCase), good).session;
    const read = submitReadback(called, good).session;
    const labelled = scanLabel(read, primaryDemoCase.labelCode).session;
    const complete = confirmHandoff(labelled);
    assert.equal(complete.phase, "COMPLETE");
    assert.equal(complete.audit.at(-1).kind, "HUMAN_CONFIRMED");
  });
});
