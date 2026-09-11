export const EVIDENCE_SUBMISSION_VERSION = 2;
export const MAX_EVIDENCE_EVENTS = 50;
export const EVENT_TIME_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export const INPUT_MODES = Object.freeze({
  LIVE_TRANSCRIPTION: "live_transcription",
  MANUAL_TEXT: "manual_text",
  EDITED_TRANSCRIPT: "edited_transcript",
  SCRIPTED_SAMPLE: "scripted_sample",
  CAMERA_QR: "camera_qr",
  MANUAL_LABEL: "manual_label",
  USER_ASSERTION: "user_assertion",
});

const spokenModes = new Set([
  INPUT_MODES.LIVE_TRANSCRIPTION,
  INPUT_MODES.MANUAL_TEXT,
  INPUT_MODES.EDITED_TRANSCRIPT,
  INPUT_MODES.SCRIPTED_SAMPLE,
]);

const labelModes = new Set([
  INPUT_MODES.CAMERA_QR,
  INPUT_MODES.MANUAL_LABEL,
  INPUT_MODES.SCRIPTED_SAMPLE,
]);

export function inputModeAllowedForEvent(kind, mode) {
  if (kind === "SESSION_STARTED" || kind === "SESSION_PAUSED") return mode === undefined;
  if (kind.startsWith("CALLOUT_") || kind.startsWith("READBACK_")) {
    return spokenModes.has(mode);
  }
  if (kind.startsWith("LABEL_")) return labelModes.has(mode);
  if (kind === "HUMAN_CONFIRMED") return mode === INPUT_MODES.USER_ASSERTION;
  return false;
}

export function inputModeLabel(mode) {
  return ({
    [INPUT_MODES.LIVE_TRANSCRIPTION]: "Live transcription",
    [INPUT_MODES.MANUAL_TEXT]: "Manually entered text",
    [INPUT_MODES.EDITED_TRANSCRIPT]: "Edited transcript",
    [INPUT_MODES.SCRIPTED_SAMPLE]: "Scripted sample input",
    [INPUT_MODES.CAMERA_QR]: "Camera-decoded QR label",
    [INPUT_MODES.MANUAL_LABEL]: "Manually entered label",
    [INPUT_MODES.USER_ASSERTION]: "User assertion",
  })[mode] || "Unspecified legacy input";
}
