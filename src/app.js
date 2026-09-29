import { primaryDemoCase, syntheticCases } from "./domain/cases.js";
import { INPUT_MODES, MAX_EVIDENCE_EVENTS, inputModeLabel } from "./domain/evidence-contract.js";
import {
  confirmHandoff,
  createSession,
  pauseSession,
  scanLabel,
  submitCallout,
  submitReadback,
} from "./domain/session.js";
import {
  loadEvidenceRecord,
  saveEvidenceRecord,
  sessionFromEvidenceRecord,
} from "./evidence-client.js";
import { InteractionCoordinator } from "./interaction-coordinator.js";
import { LabelScanner } from "./label-scanner.js";
import { createSpokenInstruction } from "./spoken-guidance.js";
import { VoiceCapture } from "./voice.js";
import { canCompleteWithinEventLimit } from "./workflow-policy.js";

const root = document.querySelector("#root");
const correctStatement = "Left thyroid lobe, permanent pathology, one container.";
const wrongStatement = "Right thyroid lobe, permanent pathology, one container.";
const phases = [
  ["AWAIT_CALLOUT", "Callout"],
  ["AWAIT_READBACK", "Read-back"],
  ["AWAIT_LABEL", "Label"],
  ["AWAIT_CONFIRMATION", "Confirm"],
  ["COMPLETE", "Receipt"],
];

