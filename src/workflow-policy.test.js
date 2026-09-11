import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { primaryDemoCase } from "./domain/cases.js";
import { confirmHandoff, createSession, pauseSession } from "./domain/session.js";
import { canCompleteWithinEventLimit, eventsNeededForCompletion } from "./workflow-policy.js";

describe("event limits and unresolved sessions", () => {
  it("reserves enough events for every remaining successful phase", () => {
    assert.equal(eventsNeededForCompletion("AWAIT_CALLOUT"), 4);
    assert.equal(canCompleteWithinEventLimit({ phase: "AWAIT_CALLOUT", audit: Array(46) }), true);
    assert.equal(canCompleteWithinEventLimit({ phase: "AWAIT_CALLOUT", audit: Array(47) }), false);
    assert.equal(canCompleteWithinEventLimit({ phase: "AWAIT_CONFIRMATION", audit: Array(49) }), true);
    assert.equal(canCompleteWithinEventLimit({ phase: "AWAIT_CONFIRMATION", audit: Array(50) }), false);
  });

  it("records a clearly incomplete pause state with no completion bypass", () => {
    const paused = pauseSession(createSession(primaryDemoCase), "Mismatch could not be resolved.");
    assert.equal(paused.phase, "UNRESOLVED");
    assert.equal(paused.audit.at(-1).kind, "SESSION_PAUSED");
    assert.throws(() => confirmHandoff(paused), /Confirmation rejected/);
  });
});
