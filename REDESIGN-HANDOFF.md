# SpeciLoop Precision Studio — QA candidate 4

## QA4 polish

Reduced desktop hero height and illustration scale while retaining animation and pause controls. Tightened case summary, status, and capture spacing. Increased helper and metadata type size. Moved the receipt directly below the completion message, before the outcome summary. Corrected receipt header alignment and stamp contrast with scoped selectors. Added src/polish.css, loaded after precision.css. User confirmed the QA3 microphone button starts transcription; this release does not change that behavior.

QA4 automated verification: 113 existing tests and 7 UI template tests pass; build and smoke checks pass. New visual spacing still needs browser review at the user's viewport. Earlier screenshots establish QA3 appearance only.

## Delivered

A charcoal, ivory, and lime interface based on the approved Precision Studio concept. This release restructures the workflow, not only the homepage. Desktop uses a left step rail and compact specimen summary. Voice controls and editable transcript appear side by side. Rejected statements display all four expected/submitted fields using the existing verifier output. Label capture has a separate camera instrument and manual-entry area. Confirmation uses review rows and preserves the explicit assertion checkbox. Receipts have concise outcomes and expandable technical details. Evidence opens on demand in a native modal drawer, with a close button and Escape dismissal. Mobile styles stack the task areas and use a horizontal step strip.

The homepage now features a floating CSS demonstration label, orbit lines, moving annotation chips, and an animation pause control. Motion respects reduced-motion preferences. These are decorative concept elements, not live verification indicators. The microphone is now an accessible start/cancel button sharing the existing transcription action. Status labels reflect actual capture callbacks, without an invented waveform. Workflow panels have stronger borders, spacing, and surface hierarchy. The stored receipt has a prominent dark card, lime identifier, and evidence-stored banner; technical details remain available.

Changed files for this release: index.html, src/app.js, src/precision.css, package.json, scripts/smoke.mjs, scripts/ui-render.test.mjs, and this handoff. precision.css imports the previous redesign.css base. The server, verification rules, evidence contracts, and voice implementation remain unchanged. No production deployment was performed.

## Verification

- All 113 existing tests passed.
- Seven additional UI-template tests passed (capture separation, readonly/disabled controls, label inputs, actual mismatch output, escaping, receipt details, and dialog markup).
- Build passed.
- Server smoke checks passed, including evidence persistence and private-file protection.
- Rendered browser inspection and desktop/mobile screenshots could not be completed: the available browser blocked access to the local preview server.
- Real microphone transcription and camera scanning were not tested in this environment.

The automated tests do not establish visual quality, accessibility conformance, or live provider connectivity. Review the following before deployment.

## Run locally

From the extracted project directory, with Node.js available:

```sh
npm run verify
npm start
```

Use the address printed by the server. Voice requires the existing server-side configuration documented in DEPLOYMENT.md; do not put API keys in browser code. Google Fonts are requested externally; system fallbacks are configured if unavailable.

## Pre-deployment browser checklist

1. Check the introduction and workspace at desktop, tablet, and narrow mobile widths. Check zoom, contrast, keyboard navigation, and focus visibility.
2. Start the synthetic demo. Submit an incorrect callout, correct it, then complete read-back, label, explicit confirmation, and receipt storage.
3. Verify that mismatches never advance the workflow and that the pause action remains incomplete.
4. Test live transcription from both the microphone icon and the text button, denied microphone permission, cancellation, and retry. Verify camera scanning and manual label entry separately. A completed utterance becomes editable for review; Cancel voice capture retains the existing cancellation behavior and is not a new recording-finalization feature.
5. Check that scripted inputs are labeled as scripted, and that evidence status distinguishes unsaved from stored.
6. Check returning to the introduction during capture without losing session state.
7. Test a staging revision before routing production traffic. Keep the existing revision available for rollback.
8. Open and close Evidence trail using mouse and keyboard, including Escape. Check focus returns to its trigger. Check Technical details on the receipt and the missing-field/mismatch table.
9. Pause and resume hero animation. Enable the operating system reduced-motion preference and confirm the hero remains static. Verify receipt highlighting only appears after a stored receipt is returned.

This is a synthetic-data prototype, not a clinically validated system. The receipt establishes consistency of submitted fields, not proof of a physical scan, speech, patient identity, or clinical safety.