const coordinator = new InteractionCoordinator();
let session = createSession(primaryDemoCase);
let notice = null;
let confirmed = false;
let liveTranscript = "";
let pendingInputMode = INPUT_MODES.MANUAL_TEXT;
let voiceState = "OFFLINE";
let voiceBinding = null;
let scannerState = "CAMERA OFF";
let scannerBinding = null;
let receipt = null;
let storageState = "NOT SAVED";
let savingEvidence = false;
let pendingCompletion = null;
let pendingFocusSelector = null;
let workspaceStarted = false;
let motionPaused = false;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTime(value) {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatDisposition(value) {
  return String(value).replaceAll("_", " ").toLowerCase();
}

function fieldSummary(parsed) {
  if (!parsed) return "Unavailable";
  return [
    parsed.laterality?.toLowerCase(),
    parsed.anatomicalStructure,
    formatDisposition(parsed.disposition),
    `${parsed.containerCount} ${parsed.containerCount === 1 ? "container" : "containers"}`,
  ].filter(Boolean).join(" · ");
}

function resultMarkup() {
  if (!notice) return "";
  if (session.phase === "COMPLETE" && notice.status === "ACCEPT") return "";
  const mark = notice.status === "ACCEPT" ? "✓" : notice.status === "BLOCK" ? "!" : notice.status === "READY" ? "…" : "↻";
  const retryInstructions = {
    AWAIT_CALLOUT: "Resolve the issue, then provide a fresh complete workflow-role surgeon statement.",
    AWAIT_READBACK: "Resolve the issue, then provide a fresh complete workflow-role nurse statement.",
    AWAIT_LABEL: "Scan or enter the correct synthetic label code.",
  };
  const reminder = ["ACCEPT", "READY"].includes(notice.status) || session.phase === "COMPLETE"
    ? ""
    : `<p>The workflow has not advanced. ${retryInstructions[session.phase] ?? "Completion remains unavailable."}</p>`;
  return `
    <section id="result-notice" class="result result--${notice.status.toLowerCase()}" aria-live="assertive" tabindex="-1">
      <div class="result__mark" aria-hidden="true">${mark}</div>
      <div>
        <p class="eyebrow">${escapeHtml(notice.status)}</p>
        <h3>${escapeHtml(notice.summary)}</h3>
        ${reminder}
        ${comparisonMarkup()}
      </div>
    </section>`;
}

function comparisonMarkup() {
  if (!notice || notice.status === "ACCEPT" || !notice.parsed) return "";
  const fields = [["laterality", "Side"], ["anatomicalStructure", "Specimen"], ["disposition", "Disposition"], ["containerCount", "Containers"]];
  const rows = fields.map(([field, label]) => {
    const received = notice.parsed[field];
    const expected = session.order[field];
    const differs = received !== expected;
    const display = (value) => value == null ? "Not resolved" : String(value).replaceAll("_", " ").toLowerCase();
    return `<tr class="${differs ? "comparison-mismatch" : ""}"><th scope="row">${label}</th><td>${escapeHtml(display(expected))}</td><td>${escapeHtml(display(received))}${differs ? " <span aria-label='Needs correction'>!</span>" : ""}</td></tr>`;
  }).join("");
  return `<div class="comparison-wrap"><table class="comparison"><caption>Last submitted statement · field comparison only, not acceptance</caption><thead><tr><th>Field</th><th>Expected</th><th>Submitted</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function eventModeMarkup(event) {
  if (!event.inputMode) return "";
  return `<span class="timeline__mode">${escapeHtml(inputModeLabel(event.inputMode))} · client-reported, unverified</span>`;
}

function evidenceMarkup() {
  const events = [...session.audit].reverse().map((event) => `
    <li class="timeline__item timeline__item--${event.kind.toLowerCase()}">
      <span class="timeline__dot"></span>
      <div class="timeline__content">
        <div class="timeline__meta">
          <span>${event.actor === "SYSTEM" ? "SYSTEM" : `WORKFLOW ROLE · ${escapeHtml(event.actor)}`}</span>
          <time title="Client-reported, unverified event time">${formatTime(event.at)}</time>
        </div>
        <strong>${escapeHtml(event.message)}</strong>
        ${eventModeMarkup(event)}
        ${event.transcript ? `<blockquote>“${escapeHtml(event.transcript)}”</blockquote>` : ""}
      </div>
    </li>`).join("");
  return `
    <dialog id="evidence-dialog" class="evidence-panel" aria-label="Session evidence">
      <button type="button" id="close-evidence" class="secondary-action drawer-close">Close evidence ×</button>
      <details class="evidence-disclosure" open>
      <summary>Evidence trail <span>${session.audit.length} events</span></summary>
      <div class="section-heading">
        <div><p class="eyebrow">${receipt ? "Server receipt events" : "In-session evidence"}</p><h2>Evidence trail</h2></div>
        <span class="count-pill">${session.audit.length}</span>
      </div>
      <p class="panel-note">Event times, workflow roles, text, and input modes are client-reported. The server replays accepted and rejected submitted events.</p>
      <ol class="timeline">${events}</ol>
      </details>
    </dialog>`;
}

function sampleButtons(disabled) {
  const locked = disabled ? "disabled" : "";
  if (session.phase === "AWAIT_CALLOUT") {
    return `<button class="sample" data-sample="${escapeHtml(correctStatement)}" ${locked}>Insert scripted callout</button>`;
  }
  if (session.phase === "AWAIT_READBACK") {
    return `
      <button class="sample sample--danger" data-sample="${escapeHtml(wrongStatement)}" ${locked}>Insert scripted mismatch</button>
      <button class="sample" data-sample="${escapeHtml(correctStatement)}" ${locked}>Insert scripted read-back</button>`;
  }
  if (session.phase === "AWAIT_LABEL") {
    return `
      <button class="sample sample--danger" data-sample="${syntheticCases[1].labelCode}" ${locked}>Insert scripted wrong label</button>
      <button class="sample" data-sample="${primaryDemoCase.labelCode}" ${locked}>Insert scripted label</button>`;
  }
  return "";
}

function captureMarkup() {
  const prompts = {
    AWAIT_CALLOUT: {
      role: "WORKFLOW ROLE · SURGEON",
      title: "State the complete specimen callout",
      helper: "Supported order: laterality, approved anatomy, disposition, then one container count.",
    },
    AWAIT_READBACK: {
      role: "WORKFLOW ROLE · CIRCULATING NURSE",
      title: "Repeat the complete read-back",
      helper: "Use one fresh complete statement. Do not use “yes,” “same,” corrections, or uncertain wording.",
    },
    AWAIT_LABEL: {
      role: "WORKFLOW ROLE · CIRCULATING NURSE",
      title: "Capture the synthetic label code",
      helper: "Camera decoding and manual entry are recorded as different, client-reported input modes.",
    },
  };
  const prompt = prompts[session.phase];
  if (!prompt) return "";
  const labelMode = session.phase === "AWAIT_LABEL";
  const captureActive = coordinator.captureActive;
  const voiceControl = labelMode
    ? `<div class="capture-instrument capture-instrument--scanner"><div class="scan-symbol" aria-hidden="true">⌗</div><p class="instrument-label">Synthetic QR label</p><div class="scanner-control">
        <div><span class="scanner-control__pulse"></span><strong>${escapeHtml(scannerState)}</strong></div>
        <button id="scanner-button" class="voice-button">${scannerBinding ? "Stop camera" : "Start camera scan"}</button>
      </div>
      <div class="scanner-stage" id="scanner-stage" ${scannerBinding ? "" : "hidden"}>
        <video id="label-video" playsinline muted aria-label="Live camera view for synthetic QR label"></video>
        <div class="scanner-stage__frame" aria-hidden="true"></div>
        <p>Center one synthetic QR label inside the frame.</p>
      </div>
      <p class="scanner-help"><a href="/demo-labels.html" target="_blank" rel="noopener">Open printable synthetic QR labels ↗</a></p></div>`
    : `<div class="capture-instrument ${["LIVE", "LISTENING"].includes(voiceState) ? "capture-instrument--active" : ""}"><p class="instrument-label">Voice capture</p><button type="button" id="mic-button" class="mic-symbol" aria-label="${voiceBinding ? "Cancel voice capture" : "Start live transcription"}" aria-pressed="${Boolean(voiceBinding)}"><svg aria-hidden="true" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4"><rect x="18" y="5" width="12" height="25" rx="6"/><path d="M12 22v3a12 12 0 0 0 24 0v-3M24 37v7m-8 0h16"/></svg></button><div class="voice-control voice-control--${voiceState.toLowerCase()}">
        <div aria-live="polite"><span class="voice-control__pulse"></span><strong>${escapeHtml(voiceState)}</strong></div>
        <button id="voice-button" class="voice-button">${voiceBinding ? "Cancel voice capture" : "Start live transcription"}</button>
      </div><p class="instrument-note">Speak one complete statement.<br>Review the transcript before verifying.</p></div>`;
  const currentMode = inputModeLabel(pendingInputMode);
  return `
    <section class="capture-card" aria-labelledby="capture-title">
      <div class="capture-card__prompt">
        <div class="role-chip">${prompt.role}</div>
        <h2 id="capture-title" tabindex="-1">${prompt.title}</h2>
        <p>${prompt.helper}</p>
        <p class="refresh-note">Unfinished sessions exist only in this tab and are discarded on refresh.</p>
      </div>
      <div class="capture-layout">
      ${voiceControl}
      <div class="capture-editor">
      <label class="transcript-box">
        <span>${labelMode ? "Synthetic label input" : "Statement text"}</span>
        ${labelMode
          ? `<input id="evidence-input" type="text" autocomplete="off" placeholder="Enter a synthetic label code" value="${escapeHtml(liveTranscript)}" ${captureActive ? "readonly" : ""}>`
          : `<textarea id="evidence-input" rows="3" placeholder="Live transcription or manual text appears here" ${captureActive ? "readonly" : ""}>${escapeHtml(liveTranscript)}</textarea>`}
      </label>
      <p class="input-mode" id="input-mode">Input mode: ${escapeHtml(currentMode)} <span>client-reported, unverified</span></p>
      <div class="capture-card__actions">
        <details class="sample-tools"><summary>Scripted demo inputs</summary><div class="sample-row">${sampleButtons(captureActive)}</div></details>
        <div class="action-row">
          <button class="secondary-action" id="pause-button" ${captureActive ? "disabled" : ""}>Pause / unresolved discrepancy</button>
          <button class="primary-action" id="verify-button" ${captureActive ? "disabled" : ""}>Verify evidence <span>→</span></button>
        </div>
      </div>
      </div></div>
    </section>`;
}

function reviewRow(label, value, mode) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>${mode ? `<small>${escapeHtml(inputModeLabel(mode))} · client-reported, unverified</small>` : ""}</div>`;
}

function confirmationMarkup() {
  if (session.phase !== "AWAIT_CONFIRMATION") return "";
  return `
    <section class="confirmation-card" aria-labelledby="review-title">
      <p class="eyebrow">Final user assertion</p>
      <h2 id="review-title" tabindex="-1">Review all submitted evidence together.</h2>
      <p>This prototype does not authenticate the person acting in either workflow role and does not verify patient identity or a physical container.</p>
      <dl class="review-grid">
        ${reviewRow("Expected synthetic order", `${session.order.caseId} · ${session.order.specimenName} · ${formatDisposition(session.order.disposition)} · ${session.order.containerCount} container · ${session.order.labelCode}`)}
        ${reviewRow("Accepted workflow-role surgeon callout", fieldSummary(session.callout), session.calloutInputMode)}
        ${reviewRow("Accepted workflow-role nurse read-back", fieldSummary(session.readback), session.readbackInputMode)}
        ${reviewRow("Accepted label code", session.scannedLabel, session.labelInputMode)}
      </dl>
      <label class="confirm-check">
        <input id="confirmation-check" type="checkbox" ${confirmed ? "checked" : ""}>
        <span>I assert that I reviewed the displayed synthetic evidence.</span>
      </label>
      <div class="confirmation-actions">
        <button class="secondary-action" id="pause-button" ${savingEvidence ? "disabled" : ""}>Pause / unresolved discrepancy</button>
        <button class="primary-action" id="confirm-button" ${confirmed && !savingEvidence ? "" : "disabled"}>
          ${savingEvidence ? "Saving evidence…" : pendingCompletion ? "Retry same save" : "Submit user assertion"} <span>→</span>
        </button>
      </div>
      <p class="storage-status">Evidence storage: <strong>${escapeHtml(storageState)}</strong></p>
    </section>`;
}

function unresolvedMarkup() {
  if (session.phase !== "UNRESOLVED") return "";
  return `
    <section class="unresolved-card" aria-labelledby="unresolved-title">
      <p class="eyebrow">Incomplete session</p>
      <h2 id="unresolved-title" tabindex="-1">Paused with an unresolved discrepancy.</h2>
      <p>${escapeHtml(session.unresolvedReason)} No completion receipt was created. Restarting begins a new in-memory session.</p>
      <button class="secondary-action" id="reset-button">Start a new synthetic session</button>
    </section>`;
}

function completeMarkup() {
  if (session.phase !== "COMPLETE") return "";
  const receiptMarkup = receipt ? `<div class="receipt-card">
      <div class="receipt-banner"><span class="receipt-stamp" aria-hidden="true">✓</span><span>Evidence stored<span class="receipt-banner__sub">Server-replayed synthetic session</span></span><span class="receipt-edition">05 / RECEIPT</span></div>
      <p class="eyebrow">Server-replayed synthetic session receipt</p>
      <strong>${escapeHtml(receipt.recordId)}</strong>
      <span>Server receipt time</span>
      <code>${escapeHtml(receipt.recordedAt)}</code>
      <details class="technical-details"><summary>Technical details & limitations</summary><span>SHA-256 evidence-core hash</span>
      <code>${escapeHtml(receipt.evidenceHash)}</code>
      <p>${escapeHtml(receipt.hashScope || "Legacy schema-1 hash covers its expected-order snapshot and canonical submitted audit; the server receipt time is outside that hash.")}</p>
      <p>Workflow roles, input modes, submitted text, and event times are client-reported. This receipt does not prove speech or a physical scan occurred, that no attempt was omitted, or that clinical safety was established.</p></details>
    </div>` : "";
  return `
    <section class="complete-card" aria-labelledby="complete-title">
      <div class="complete-card__seal">✓</div>
      <p class="eyebrow">Synthetic evidence submission complete</p>
      <h2 id="complete-title" tabindex="-1">Submitted fields are consistent.</h2>
      <p>Server replay checked the submitted order, read-back, and label code.</p>
      ${receiptMarkup}
      <dl class="receipt-outcomes"><div><dt>Callout and read-back</dt><dd>✓ Matched</dd></div><div><dt>Label code</dt><dd>✓ Matched</dd></div><div><dt>User assertion</dt><dd>Included</dd></div></dl>
      <p>A user assertion was included. SpeciLoop does not persist raw audio.</p>
      <p class="receipt-limit">Synthetic data only. Does not prove speech or a physical scan occurred. Not for clinical use.</p>
      <button class="secondary-action" id="reset-button">Start a new synthetic session</button>
    </section>`;
}

function phaseMarkup() {
  let currentIndex = phases.findIndex(([key]) => key === session.phase);
  if (session.phase === "UNRESOLVED") currentIndex = -1;
  return phases.map(([, label], index) => {
    const classes = ["phase"];
    if (index === currentIndex) classes.push("phase--current");
    if (currentIndex >= 0 && index < currentIndex) classes.push("phase--done");
    return `<div class="${classes.join(" ")}" ${index === currentIndex ? 'aria-current="step"' : ''}><span>${index < currentIndex ? "✓" : String(index + 1).padStart(2, "0")}</span><strong>${label}</strong></div>`;
  }).join("");
}

function caseStatus() {
  if (session.phase === "COMPLETE") return "COMPLETE";
  if (session.phase === "UNRESOLVED") return "UNRESOLVED";
  return "IN PROGRESS";
}

function focusAfterRender() {
  if (!pendingFocusSelector) return;
  const selector = pendingFocusSelector;
  pendingFocusSelector = null;
  queueMicrotask(() => document.querySelector(selector)?.focus({ preventScroll: false }));
}

function render() {
  root.innerHTML = `
    <div class="app-shell ${workspaceStarted || receipt ? "app-shell--working" : "app-shell--intro"} ${motionPaused ? "motion-paused" : ""}">
      <a class="skip-link" href="#workflow">Skip to verification</a>
      <header class="topbar">
        <a class="brand" href="#top" aria-label="SpeciLoop home"><span class="brand__loop" aria-hidden="true"><i></i><i></i></span><span>SpeciLoop<span class="brand__suffix"> / </span></span></a>
        <div class="topbar__statuses" aria-label="Application status">
          <span><i class="status-light"></i>Local verifier ready</span>
          <span id="global-voice-status">Voice: ${escapeHtml(voiceState)}</span>
          <span id="global-storage-status">Evidence: ${escapeHtml(storageState)}</span>
        </div>
        <div class="synthetic-badge">SYNTHETIC DATA ONLY</div>
      </header>
      <main id="top">
        <section class="hero" aria-labelledby="intro-title">
          <div class="hero__copy">
            <p class="eyebrow"><span class="edition-mark">01 /</span> Voice-assisted specimen handoff</p>
            <h1 id="intro-title">A clear handoff.<br><em>One step<br>at a time.</em></h1>
            <p class="hero__lede">Say it. Read it back. Check the label.<br>Keep the handoff on hold until the submitted details agree.</p>
            <button id="begin-session" class="primary-action hero__action">${session.audit.length > 1 ? "Continue synthetic demo" : "Start synthetic demo"}<span aria-hidden="true">↗</span></button>
            <p class="hero__scope">A working prototype. Synthetic data only.<br>Not for clinical use.</p>
          </div>
          <div class="loop-diagram" role="img" aria-label="Animated concept illustration of a synthetic specimen label. Decorative motion, not live verification status.">
            <div class="hero-orbit hero-orbit--outer" aria-hidden="true"></div><div class="hero-orbit hero-orbit--inner" aria-hidden="true"></div>
            <span class="hero-node hero-node--voice" aria-hidden="true">01 / Spoken statement</span><span class="hero-node hero-node--label" aria-hidden="true">03 / Label reference</span>
            <div class="specimen-object"><span class="object-brand">SpeciLoop /</span><span class="object-category">SYNTHETIC SPECIMEN</span><strong>OR–204</strong><p>Left thyroid lobe<br>Permanent pathology<br>1 container</p><span class="object-code">SL-OR204-01</span><span class="object-bottom">DEMO LABEL · NOT FOR CLINICAL USE</span></div>
            <span class="object-caption">A shared reference.<br>Every step, the same details.</span>
          </div>
          <div class="hero-motion"><span>VOICE → READ-BACK → LABEL → CONFIRM → RECEIPT</span><button type="button" id="motion-toggle" aria-pressed="${motionPaused}">${motionPaused ? "Resume animation" : "Pause animation"}</button></div>
          <div class="hero__rail">${["Callout", "Read-back", "Label", "Confirm", "Receipt"].map((label, index) => `<span><b>0${index + 1}</b>${label}</span>`).join("")}</div>
        </section>
        <section id="workflow" class="workflow-section" tabindex="-1" ${workspaceStarted || receipt ? "" : "hidden"}>
        <div class="workspace-heading"><div><p class="eyebrow">PRECISION STUDIO / SYNTHETIC SESSION</p><h1>Handoff workspace<span>.</span></h1></div><div class="workspace-tools"><button id="about-demo" class="text-button">About this demo ↗</button><button id="open-evidence" class="secondary-action">Evidence trail · ${session.audit.length}</button></div></div>
        <nav class="phase-nav" aria-label="Verification progress">${phaseMarkup()}</nav>
        <div class="workspace">
          <div class="workspace__main">
            <section class="case-card">
              <div class="section-heading"><div><p class="eyebrow">Active synthetic case</p><h2>${session.order.caseId}</h2></div><span class="case-status">${caseStatus()}</span></div>
              <dl class="order-grid">
                <div><dt>Specimen</dt><dd>${session.order.specimenName}</dd></div>
                <div><dt>Disposition</dt><dd>${formatDisposition(session.order.disposition)}</dd></div>
                <div><dt>Containers</dt><dd>${session.order.containerCount}</dd></div>
                <div><dt>Expected label</dt><dd class="mono">${session.order.labelCode}</dd></div>
              </dl>
              <p class="scope-note">Preservation medium, patient identity, and individual physical-container identity are outside this prototype’s supported scope.</p>
            </section>
            ${resultMarkup()}
            ${captureMarkup()}
            ${confirmationMarkup()}
            ${unresolvedMarkup()}
            ${completeMarkup()}
          </div>
          ${evidenceMarkup()}
        </div>
        </section>
      </main>
      <footer><span>Prototype · synthetic data · not for clinical use</span><span>Voice connects only when started · storage status shown above</span></footer>
    </div>`;
  bindEvents();
  focusAfterRender();
}

function setPendingModeAfterManualEdit() {
  if (session.phase === "AWAIT_LABEL") {
    pendingInputMode = INPUT_MODES.MANUAL_LABEL;
  } else if ([INPUT_MODES.LIVE_TRANSCRIPTION, INPUT_MODES.SCRIPTED_SAMPLE].includes(pendingInputMode)) {
    pendingInputMode = INPUT_MODES.EDITED_TRANSCRIPT;
  } else {
    pendingInputMode = INPUT_MODES.MANUAL_TEXT;
  }
  const mode = document.querySelector("#input-mode");
  if (mode) mode.innerHTML = `Input mode: ${escapeHtml(inputModeLabel(pendingInputMode))} <span>client-reported, unverified</span>`;
}

function bindEvents() {
  document.querySelector("#motion-toggle")?.addEventListener("click", (event) => {
    motionPaused = !motionPaused;
    document.querySelector(".app-shell")?.classList.toggle("motion-paused", motionPaused);
    event.currentTarget.setAttribute("aria-pressed", String(motionPaused));
    event.currentTarget.textContent = motionPaused ? "Resume animation" : "Pause animation";
  });
  document.querySelector("#open-evidence")?.addEventListener("click", () => document.querySelector("#evidence-dialog")?.showModal());
  document.querySelector("#close-evidence")?.addEventListener("click", () => document.querySelector("#evidence-dialog")?.close());
  document.querySelector("#begin-session")?.addEventListener("click", () => {
    workspaceStarted = true;
    document.querySelector(".app-shell")?.classList.add("app-shell--working");
    document.querySelector("#workflow").hidden = false;
    document.querySelector("#capture-title")?.focus({ preventScroll: true });
    document.querySelector("#workflow")?.scrollIntoView({ block: "start" });
  });
  document.querySelector(".skip-link")?.addEventListener("click", (event) => {
    event.preventDefault();
    workspaceStarted = true;
    document.querySelector(".app-shell")?.classList.add("app-shell--working");
    document.querySelector("#workflow").hidden = false;
    document.querySelector("#workflow")?.focus();
  });
  document.querySelector("#about-demo")?.addEventListener("click", () => {
    // Do not rerender live media elements while capture owns the current phase.
    document.querySelector(".app-shell")?.classList.remove("app-shell--working");
    document.querySelector("#intro-title")?.scrollIntoView({ block: "start" });
  });
  const renderedOrigin = { sessionId: session.id, phase: session.phase };
  document.querySelectorAll("[data-sample]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.querySelector("#evidence-input");
      if (!input) return;
      input.value = button.dataset.sample;
      coordinator.noteActivity();
      liveTranscript = button.dataset.sample;
      pendingInputMode = INPUT_MODES.SCRIPTED_SAMPLE;
      const mode = document.querySelector("#input-mode");
      if (mode) mode.innerHTML = `Input mode: ${escapeHtml(inputModeLabel(pendingInputMode))} <span>client-reported, unverified</span>`;
      input.focus();
    });
  });

  document.querySelector("#evidence-input")?.addEventListener("input", (event) => {
    coordinator.noteActivity();
    liveTranscript = event.target.value;
    setPendingModeAfterManualEdit();
  });

  document.querySelector("#verify-button")?.addEventListener("click", async () => {
    const input = document.querySelector("#evidence-input");
    if (session.phase === "AWAIT_LABEL") await stopLabelScanner();
    processEvidence(input?.value.trim() || "", pendingInputMode, renderedOrigin);
  });

  document.querySelector("#pause-button")?.addEventListener("click", () => pauseUnresolved(renderedOrigin));
  document.querySelector("#scanner-button")?.addEventListener("click", () => toggleScanner(renderedOrigin));
  document.querySelector("#voice-button")?.addEventListener("click", () => toggleVoice(renderedOrigin));
  document.querySelector("#mic-button")?.addEventListener("click", () => toggleVoice(renderedOrigin));

  document.querySelector("#confirmation-check")?.addEventListener("change", (event) => {
    confirmed = event.target.checked;
    const button = document.querySelector("#confirm-button");
    if (button) button.disabled = !confirmed || savingEvidence;
  });
  document.querySelector("#confirm-button")?.addEventListener("click", saveCompletion);
  document.querySelector("#reset-button")?.addEventListener("click", resetSession);
}

