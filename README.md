# SpeciLoop

SpeciLoop is a synthetic-data prototype for replaying a bounded surgical-specimen callout, read-back, label-code, and user-confirmation sequence. A deterministic verifier blocks mismatched or unsupported statements. It is not a clinical device and must not receive real patient or staff information.

## Implemented scope

- One synthetic case at a time, with expected anatomy, laterality, disposition, container count, and label code.
- Deterministic statement interpretation and a phase-ordered state machine.
- AssemblyAI streaming transcription as an optional input path; transcription never authorizes acceptance on its own.
- Synthetic QR decoding with manual label-code fallback.
- Explicit user assertion before completion.
- Server replay of every submitted accepted and rejected event.
- Schema-2 receipts with client-reported input modes and backward-compatible schema-1 verification.
- Local JSONL or application-level create-only Firestore storage.
- Receipt restoration by URL, bounded request timeouts, and idempotent completion retries.
- An unresolved pause state that cannot produce a completion receipt.

SpeciLoop does not verify a patient, a staff member, a workflow-role speaker, or an individual physical container. It has no EHR integration. Preservation medium is outside the current disposition model.

## Supported statement contract

The verifier intentionally supports this order only:

`[optional article] <laterality> <approved anatomy> <disposition> <count> <container noun>`

For the OR-204 demonstration:

- Laterality vocabulary: `left`, `right`, or `midline`.
- Approved anatomy: `thyroid lobe` or `lobe of thyroid`.
- Disposition vocabulary: `permanent pathology`/`permanent`, `frozen section`/`frozen`, `culture`, or `fresh`.
- Count: digits `1` through `10` or words `one` through `ten`.
- Container noun: `container`, `containers`, `jar`, or `jars`.
- Capitalization and punctuation may vary. An initial `a` or `the` is allowed.

Negation, uncertainty, corrections, explicit stop language, multiple count statements, additional anatomy, conflicting synthetic case identifiers, patient identifiers, preservation terms, unsupported counts, and other added language cannot receive `ACCEPT`. A correction or ambiguity requires a fresh complete statement; the verifier does not choose the last value.

`formalin`, `saline`, and other preservation terms return an explicit unsupported-scope result. They are not treated as examination disposition.

## Input provenance

The browser and receipt distinguish:

- Live transcription.
- Manually entered text.
- Edited transcript.
- Scripted sample input.
- Camera-decoded QR label.
- Manually entered label.
- User confirmation assertion.

These modes, event times, submitted text, and workflow roles are client-reported and unverified. A receipt does not prove that speech occurred, that a physical label was scanned, or that rejected attempts were never omitted.

## Run locally

```bash
cp .env.example .env
# Put a development AssemblyAI key in the untracked .env only if voice is needed,
# and intentionally set VOICE_DEMO_ENABLED=true for that session.
npm run dev
```

On Windows Command Prompt, use `copy .env.example .env`. On PowerShell, use `Copy-Item .env.example .env`. Typed and scripted inputs work with no AssemblyAI key. Open `http://localhost:3000`; microphone and camera access require localhost or HTTPS.

Unfinished sessions are in memory and are discarded on refresh. Completed receipts can be restored from their receipt URL when the configured evidence store remains available.

## Test

```bash
npm test
npm run build
npm run smoke
```

Run all three with `npm run verify`. Tests mock browser media, WebSocket, and AssemblyAI provider requests; they do not require credentials or paid API calls.

Before packaging a separately staged release directory, run:

```bash
node scripts/validate-release.mjs path-to-staged-release
```

The check rejects secret-bearing environment files, Git history, local evidence, credentials, private keys, dependencies, and generated build output. `.env.example` is allowed only when sensitive settings contain placeholders.

## Voice access and limits

The AssemblyAI key remains on the server. A browser first obtains an opaque, short-lived public-demo grant bound to an HttpOnly same-site cookie, then presents the paired access token when requesting a one-time AssemblyAI streaming token. No shared secret is embedded in browser code.

Defaults:

| Setting | Default | Valid range |
| --- | ---: | ---: |
| `VOICE_DEMO_ENABLED` | `false` | Boolean |
| `VOICE_TOKEN_EXPIRY_SECONDS` | `60` | 1–600 |
| `VOICE_MAX_SESSION_SECONDS` | `120` | 60–10,800 |
| `VOICE_TOKEN_LIMIT_PER_GRANT` | `4` | 1–100 |
| `VOICE_TOKEN_LIMIT_PER_MINUTE` | `20` | 1–1,000 |
| `VOICE_GRANT_LIMIT_PER_MINUTE` | `30` | 1–1,000 |
| `VOICE_GRANT_TTL_SECONDS` | `600` | 60–3,600 |

The grant and rate-limit state is process-local. It is lost on restart and is not coordinated across Cloud Run instances. These controls reduce casual public-demo abuse; they are not user authentication or a durable account-wide spending cap. Cloud Run instance limits do not cap AssemblyAI usage.

The token parameter names and ranges follow AssemblyAI’s official [temporary-token documentation](https://www.assemblyai.com/docs/streaming/authenticate-with-a-temporary-token): `expires_in_seconds` is 1–600 and `max_session_duration_seconds` is 60–10,800.

## Evidence receipt meaning

The UI describes a completed record as a **“Server-replayed synthetic session receipt.”** The server reconstructs the submitted sequence with the deterministic verifier and rejects a claimed verdict that disagrees with replay.

For schema 2, SHA-256 covers the schema version, source session ID, synthetic case ID, status, expected-order snapshot, canonical replayed audit, receipt description, limitations, and hash-scope statement. It excludes the derived receipt ID and server receipt time. The same completion candidate therefore keeps the same receipt ID across an idempotent retry, while the first successful stored server receipt time is retained.

Event times are client-reported. The server requires them to be ordered and rejects any event more than five minutes ahead of its injectable server clock; the separately displayed `recordedAt` value is server receipt time.

The hash demonstrates consistency of the fields it covers. It is not a signature, authenticated provenance, immutable storage, or proof of clinical safety. Local JSONL is append-only through this application. Firestore writes are create-only through this application. Neither is regulatory write-once storage.

SpeciLoop does not persist raw audio. Provider-side retention and account settings must be evaluated separately; this application does not attest to them.

## Demo sequence

1. Enter or transcribe the correct workflow-role surgeon statement, review it, then verify.
2. Submit a wrong workflow-role nurse read-back and observe that the phase does not advance.
3. Submit a fresh corrected read-back.
4. Submit a wrong synthetic label code and observe the block.
5. Submit the correct code by camera, manual entry, or scripted input.
6. Review the expected order, accepted callout, accepted read-back, label code, and their reported input modes together.
7. Make the user assertion and store the receipt.
8. Refresh its URL and restore the same server-stored receipt.

The strongest supported claim is: **SpeciLoop server-replays whether submitted bounded synthetic statement fields and a label code agree before recording a user-confirmed demo completion.**
