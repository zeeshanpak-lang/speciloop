import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const port = 3107;
const temporaryDirectory = await mkdtemp(join(tmpdir(), "speciloop-smoke-"));
const evidenceStorePath = join(temporaryDirectory, "evidence.ndjson");
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: projectRoot,
  env: {
    ...process.env,
    PORT: String(port),
    EVIDENCE_STORE_PATH: evidenceStorePath,
    ASSEMBLYAI_API_KEY: "",
    VOICE_DEMO_ENABLED: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Server startup timed out.")), 5000);
  child.stdout.on("data", (chunk) => {
    if (chunk.toString().includes("SpeciLoop ready")) {
      clearTimeout(timer);
      resolve();
    }
  });
  child.stderr.on("data", (chunk) => reject(new Error(chunk.toString())));
  child.on("exit", (code) => reject(new Error(`Server exited early with ${code}.`)));
});

try {
  await ready;
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: "ready",
    verifier: "deterministic",
    data: "synthetic-only",
    evidenceStore: "local-append-only",
    voice: "available-on-request",
  });

  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.match(await page.text(), /<title>SpeciLoop — Read-back verification<\/title>/);

  const app = await fetch(`http://127.0.0.1:${port}/src/app.js`);
  assert.equal(app.status, 200);
  const appSource = await app.text();
  assert.match(appSource, /A clear handoff/);
  assert.match(appSource, /Handoff workspace/);
  const stylesheet = await fetch(`http://127.0.0.1:${port}/src/precision.css`);
  assert.equal(stylesheet.status, 200);
  assert.match(await stylesheet.text(), /\.workflow-section/);
  assert.match(appSource, /Local verifier ready/);
  assert.match(appSource, /SpeciLoop does not persist raw audio/);
  assert.doesNotMatch(appSource, /Deterministic verifier online|AssemblyAI U3\.5 Pro live/);

  for (const privatePath of [
    "/.env",
    "/.dockerignore",
    "/.gcloudignore",
    "/Dockerfile",
    "/DEPLOYMENT.md",
    "/package.json",
    "/server.mjs",
    "/server/firestore-evidence-store.mjs",
    "/scripts/smoke.mjs",
    "/src/domain/verifier.test.js",
    "/data/evidence-records.ndjson",
  ]) {
    const privateResponse = await fetch(`http://127.0.0.1:${port}${privatePath}`);
    assert.equal(privateResponse.status, 404, `${privatePath} must never be served`);
  }

  const scanner = await fetch(`http://127.0.0.1:${port}/src/label-scanner.js`);
  assert.equal(scanner.status, 200);
  assert.match(await scanner.text(), /class LabelScanner/);

  const labels = await fetch(`http://127.0.0.1:${port}/demo-labels.html`);
  assert.equal(labels.status, 200);
  assert.match(await labels.text(), /SpeciLoop synthetic QR labels/);

  const token = await fetch(`http://127.0.0.1:${port}/api/streaming-token`);
  assert.equal(token.status, 401);
  assert.deepEqual(await token.json(), {
    error: "A valid public demo voice grant is required.",
  });

  const grantResponse = await fetch(`http://127.0.0.1:${port}/api/demo-access`, {
    headers: { "sec-fetch-site": "same-origin" },
  });
  assert.equal(grantResponse.status, 200);
  const grant = await grantResponse.json();
  assert.equal(typeof grant.accessToken, "string");
  const cookie = grantResponse.headers.get("set-cookie").split(";")[0];
  const authorizedToken = await fetch(`http://127.0.0.1:${port}/api/streaming-token`, {
    headers: {
      cookie,
      "sec-fetch-site": "same-origin",
      "x-speciloop-demo-access": grant.accessToken,
    },
  });
  assert.equal(authorizedToken.status, 503);
  assert.deepEqual(await authorizedToken.json(), {
    error: "AssemblyAI is not configured on the server.",
  });

  const crossSiteToken = await fetch(`http://127.0.0.1:${port}/api/streaming-token`, {
    headers: { "sec-fetch-site": "cross-site" },
  });
  assert.equal(crossSiteToken.status, 403);
  assert.deepEqual(await crossSiteToken.json(), {
    error: "Cross-site voice token requests are not allowed.",
  });

  const evidencePayload = {
    version: 2,
    clientSessionId: "22222222-2222-4222-8222-222222222222",
    caseId: "OR-204",
    events: [
      { kind: "SESSION_STARTED", at: "2026-09-02T12:00:00.000Z" },
      {
        kind: "CALLOUT_ACCEPTED",
        at: "2026-09-02T12:00:01.000Z",
        transcript: "Left thyroid lobe, permanent pathology, one container.",
        inputMode: "live_transcription",
      },
      {
        kind: "READBACK_ACCEPTED",
        at: "2026-09-02T12:00:02.000Z",
        transcript: "Left thyroid lobe, permanent pathology, one container.",
        inputMode: "edited_transcript",
      },
      {
        kind: "LABEL_ACCEPTED",
        at: "2026-09-02T12:00:03.000Z",
        transcript: "SL-OR204-01",
        inputMode: "camera_qr",
      },
      {
        kind: "HUMAN_CONFIRMED",
        at: "2026-09-02T12:00:04.000Z",
        inputMode: "user_assertion",
      },
    ],
  };
  const storedResponse = await fetch(`http://127.0.0.1:${port}/api/evidence-records`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(evidencePayload),
  });
  assert.equal(storedResponse.status, 201);
  const stored = (await storedResponse.json()).record;
  assert.match(stored.recordId, /^SL-[A-F0-9]{16}$/);
  assert.equal(stored.status, "COMPLETE");

  const restoredResponse = await fetch(`http://127.0.0.1:${port}/api/evidence-records/${stored.recordId}`);
  assert.equal(restoredResponse.status, 200);
  assert.equal((await restoredResponse.json()).record.evidenceHash, stored.evidenceHash);
  assert.equal((await readFile(evidenceStorePath, "utf8")).trim().split("\n").length, 1);

  const duplicateResponse = await fetch(`http://127.0.0.1:${port}/api/evidence-records`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(evidencePayload),
  });
  assert.equal(duplicateResponse.status, 200);
  assert.equal((await readFile(evidenceStorePath, "utf8")).trim().split("\n").length, 1);

  const crossSiteEvidence = await fetch(`http://127.0.0.1:${port}/api/evidence-records`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
    body: JSON.stringify(evidencePayload),
  });
  assert.equal(crossSiteEvidence.status, 403);

  const incompleteEvidence = structuredClone(evidencePayload);
  incompleteEvidence.clientSessionId = "33333333-3333-4333-8333-333333333333";
  incompleteEvidence.events.pop();
  const incompleteResponse = await fetch(`http://127.0.0.1:${port}/api/evidence-records`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(incompleteEvidence),
  });
  assert.equal(incompleteResponse.status, 422);

  const traversal = await fetch(`http://127.0.0.1:${port}/..%2Fpackage.json`);
  assert.equal(traversal.status, 404);
  console.log("Smoke test passed: health, public assets, voice-grant guard, private-file denial, evidence persistence, secret guard, and traversal guard.");
} finally {
  child.kill("SIGTERM");
  await rm(temporaryDirectory, { recursive: true, force: true });
}