function hasCompletionCapacity(phase = session.phase) {
  return canCompleteWithinEventLimit({ ...session, phase });
}

function originIsCurrent(origin) {
  return origin?.sessionId === session.id && origin?.phase === session.phase;
}

function pauseUnresolved(origin) {
  if (!originIsCurrent(origin)) return;
  if (["COMPLETE", "UNRESOLVED"].includes(session.phase)) return;
  if (session.audit.length >= MAX_EVIDENCE_EVENTS) {
    session = { ...session, phase: "UNRESOLVED", unresolvedReason: "The local event limit was reached." };
  } else {
    session = pauseSession(session);
  }
  coordinator.noteSessionChange();
  pendingCompletion = null;
  confirmed = false;
  storageState = "NOT SAVED";
  notice = { status: "RETRY", summary: "Session paused. Completion remains unavailable." };
  pendingFocusSelector = "#unresolved-title";
  render();
}

function enforceCapacity() {
  if (hasCompletionCapacity()) return true;
  const reason = `The ${MAX_EVIDENCE_EVENTS}-event limit leaves too little space for a complete replayable sequence. Start a new session.`;
  session = session.audit.length < MAX_EVIDENCE_EVENTS
    ? pauseSession(session, reason)
    : { ...session, phase: "UNRESOLVED", unresolvedReason: reason };
  coordinator.noteSessionChange();
  notice = { status: "RETRY", summary: reason };
  pendingFocusSelector = "#unresolved-title";
  render();
  return false;
}

