# SpeciLoop Cloud Run deployment

This document describes a public, synthetic-only demonstration using Cloud Run, Firestore, Secret Manager, and a dedicated runtime service account. Complete local review and verification before using these steps.

## Required resources

- A Google Cloud project with billing controls suitable for the demo.
- Cloud Run, Cloud Build, Artifact Registry, Firestore, and Secret Manager APIs.
- A Firestore Native database, preferably colocated with Cloud Run.
- A user-managed `speciloop-runtime` service account with `roles/datastore.user`.
- An AssemblyAI key stored only in Secret Manager, with `roles/secretmanager.secretAccessor` granted only to the runtime account.

Do not create or download a service-account key file. If any live credential was ever placed in an archive, shared folder, screenshot, source package, or chat, revoke it at its provider and create a new Secret Manager version before deployment.

## Runtime settings

| Setting | Recommended demo value | Purpose |
| --- | --- | --- |
| `EVIDENCE_STORE_BACKEND` | `firestore` | Prevents Cloud Run from using ephemeral local receipt storage. |
| `GOOGLE_CLOUD_PROJECT` | Your project ID | Selects the Firestore project. |
| `FIRESTORE_DATABASE_ID` | `(default)` | Selects the database. |
| `FIRESTORE_COLLECTION_ID` | `speciloopEvidenceRecords` | Selects the receipt collection. |
| `VOICE_DEMO_ENABLED` | `false` during verification; `true` only for the judged demo | Server switch for token issuance. |
| `VOICE_TOKEN_EXPIRY_SECONDS` | `60` | AssemblyAI temporary-token lifetime. |
| `VOICE_MAX_SESSION_SECONDS` | `120` | Maximum duration attached to every AssemblyAI token request. |
| `VOICE_TOKEN_LIMIT_PER_GRANT` | `4` | Process-local issuance limit for one anonymous browser grant. |
| `VOICE_TOKEN_LIMIT_PER_MINUTE` | `20` | Process-local global token issuance rate. |
| `VOICE_GRANT_LIMIT_PER_MINUTE` | `30` | Process-local anonymous-grant issuance rate. |
| `VOICE_GRANT_TTL_SECONDS` | `600` | Browser grant lifetime. |
| `ASSEMBLYAI_API_KEY` | Secret Manager reference | Provider credential; never a plain source value. |

The browser grant is an anonymous abuse control, not user authentication. Grant and rate-limit state lives only inside one Node process. It does not survive restarts or coordinate between instances. A Cloud Run `--max` setting limits application instances; it does not cap AssemblyAI requests or spending. Configure provider-side budget monitoring separately before making voice public.

AssemblyAI documents `expires_in_seconds` and `max_session_duration_seconds`, including their allowed ranges, in its official [streaming temporary-token guide](https://www.assemblyai.com/docs/streaming/authenticate-with-a-temporary-token).

## Deployment command template

The command below is a template for a future authorized deployment. It must not be run as part of local repair or testing.

```cmd
set PROJECT_ID=replace-with-your-project-id
set REGION=us-central1
set RUNTIME_SA=speciloop-runtime@%PROJECT_ID%.iam.gserviceaccount.com
gcloud config set project %PROJECT_ID%
gcloud run deploy speciloop --source . --region %REGION% --allow-unauthenticated --service-account %RUNTIME_SA% --set-env-vars="EVIDENCE_STORE_BACKEND=firestore,GOOGLE_CLOUD_PROJECT=%PROJECT_ID%,FIRESTORE_DATABASE_ID=(default),FIRESTORE_COLLECTION_ID=speciloopEvidenceRecords,VOICE_DEMO_ENABLED=false,VOICE_TOKEN_EXPIRY_SECONDS=60,VOICE_MAX_SESSION_SECONDS=120,VOICE_TOKEN_LIMIT_PER_GRANT=4,VOICE_TOKEN_LIMIT_PER_MINUTE=20,VOICE_GRANT_LIMIT_PER_MINUTE=30,VOICE_GRANT_TTL_SECONDS=600" --set-secrets="ASSEMBLYAI_API_KEY=assemblyai-api-key:latest" --min=0 --max=2 --memory=512Mi --cpu=1 --timeout=300
```

Start with voice disabled. After local and deployed non-voice checks succeed, enable it only for the demonstration window with an authorized Cloud Run configuration update.

## Release and source-upload gate

Stage only intended source files in a separate directory, then run:

```bash
node scripts/validate-release.mjs path-to-staged-release
```

The validator must pass before any source archive is created or uploaded. It rejects `.env` variants other than placeholder-only `.env.example`, Git history, local evidence data, credential/private-key files, `node_modules`, and generated build directories. The existing `.gcloudignore` and Dockerfile also limit deployed files, but they do not replace validation of a separately distributed archive.

## Post-deployment checks

1. Require `/api/health` to report `"evidenceStore":"firestore-create-only"` and the intended voice switch state.
2. Confirm direct `/api/streaming-token` requests without a valid anonymous demo grant return `401`.
3. With voice disabled, confirm grant/token endpoints return a disabled response.
4. Complete the bounded typed demo, including wrong laterality, correction, wrong label, and final review.
5. Save one receipt, retry the same candidate if simulating a lost response, and require the same receipt ID.
6. Refresh the receipt URL and require the same server-stored record.
7. Confirm the matching Firestore document exists.
8. When voice is intentionally enabled, run one short authorized capture and inspect provider usage.

Do not describe the result as clinically validated, authenticated evidence, proof that speech or a physical scan occurred, immutable storage, or production-ready abuse prevention.
