import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { verifyEvidenceRecordIntegrity } from "./evidence-record.mjs";

export class AppendOnlyEvidenceStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.kind = "local-append-only";
    this.writeQueue = Promise.resolve();
  }

  async assertReady() {
    return true;
  }

  async readRecords() {
    let contents;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }

    return contents
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const record = JSON.parse(line);
        if (!verifyEvidenceRecordIntegrity(record)) throw new Error("Evidence store integrity check failed.");
        return record;
      });
  }

  async find(recordId) {
    const records = await this.readRecords();
    return records.find((record) => record.recordId === recordId) ?? null;
  }

  async save(record) {
    const operation = this.writeQueue.catch(() => {}).then(async () => {
      if (!verifyEvidenceRecordIntegrity(record)) throw new Error("Refusing to store invalid evidence.");
      const existing = await this.find(record.recordId);
      if (existing) {
        if (existing.evidenceHash !== record.evidenceHash) {
          throw new Error("Evidence receipt collision detected.");
        }
        return { record: existing, created: false };
      }

      await mkdir(dirname(this.filePath), { recursive: true });
      const handle = await open(this.filePath, "a", 0o600);
      try {
        await handle.appendFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { record, created: true };
    });
    this.writeQueue = operation;
    return operation;
  }
}