async function toggleScanner(origin) {
  if (!originIsCurrent(origin)) return;
  if (scannerBinding) {
    await stopLabelScanner();
    render();
    return;
  }
  const token = coordinator.beginCapture(session);
  if (!token) return;
  const scanner = new LabelScanner({
    onStatus: (status) => {
      if (coordinator.isCaptureCurrent(token, session)) updateScannerUi(status);
    },
    onCode: async (code) => {
      if (!coordinator.isCaptureCurrent(token, session)) return;
      coordinator.endCapture(token);
      scannerBinding = null;
      await scanner.stop();
      liveTranscript = code;
      pendingInputMode = INPUT_MODES.CAMERA_QR;
      processEvidence(code, pendingInputMode, token);
    },
    onError: async (error) => {
      if (!coordinator.isCaptureCurrent(token, session)) return;
      coordinator.endCapture(token);
      scannerBinding = null;
      await scanner.stop();
      scannerState = "CAMERA ERROR";
      notice = { status: "RETRY", summary: error.message };
      pendingFocusSelector = "#result-notice";
      render();
    },
  });
  scannerBinding = { scanner, token };
  render();
  try {
    await scanner.start(document.querySelector("#label-video"));
    if (!coordinator.isCaptureCurrent(token, session)) await scanner.stop();
  } catch (error) {
    if (!coordinator.isCaptureCurrent(token, session)) return;
    coordinator.endCapture(token);
    scannerBinding = null;
    await scanner.stop();
    scannerState = "CAMERA ERROR";
    notice = { status: "RETRY", summary: error instanceof Error ? error.message : "Could not start the camera scanner." };
    pendingFocusSelector = "#result-notice";
    render();
  }
}

