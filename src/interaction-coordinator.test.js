import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InteractionCoordinator } from "./interaction-coordinator.js";

const surgeon = { id: "session-a", phase: "AWAIT_CALLOUT" };

describe("phase-bound interaction coordination", () => {
  it("prevents a manual submission while live capture owns the phase", () => {
    const coordinator = new InteractionCoordinator();
    const capture = coordinator.beginCapture(surgeon);
    assert.ok(capture);
    assert.equal(coordinator.beginSubmission(surgeon), null);
    assert.equal(coordinator.isCaptureCurrent(capture, surgeon), true);
  });

  it("ignores a surgeon callback after the session advances to nurse read-back", () => {
    const coordinator = new InteractionCoordinator();
    const capture = coordinator.beginCapture(surgeon);
    const nurse = { ...surgeon, phase: "AWAIT_READBACK" };
    assert.equal(coordinator.isCaptureCurrent(capture, nurse), false);
    coordinator.noteSessionChange();
    assert.equal(coordinator.isCaptureCurrent(capture, nurse), false);
    const nurseCapture = coordinator.beginCapture(nurse);
    assert.notEqual(nurseCapture.id, capture.id);
    assert.equal(nurseCapture.phase, "AWAIT_READBACK");
  });

  it("permits only one submission to advance a phase", () => {
    const coordinator = new InteractionCoordinator();
    const first = coordinator.beginSubmission(surgeon);
    assert.ok(first);
    assert.equal(coordinator.beginSubmission(surgeon), null);
    assert.equal(coordinator.isSubmissionCurrent(first, surgeon), true);
    coordinator.endSubmission(first, { changed: true });
    assert.equal(coordinator.isSubmissionCurrent(first, surgeon), false);
  });

  it("invalidates receipt restoration after a new interactive session starts", () => {
    const coordinator = new InteractionCoordinator();
    const restore = coordinator.snapshot(surgeon);
    coordinator.noteSessionChange();
    const fresh = { id: "session-b", phase: "AWAIT_CALLOUT" };
    assert.equal(coordinator.isSnapshotCurrent(restore, fresh), false);
  });
});
