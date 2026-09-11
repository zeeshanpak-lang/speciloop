import { verifyEvidenceRecordIntegrity } from "./evidence-record.mjs";

const RECEIPT_ID_PATTERN = /^SL-[A-F0-9]{16}$/;
const DEFAULT_METADATA_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const DEFAULT_API_ORIGIN = "https://firestore.googleapis.com";
const MAX_RECORD_BYTES = 128_000;

function requireResourceSegment(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 128 || normalized.includes("/") || normalized === "." || normalized === "..") {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function requireReceiptId(value) {
  if (!RECEIPT_ID_PATTERN.test(String(value || ""))) {
    throw new Error("Evidence receipt ID is invalid.");
  }
  return value;
}

async function errorMessage(response, fallback) {
  try {
    const body = await response.json();
    const message = body?.error?.message;
    return typeof message === "string" && message.trim() ? message.trim() : fallback;
  } catch {
    return fallback;
  }
}

function recordFromDocument(document, expectedRecordId) {
  const recordJson = document?.fields?.recordJson?.stringValue;
  if (typeof recordJson !== "string" || Buffer.byteLength(recordJson, "utf8") > MAX_RECORD_BYTES) {
    throw new Error("Firestore evidence document is malformed.");
  }

  let record;
  try {
    record = JSON.parse(recordJson);
  } catch {
    throw new Error("Firestore evidence document contains invalid JSON.");
  }

  if (
    record.recordId !== expectedRecordId ||
    document?.fields?.recordId?.stringValue !== expectedRecordId ||
    document?.fields?.evidenceHash?.stringValue !== record.evidenceHash ||
    document?.fields?.recordedAt?.timestampValue !== record.recordedAt ||
    !verifyEvidenceRecordIntegrity(record)
  ) {
    throw new Error("Firestore evidence document failed its integrity check.");
  }
  return record;
}

export function createMetadataAccessTokenProvider({
  fetchImplementation = fetch,
  metadataUrl = DEFAULT_METADATA_URL,
  now = () => Date.now(),
} = {}) {
  let cached = null;
  let pending = null;

  return async function accessToken() {
    if (cached && cached.expiresAt - now() > 60_000) return cached.value;
    if (pending) return pending;

    pending = (async () => {
      const response = await fetchImplementation(metadataUrl, {
        headers: { "metadata-flavor": "Google" },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw new Error(await errorMessage(response, "Could not obtain the Cloud Run service access token."));
      }
      const body = await response.json();
      if (typeof body?.access_token !== "string" || !body.access_token) {
        throw new Error("Cloud Run returned an invalid service access token.");
      }
      const lifetimeSeconds = Number(body.expires_in);
      cached = {
        value: body.access_token,
        expiresAt: now() + (Number.isFinite(lifetimeSeconds) && lifetimeSeconds > 0 ? lifetimeSeconds : 300) * 1000,
      };
      return cached.value;
    })();

    try {
      return await pending;
    } finally {
      pending = null;
    }
  };
}

export class FirestoreEvidenceStore {
  constructor({
    projectId,
    databaseId = "(default)",
    collectionId = "speciloopEvidenceRecords",
    apiOrigin = DEFAULT_API_ORIGIN,
    fetchImplementation = fetch,
    accessTokenProvider,
  }) {
    this.projectId = requireResourceSegment(projectId, "Google Cloud project ID");
    this.databaseId = requireResourceSegment(databaseId, "Firestore database ID");
    this.collectionId = requireResourceSegment(collectionId, "Firestore collection ID");
    this.apiOrigin = new URL(apiOrigin).origin;
    if (this.apiOrigin !== DEFAULT_API_ORIGIN && !accessTokenProvider) {
      throw new Error("A custom Firestore API origin requires an explicit access-token provider.");
    }
    this.fetchImplementation = fetchImplementation;
    this.accessTokenProvider = accessTokenProvider || createMetadataAccessTokenProvider({ fetchImplementation });
    this.kind = "firestore-create-only";
    this.databaseUrl = [
      this.apiOrigin,
      "v1/projects",
      encodeURIComponent(this.projectId),
      "databases",
      encodeURIComponent(this.databaseId),
    ].join("/");
    this.documentsUrl = [
      this.apiOrigin,
      "v1/projects",
      encodeURIComponent(this.projectId),
      "databases",
      encodeURIComponent(this.databaseId),
      "documents",
    ].join("/");
  }

  async assertReady() {
    const response = await this.request(this.databaseUrl);
    if (!response.ok) {
      throw new Error(await errorMessage(response, "Could not reach the configured Firestore database."));
    }
    const database = await response.json();
    const expectedName = `projects/${this.projectId}/databases/${this.databaseId}`;
    if (database?.name !== expectedName) throw new Error("Firestore returned an unexpected database identity.");
    return true;
  }

  documentUrl(recordId) {
    return `${this.documentsUrl}/${encodeURIComponent(this.collectionId)}/${encodeURIComponent(requireReceiptId(recordId))}`;
  }

  async request(url, options = {}) {
    const token = await this.accessTokenProvider();
    const headers = new Headers(options.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("accept", "application/json");
    return this.fetchImplementation(url, {
      ...options,
      headers,
      signal: options.signal || AbortSignal.timeout(8000),
    });
  }

  async find(recordId) {
    const expectedRecordId = requireReceiptId(recordId);
    const response = await this.request(this.documentUrl(expectedRecordId));
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(await errorMessage(response, "Could not read the Firestore evidence record."));
    }
    return recordFromDocument(await response.json(), expectedRecordId);
  }

  async save(record) {
    if (!verifyEvidenceRecordIntegrity(record)) throw new Error("Refusing to store invalid evidence.");
    if (typeof record.recordedAt !== "string" || !Number.isFinite(Date.parse(record.recordedAt))) {
      throw new Error("Evidence record has an invalid storage timestamp.");
    }
    const recordId = requireReceiptId(record.recordId);
    const recordJson = JSON.stringify(record);
    if (Buffer.byteLength(recordJson, "utf8") > MAX_RECORD_BYTES) {
      throw new Error("Evidence record is too large for cloud storage.");
    }

    const document = {
      fields: {
        recordId: { stringValue: recordId },
        evidenceHash: { stringValue: record.evidenceHash },
        recordedAt: { timestampValue: record.recordedAt },
        recordJson: { stringValue: recordJson },
      },
    };
    const url = `${this.documentsUrl}/${encodeURIComponent(this.collectionId)}?documentId=${encodeURIComponent(recordId)}`;
    const response = await this.request(url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(document),
    });

    if (response.status === 409) {
      const existing = await this.find(recordId);
      if (!existing) throw new Error("Firestore reported a duplicate receipt that could not be read.");
      if (existing.evidenceHash !== record.evidenceHash) {
        throw new Error("Evidence receipt collision detected.");
      }
      return { record: existing, created: false };
    }
    if (!response.ok) {
      throw new Error(await errorMessage(response, "Could not create the Firestore evidence record."));
    }

    return { record: recordFromDocument(await response.json(), recordId), created: true };
  }
}