async function toggleVoice(origin) {
  if (!originIsCurrent(origin)) return;
  if (voiceBinding) {
    await stopVoice();
    render();
    return;
  }
  const token = coordinator.beginCapture(session);
  if (!token) return;
  window.speechSynthesis?.cancel();
  const capture = new VoiceCapture({
    onStatus: (status) => {
      if (coordinator.isCaptureCurrent(token, session)) updateVoiceUi(status);
    },
    onPartial: (transcript) => {
      if (!coordinator.isCaptureCurrent(token, session)) return;
      liveTranscript = transcript;
      const input = document.querySelector("#evidence-input");
      if (input) input.value = transcript;
    },
    onFinal: (transcript) => {
      if (!coordinator.isCaptureCurrent(token, session)) return;
      liveTranscript = transcript;
      pendingInputMode = INPUT_MODES.LIVE_TRANSCRIPTION;
      coordinator.endCapture(token);
      voiceBinding = null;
      voiceState = "OFFLINE";
      notice = { status: "READY", summary: "Live transcription is ready for review. Edit if needed, then choose Verify evidence." };
      pendingFocusSelector = "#evidence-input";
      render();
    },
    onError: (error) => {
      if (!coordinator.isCaptureCurrent(token, session)) return;
      coordinator.endCapture(token);
      voiceBinding = null;
      voiceState = "ERROR";
      notice = { status: "RETRY", summary: error.message };
      pendingFocusSelector = "#result-notice";
      render();
    },
  });
  voiceBinding = { capture, token };
  render();
  try {
    await capture.start();
    if (!coordinator.isCaptureCurrent(token, session)) await capture.stop();
  } catch (error) {
    if (!coordinator.isCaptureCurrent(token, session)) return;
    coordinator.endCapture(token);
    voiceBinding = null;
    voiceState = "ERROR";
    notice = { status: "RETRY", summary: error instanceof Error ? error.message : "Could not start live transcription." };
    pendingFocusSelector = "#result-notice";
    render();
  }
}

