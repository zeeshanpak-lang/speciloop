import { readFile, readdir } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const forbiddenDirectoryNames = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  "data",
]);

const forbiddenCredentialNames = [
  /^credentials?(?:\..+)?$/i,
  /^service[-_]?account.*\.json$/i,
  /^application_default_credentials\.json$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /\.(?:pem|key|p12|pfx|jks)$/i,
];

const secretContentPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /"private_key"\s*:\s*"-----BEGIN/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
];

function environmentFileForbidden(name) {
  return name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
}

function placeholderValue(value) {
  const normalized = value.trim().replace(/^['"]|['"]$/g, "");
  return !normalized
    || /(?:replace|placeholder|example|your[_ -]|not[_ -]?set|disabled|<[^>]+>)/i.test(normalized);
}

function validateEnvironmentExample(contents, filePath, findings) {
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!match || !/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY)$/i.test(match[1])) continue;
    if (!placeholderValue(match[2])) {
      findings.push(`${filePath}:${index + 1} contains a non-placeholder sensitive setting.`);
    }
  }
}

async function scanTextFile(absolutePath, displayPath, findings) {
  const contents = await readFile(absolutePath);
  if (contents.length > 1_000_000 || contents.includes(0)) return;
  const text = contents.toString("utf8");
  if (basename(absolutePath) === ".env.example") {
    validateEnvironmentExample(text, displayPath, findings);
  }
  for (const pattern of secretContentPatterns) {
    if (pattern.test(text)) {
      findings.push(`${displayPath} contains material resembling credentials or a private key.`);
      break;
    }
  }
}

export async function validateReleaseContents(targetDirectory) {
  const root = resolve(targetDirectory);
  const findings = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      const displayPath = relative(root, absolutePath) || entry.name;
      if (entry.isSymbolicLink()) {
        findings.push(`${displayPath} is a symbolic link; release links are not allowed.`);
        continue;
      }
      if (entry.isDirectory()) {
        if (forbiddenDirectoryNames.has(entry.name)) {
          findings.push(`${displayPath}/ is forbidden release content.`);
        } else {
          await visit(absolutePath);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (environmentFileForbidden(entry.name)) {
        findings.push(`${displayPath} is a secret-bearing environment filename.`);
        continue;
      }
      if (forbiddenCredentialNames.some((pattern) => pattern.test(entry.name))) {
        findings.push(`${displayPath} is a credential or private-key filename.`);
        continue;
      }
      if (/evidence.*\.(?:ndjson|jsonl|json)$/i.test(entry.name)) {
        findings.push(`${displayPath} appears to contain local evidence data.`);
        continue;
      }
      await scanTextFile(absolutePath, displayPath, findings);
    }
  }

  await visit(root);
  return { ok: findings.length === 0, findings };
}

async function main() {
  const target = process.argv[2] || process.cwd();
  const result = await validateReleaseContents(target);
  if (!result.ok) {
    console.error("Release-content validation failed:");
    for (const finding of result.findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log("Release-content validation passed.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
