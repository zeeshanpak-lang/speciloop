import { resolve } from "node:path";
import { AppendOnlyEvidenceStore } from "./evidence-store.mjs";
import { FirestoreEvidenceStore } from "./firestore-evidence-store.mjs";

export function createEvidenceStore({ root, env = process.env, firestoreOptions = {} }) {
  const configuredBackend = String(env.EVIDENCE_STORE_BACKEND || "").trim().toLowerCase();
  const runningOnCloudRun = Boolean(env.K_SERVICE);
  const backend = configuredBackend || "local";

  if (backend === "local") {
    if (runningOnCloudRun) {
      throw new Error("Cloud Run requires EVIDENCE_STORE_BACKEND=firestore; local evidence files are ephemeral.");
    }
    const filePath = resolve(root, env.EVIDENCE_STORE_PATH || "data/evidence-records.ndjson");
    return new AppendOnlyEvidenceStore(filePath);
  }

  if (backend !== "firestore") {
    throw new Error("EVIDENCE_STORE_BACKEND must be either local or firestore.");
  }

  const projectId = env.GOOGLE_CLOUD_PROJECT || env.GCP_PROJECT || env.GCLOUD_PROJECT;
  if (!projectId) throw new Error("GOOGLE_CLOUD_PROJECT is required for Firestore evidence storage.");

  return new FirestoreEvidenceStore({
    projectId,
    databaseId: env.FIRESTORE_DATABASE_ID || "(default)",
    collectionId: env.FIRESTORE_COLLECTION_ID || "speciloopEvidenceRecords",
    ...firestoreOptions,
  });
}
