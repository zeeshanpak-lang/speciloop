import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEvidenceRecord } from "./evidence-record.mjs";
import { createEvidenceStore } from "./evidence-store-factory.mjs";
import {
  createMetadataAccessTokenProvider,
  FirestoreEvidenceStore,
} from "./firestore-evidence-store.mjs";

function validRecord() {
  return createEvidenceRecord({
    version: 1,
    clientSessionId: "55555555-5555-4555-8555-555555555555",
    caseId: "OR-204",
    events: [
      { kind: "SESSION_STARTED", at: "2026-09-02T12:00:00.000Z" },
      {
        kind: "CALLOUT_ACCEPTED",
        at: "2026-09-02T12:00:01.000Z",
        transcript: "Left thyroid lobe, permanent pathology, one container.",
      },
      {
        kind: "READBACK_ACCEPTED",
        at: "2026-09-02T12:00:02.000Z",
        transcript: "Left thyroid lobe, permanent pathology, one container.",
      },
      { kind: "LABEL_ACCEPTED", at: "2026-09-02T12:00:03.000Z", transcript: "SL-OR204-01" },
      { kind: "HUMAN_CONFIRMED", at: "2026-09-02T12:00:04.000Z" },
    ],
  }, "2026-09-02T12:01:00.000Z");
}

function documentFor(record) {
  return {
    fields: {
      recordId: { stringValue: record.recordId },
      evidenceHash: { stringValue: record.evidenceHash },
      recordedAt: { timestampValue: record.recordedAt },
      recordJson: { stringValue: JSON.stringify(record) },
    },
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function storeWith(fetchImplementation) {
  return new FirestoreEvidenceStore({
    projectId: "speciloop-test",
    fetchImplementation,
    accessTokenProvider: async () => "test-access-token",
  });
}

describe("Firestore evidence store", () => {
  it("54 creates a server-verified receipt using create-only Firestore semantics", async () => {
    const record = validRecord();
    let observed;
    const store = storeWith(async (url, options) => {
      observed = { url, options };
      return jsonResponse(200, JSON.parse(options.body));
    });

    const saved = await store.save(record);
    assert.equal(saved.created, true);
    assert.equal(saved.record.evidenceHash, record.evidenceHash);
    assert.match(observed.url, /speciloopEvidenceRecords\?documentId=SL-/);
    assert.equal(observed.options.method, "POST");
    assert.equal(observed.options.headers.get("authorization"), "Bearer test-access-token");
  });

  it("55 returns the original receipt when Firestore reports a duplicate", async () => {
    const record = validRecord();
    const requests = [];
    const store = storeWith(async (url, options = {}) => {
      requests.push({ url, method: options.method || "GET" });
      return options.method === "POST"
        ? jsonResponse(409, { error: { message: "Already exists" } })
        : jsonResponse(200, documentFor(record));
    });

    const saved = await store.save(record);
    assert.equal(saved.created, false);
    assert.equal(saved.record.recordId, record.recordId);
    assert.deepEqual(requests.map(({ method }) => method), ["POST", "GET"]);
  });

  it("56 returns null for an unknown cloud receipt", async () => {
    const store = storeWith(async () => jsonResponse(404, { error: { message: "Not found" } }));
    assert.equal(await store.find("SL-1234567890ABCDEF"), null);
  });

  it("57 rejects a cloud document whose evidence was modified", async () => {
    const record = validRecord();
    const changed = structuredClone(record);
    changed.status = "ALTERED";
    const document = documentFor(record);
    document.fields.recordJson.stringValue = JSON.stringify(changed);
    const store = storeWith(async () => jsonResponse(200, document));
    await assert.rejects(() => store.find(record.recordId), /integrity check/);
  });

  it("58 refuses invalid evidence before contacting Firestore", async () => {
    let contacted = false;
    const store = storeWith(async () => {
      contacted = true;
      return jsonResponse(500, {});
    });
    const invalid = validRecord();
    invalid.evidenceHash = "0".repeat(64);
    await assert.rejects(() => store.save(invalid), /invalid evidence/);
    assert.equal(contacted, false);
  });

  it("59 obtains and caches a Cloud Run metadata access token", async () => {
    let requests = 0;
    let observedHeader;
    const provider = createMetadataAccessTokenProvider({
      now: () => 1_000_000,
      fetchImplementation: async (_url, options) => {
        requests += 1;
        observedHeader = options.headers["metadata-flavor"];
        return jsonResponse(200, { access_token: "metadata-token", expires_in: 3600 });
      },
    });
    assert.equal(await provider(), "metadata-token");
    assert.equal(await provider(), "metadata-token");
    assert.equal(requests, 1);
    assert.equal(observedHeader, "Google");
  });

  it("60 keeps local storage as the laptop default", () => {
    const store = createEvidenceStore({ root: "/tmp/speciloop", env: {} });
    assert.equal(store.kind, "local-append-only");
  });

  it("61 fails closed when Cloud Run is configured without Firestore", () => {
    assert.throws(
      () => createEvidenceStore({ root: "/tmp/speciloop", env: { K_SERVICE: "speciloop" } }),
      /requires EVIDENCE_STORE_BACKEND=firestore/,
    );
    const store = createEvidenceStore({
      root: "/tmp/speciloop",
      env: {
        K_SERVICE: "speciloop",
        EVIDENCE_STORE_BACKEND: "firestore",
        GOOGLE_CLOUD_PROJECT: "speciloop-test",
      },
      firestoreOptions: { accessTokenProvider: async () => "unused" },
    });
    assert.equal(store.kind, "firestore-create-only");
  });

  it("62 verifies the configured Firestore database before cloud startup", async () => {
    const store = storeWith(async (url) => jsonResponse(200, {
      name: "projects/speciloop-test/databases/(default)",
      observedUrl: url,
    }));
    assert.equal(await store.assertReady(), true);

    const wrongDatabase = storeWith(async () => jsonResponse(200, {
      name: "projects/another-project/databases/(default)",
    }));
    await assert.rejects(() => wrongDatabase.assertReady(), /unexpected database identity/);
  });
});