function updateVoiceUi(status) {
  voiceState = status;
  const control = document.querySelector(".voice-control");
  const statusText = control?.querySelector("strong");
  const globalStatus = document.querySelector("#global-voice-status");
  if (statusText) statusText.textContent = status;
  if (globalStatus) globalStatus.textContent = `Voice: ${status}`;
  control?.classList.toggle("voice-control--live", ["CONNECTING", "LIVE", "LISTENING"].includes(status));
  document.querySelector(".capture-instrument")?.classList.toggle("capture-instrument--active", ["LIVE", "LISTENING"].includes(status));
}

function updateScannerUi(status) {
  scannerState = status;
  const control = document.querySelector(".scanner-control");
  const statusText = control?.querySelector("strong");
  const active = ["STARTING CAMERA", "SCANNING QR", "QR CAPTURED"].includes(status);
  if (statusText) statusText.textContent = status;
  control?.classList.toggle("scanner-control--active", active);
}

async function stopVoice() {
  const binding = voiceBinding;
  if (!binding) return;
  voiceBinding = null;
  coordinator.endCapture(binding.token);
  await binding.capture.stop();
  voiceState = "OFFLINE";
}

async function stopLabelScanner() {
  const binding = scannerBinding;
  if (!binding) return;
  scannerBinding = null;
  coordinator.endCapture(binding.token);
  await binding.scanner.stop();
  scannerState = "CAMERA OFF";
}

