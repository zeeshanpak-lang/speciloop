const retryPrompts = {
  AWAIT_CALLOUT: "Surgeon, repeat the complete callout with all required details.",
  AWAIT_READBACK: "Circulating nurse, repeat the complete read-back with all required details.",
  AWAIT_LABEL: "Scan or enter the correct synthetic container label.",
};

const acceptedPrompts = {
  AWAIT_READBACK: "Callout matched the synthetic order. Circulating nurse, repeat the complete read-back.",
  AWAIT_LABEL: "Nurse read-back matched. Scan the synthetic container label.",
};

export function retryPromptForPhase(phase) {
  return retryPrompts[phase] ?? "Review the required evidence before continuing.";
}

export function createSpokenInstruction({ phaseBefore, phaseAfter, result }) {
  if (result.status === "ACCEPT") {
    return acceptedPrompts[phaseAfter] ?? result.summary;
  }

  return `${result.summary} ${retryPromptForPhase(phaseBefore)}`;
}
