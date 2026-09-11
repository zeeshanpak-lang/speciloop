import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSpokenInstruction, retryPromptForPhase } from "./spoken-guidance.js";

describe("phase-specific spoken guidance", () => {
  it("37 names the nurse and complete read-back after a read-back mismatch", () => {
    const instruction = createSpokenInstruction({
      phaseBefore: "AWAIT_READBACK",
      phaseAfter: "AWAIT_READBACK",
      result: {
        status: "BLOCK",
        summary: "Laterality mismatch: expected left, but heard right.",
      },
    });
    assert.equal(
      instruction,
      "Laterality mismatch: expected left, but heard right. Circulating nurse, repeat the complete read-back with all required details.",
    );
  });

  it("38 asks the surgeon to repeat a rejected callout", () => {
    const instruction = createSpokenInstruction({
      phaseBefore: "AWAIT_CALLOUT",
      phaseAfter: "AWAIT_CALLOUT",
      result: { status: "RETRY", summary: "Incomplete spoken evidence: missing disposition." },
    });
    assert.match(instruction, /Surgeon, repeat the complete callout/);
  });

  it("39 moves an accepted callout to the nurse read-back prompt", () => {
    const instruction = createSpokenInstruction({
      phaseBefore: "AWAIT_CALLOUT",
      phaseAfter: "AWAIT_READBACK",
      result: { status: "ACCEPT", summary: "All required spoken fields match." },
    });
    assert.equal(
      instruction,
      "Callout matched the synthetic order. Circulating nurse, repeat the complete read-back.",
    );
  });

  it("40 moves an accepted read-back to the label prompt", () => {
    const instruction = createSpokenInstruction({
      phaseBefore: "AWAIT_READBACK",
      phaseAfter: "AWAIT_LABEL",
      result: { status: "ACCEPT", summary: "All required spoken fields match." },
    });
    assert.equal(instruction, "Nurse read-back matched. Scan the synthetic container label.");
  });

  it("41 provides a safe fallback for an unknown phase", () => {
    assert.equal(
      retryPromptForPhase("UNKNOWN"),
      "Review the required evidence before continuing.",
    );
  });
});
