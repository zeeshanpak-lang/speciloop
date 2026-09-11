import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { validateReleaseContents } from "./validate-release.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "speciloop-release-"));
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src", "app.js"), "export const safe = true;\n");
  await writeFile(join(directory, ".env.example"), "ASSEMBLYAI_API_KEY=replace_with_your_key\nVOICE_DEMO_ENABLED=false\n");
  return directory;
}

describe("release-content validation", () => {
  it("allows a placeholder-only .env.example", async () => {
    const directory = await fixture();
    try {
      assert.deepEqual(await validateReleaseContents(directory), { ok: true, findings: [] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  for (const [label, relativePath, contents = "blocked"] of [
    ["environment files", ".env"],
    ["environment variants", ".env.production"],
    ["credential files", "service-account.json", "{}"],
    ["private keys", "private.pem", "blocked"],
    ["local evidence", "evidence-records.ndjson", "{}\n"],
  ]) {
    it(`rejects ${label}`, async () => {
      const directory = await fixture();
      try {
        await writeFile(join(directory, relativePath), contents);
        const result = await validateReleaseContents(directory);
        assert.equal(result.ok, false);
        assert.ok(result.findings.length > 0);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  for (const name of [".git", "node_modules", "dist", "data"]) {
    it(`rejects ${name} directories`, async () => {
      const directory = await fixture();
      try {
        await mkdir(join(directory, name));
        const result = await validateReleaseContents(directory);
        assert.equal(result.ok, false);
        assert.match(result.findings.join("\n"), new RegExp(name.replace(".", "\\.")));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  it("rejects a real-looking secret in .env.example", async () => {
    const directory = await fixture();
    try {
      await writeFile(join(directory, ".env.example"), "ASSEMBLYAI_API_KEY=live_secret_value_123\n");
      const result = await validateReleaseContents(directory);
      assert.equal(result.ok, false);
      assert.match(result.findings.join("\n"), /non-placeholder sensitive setting/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