function speakStatus(message) {
  if (!("speechSynthesis" in window) || voiceBinding) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(message);
  utterance.rate = 0.94;
  utterance.pitch = 0.96;
  window.speechSynthesis.speak(utterance);
}

function processEvidence(value, inputMode, origin) {
  if (!originIsCurrent(origin)) return;
  if (!enforceCapacity()) return;
  const submission = coordinator.beginSubmission(session);
  if (!submission) {
    notice = { status: "RETRY", summary: "Another capture or verification action still owns this phase." };
    pendingFocusSelector = "#result-notice";
    render();
    return;
  }
  const phaseBefore = session.phase;
  if (!value) {
    coordinator.endSubmission(submission);
    notice = { status: "RETRY", summary: "No evidence was captured." };
    pendingFocusSelector = "#result-notice";
    render();
    return;
  }
  try {
    const next = session.phase === "AWAIT_CALLOUT"
      ? submitCallout(session, value, inputMode)
      : session.phase === "AWAIT_READBACK"
        ? submitReadback(session, value, inputMode)
        : scanLabel(session, value, inputMode);
    if (!coordinator.isSubmissionCurrent(submission, session)) return;
    session = next.session;
    coordinator.endSubmission(submission, { changed: true });
    notice = next.result;
    liveTranscript = "";
    pendingInputMode = session.phase === "AWAIT_LABEL" ? INPUT_MODES.MANUAL_LABEL : INPUT_MODES.MANUAL_TEXT;
    if ([INPUT_MODES.LIVE_TRANSCRIPTION, INPUT_MODES.EDITED_TRANSCRIPT].includes(inputMode)) {
      speakStatus(createSpokenInstruction({ phaseBefore, phaseAfter: session.phase, result: next.result }));
    }
    pendingFocusSelector = next.result.status === "ACCEPT" ? "#capture-title, #review-title" : "#result-notice";
    render();
  } catch (error) {
    coordinator.endSubmission(submission);
    notice = { status: "RETRY", summary: error instanceof Error ? error.message : "Evidence verification failed." };
    pendingFocusSelector = "#result-notice";
    render();
  }
}

