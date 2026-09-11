# SpeciLoop repair checkpoint

Checkpoint date: 2026-09-09  
Application version: 0.4.1

## Included repairs

- Bounded statement contract with conservative handling of negation, uncertainty, correction, stop language, multiple values, added anatomy, identity references, preservation terms, and unsupported counts.
- Fresh-statement requirement after correction or unresolved wording.
- Client input-mode distinctions for live transcription, manual text, edited transcripts, scripted samples, camera-decoded labels, manual labels, and user assertions.
- Session-, phase-, and capture-ID binding for asynchronous capture callbacks.
- Idempotent microphone, audio graph, and WebSocket cleanup across pending startup, cancellation, failure, close, and navigation.
- Receiver-safe browser `fetch` and timer bindings during voice startup.
- Manual/live submission ownership that prevents two actions from advancing one phase.
- Schema-2 server receipts with explicit client-reported provenance and schema-1 compatibility.
- Five-minute future-event tolerance with an injectable server clock.
- Save/load timeouts, retained completion candidates, idempotent retries, and receipt-restoration invalidation after new interaction.
- Event-capacity reservation and a non-completable unresolved pause state.
- Anonymous, cookie-bound public-demo voice grants, explicit AssemblyAI maximum session duration, a voice-disable switch, and configurable process-local issuance limits.
- Final review of expected order, accepted callout, accepted read-back, label code, and reported input modes.
- Accurate local-verifier, voice-connection, and evidence-storage statuses; keyboard focus targets and reduced-motion CSS.
- Release-content validation for secrets, Git history, local evidence, credentials, private keys, dependencies, and generated output.

## Local verification completed

- 113 tests pass with credentials absent and provider/media calls mocked.
- Dependency-free browser build completes.
- Local HTTP smoke checks pass for health, public assets, anonymous voice-grant enforcement, private-file denial, schema-2 evidence persistence, idempotency, cross-site guards, and path traversal.
- JavaScript syntax checks pass.
- The release-content validator’s safe and forbidden fixtures pass.

## Target-browser follow-up (user screenshots, 2026-09-09)

- Corrected browser receiver binding for fetch, setTimeout, and clearTimeout is included in this release.
- User screenshots show live-transcribed surgeon callout and nurse read-back accepted, advancing to Label in Windows Edge.
- Earlier user screenshots show typed-flow mismatch blocking, stored receipt and refresh restoration, and unresolved-session restart behavior. Zoom checks were user-performed, not an automated accessibility audit.
- Offline release checks rerun: 113 tests passed; build and HTTP smoke checks passed. No paid provider calls were made during packaging.

## Remaining verification limits

- Camera QR decoding in the target Windows browser remains unverified.
- Full accessibility and focus behavior at 200% browser zoom remain unaudited.
- Firestore and Cloud Run operation after these changes.
- Multi-instance effectiveness of voice limits; the implemented counters are intentionally process-local.
- Clinical workflow validity, patient identity, staff identity, physical-container identity, or clinical safety.

## Receipt boundary

A schema-2 receipt is a **server-replayed synthetic session receipt**. Submitted text, event times, input modes, and workflow roles remain client-reported and unverified. Its content-derived hash covers the fields named by `hashScope` and excludes the derived receipt ID and server receipt time. It is not a signature or authenticated provenance.

Local JSONL append and Firestore create-only behavior are application-level controls. Neither store is immutable or regulatory write-once storage. SpeciLoop does not persist raw audio; provider-side retention is outside this application’s attestation.

## Before any future deployment

1. Review the local diff and run `npm run verify` on the target computer.
2. If the uploaded source archive’s `.env` contained a live key, revoke that key and create a new provider key. Do not copy the archived `.env` into this checkpoint.
3. Put the replacement key only in a new local untracked `.env` for development or a new Secret Manager version for Cloud Run.
4. Keep `VOICE_DEMO_ENABLED=false` while validating typed flows and storage.
5. Configure the documented voice duration and issuance limits, plus provider-side usage monitoring.
6. Perform an authorized deployment only after review; this checkpoint has not been deployed.
7. Run the post-deployment gates in `DEPLOYMENT.md`, including one intentionally short live-voice check if voice is enabled.

The corrected final ZIP was requested after advance notification. It excludes credentials, local evidence data, and generated build output. Cloud Run remains unchanged. Before creating any future ZIP, notify the user first.