async function saveCompletion() {
  if (!confirmed || savingEvidence || !enforceCapacity()) return;
  savingEvidence = true;
  storageState = "SAVING";
  notice = null;
  render();
  try {
    const candidate = pendingCompletion ?? confirmHandoff(session);
    pendingCompletion = candidate;
    const stored = await saveEvidenceRecord(candidate);
    receipt = stored;
    session = sessionFromEvidenceRecord(stored, primaryDemoCase);
    coordinator.noteSessionChange();
    pendingCompletion = null;
    storageState = "STORED";
    notice = { status: "ACCEPT", summary: "Server-replayed synthetic session receipt stored." };
    const receiptUrl = new URL(window.location.href);
    receiptUrl.search = "";
    receiptUrl.searchParams.set("receipt", stored.recordId);
    window.history.replaceState({}, "", receiptUrl);
    pendingFocusSelector = "#complete-title";
  } catch (error) {
    storageState = "SAVE FAILED";
    notice = { status: "RETRY", summary: error instanceof Error ? error.message : "The evidence record could not be stored." };
    pendingFocusSelector = "#result-notice";
  } finally {
    savingEvidence = false;
    render();
  }
}

async function resetSession() {
  await Promise.allSettled([stopVoice(), stopLabelScanner()]);
  session = createSession(primaryDemoCase);
  coordinator.noteSessionChange();
  notice = null;
  confirmed = false;
  receipt = null;
  storageState = "NOT SAVED";
  savingEvidence = false;
  pendingCompletion = null;
  liveTranscript = "";
  pendingInputMode = INPUT_MODES.MANUAL_TEXT;
  window.history.replaceState({}, "", window.location.pathname);
  pendingFocusSelector = "#capture-title";
  render();
}

window.addEventListener("pagehide", () => {
  void stopVoice();
  void stopLabelScanner();
});

render();

async function restoreReceiptFromUrl() {
  const recordId = new URLSearchParams(window.location.search).get("receipt");
  if (!recordId) return;
  const restoreSnapshot = coordinator.snapshot(session);
  storageState = "LOADING RECEIPT";
  render();
  try {
    const stored = await loadEvidenceRecord(recordId);
    if (!coordinator.isSnapshotCurrent(restoreSnapshot, session)) {
      storageState = "NOT SAVED";
      const status = document.querySelector("#global-storage-status");
      if (status) status.textContent = `Evidence: ${storageState}`;
      return;
    }
    receipt = stored;
    session = sessionFromEvidenceRecord(stored, primaryDemoCase);
    coordinator.noteSessionChange();
    confirmed = true;
    storageState = "STORED";
    notice = { status: "ACCEPT", summary: "Server-replayed synthetic session receipt restored." };
    pendingFocusSelector = "#complete-title";
  } catch (error) {
    if (!coordinator.isSnapshotCurrent(restoreSnapshot, session)) {
      storageState = "NOT SAVED";
      const status = document.querySelector("#global-storage-status");
      if (status) status.textContent = `Evidence: ${storageState}`;
      return;
    }
    storageState = "LOAD FAILED";
    notice = { status: "RETRY", summary: error instanceof Error ? error.message : "The evidence receipt could not be restored." };
    pendingFocusSelector = "#result-notice";
  }
  render();
}

void restoreReceiptFromUrl();
