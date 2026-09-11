import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createEvidenceRecord, EvidenceValidationError } from "./server/evidence-record.mjs";
import { createEvidenceStore } from "./server/evidence-store-factory.mjs";
import {
  createVoiceAccessController,
  readVoiceConfig,
  requestAssemblyAiTemporaryToken,
} from "./server/voice-access.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 3000);
const evidenceRequests = new Map();
const voiceConfig = readVoiceConfig(process.env);
const voiceAccess = createVoiceAccessController({ config: voiceConfig });
const evidenceStore = createEvidenceStore({ root, env: process.env });
await evidenceStore.assertReady();
const publicRootFiles = new Set(["index.html", "demo-labels.html"]);
const securityHeaders = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "connect-src 'self' https://streaming.assemblyai.com wss://streaming.assemblyai.com",
    "img-src 'self' data:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; "),
  "permissions-policy": "camera=(self), microphone=(self), geolocation=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
};
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function writeHead(response, status, headers = {}) {
  response.writeHead(status, { ...securityHeaders, ...headers });
}

function writeJson(response, status, body) {
  writeHead(response, status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function sameOriginAllowed(request) {
  const fetchSite = request.headers["sec-fetch-site"];
  return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
}

function applyRateLimit(request, bucket, maximum, error) {
  // This is only a best-effort abuse throttle. It is not authentication.
  const client = request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const recent = (bucket.get(client) || []).filter((time) => now - time < 60_000);
  if (recent.length >= maximum) return { allowed: false, status: 429, error };
  recent.push(now);
  bucket.set(client, recent);
  if (bucket.size > 1000) {
    for (const [key, times] of bucket) {
      if (times.every((time) => now - time >= 60_000)) bucket.delete(key);
    }
  }
  return { allowed: true };
}

async function readJsonBody(request, maximumBytes = 65_536) {
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    const error = new Error("Content-Type must be application/json.");
    error.status = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must contain valid JSON.");
    error.status = 400;
    throw error;
  }
}

function publicAssetAllowed(requested) {
  if (publicRootFiles.has(requested)) return true;
  if (!requested.startsWith("src/") || requested.endsWith(".test.js")) return false;
  return [".js", ".css"].includes(extname(requested));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://localhost");
  if (url.pathname === "/api/health") {
    if (request.method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed." });
      return;
    }
    writeJson(response, 200, {
      status: "ready",
      verifier: "deterministic",
      data: "synthetic-only",
      evidenceStore: evidenceStore.kind,
      voice: voiceConfig.enabled ? "available-on-request" : "disabled",
    });
    return;
  }

  if (url.pathname === "/api/demo-access") {
    if (request.method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed." });
      return;
    }
    if (!sameOriginAllowed(request)) {
      writeJson(response, 403, { error: "Cross-site demo access requests are not allowed." });
      return;
    }
    const grant = voiceAccess.issueGrant();
    if (!grant.allowed) {
      writeJson(response, grant.status, { error: grant.error });
      return;
    }
    writeHead(response, 200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "set-cookie": grant.cookie,
    });
    response.end(JSON.stringify({
      accessToken: grant.accessToken,
      expiresInSeconds: grant.expiresInSeconds,
      maxVoiceSessionSeconds: voiceConfig.maxSessionDurationSeconds,
    }));
    return;
  }

  if (url.pathname === "/api/streaming-token") {
    if (request.method !== "GET") {
      writeHead(response, 405, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Method not allowed." }));
      return;
    }

    if (!sameOriginAllowed(request)) {
      writeJson(response, 403, { error: "Cross-site voice token requests are not allowed." });
      return;
    }
    const permission = voiceAccess.authorizeTokenRequest({
      cookieHeader: request.headers.cookie,
      accessHeader: request.headers["x-speciloop-demo-access"],
    });
    if (!permission.allowed) {
      writeJson(response, permission.status, { error: permission.error });
      return;
    }

    const apiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!apiKey) {
      writeHead(response, 503, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ error: "AssemblyAI is not configured on the server." }));
      return;
    }

    try {
      const tokenResponse = await requestAssemblyAiTemporaryToken({ apiKey, config: voiceConfig });
      writeHead(response, tokenResponse.status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(tokenResponse.body);
    } catch {
      writeHead(response, 502, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ error: "Could not reach AssemblyAI." }));
    }
    return;
  }

  if (url.pathname === "/api/evidence-records") {
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "Method not allowed." });
      return;
    }
    if (!sameOriginAllowed(request)) {
      writeJson(response, 403, { error: "Cross-site evidence submissions are not allowed." });
      return;
    }
    const permission = applyRateLimit(
      request,
      evidenceRequests,
      20,
      "Too many evidence submissions. Wait one minute.",
    );
    if (!permission.allowed) {
      writeJson(response, permission.status, { error: permission.error });
      return;
    }
    try {
      const payload = await readJsonBody(request);
      const record = createEvidenceRecord(payload);
      const saved = await evidenceStore.save(record);
      writeJson(response, saved.created ? 201 : 200, { record: saved.record });
    } catch (error) {
      if (error instanceof EvidenceValidationError) {
        writeJson(response, 422, { error: error.message });
      } else {
        console.error("Evidence save failed:", error instanceof Error ? error.message : "Unknown error");
        writeJson(response, error.status || 500, {
          error: error.status ? error.message : "Could not store the evidence record.",
        });
      }
    }
    return;
  }

  if (url.pathname.startsWith("/api/evidence-records/")) {
    if (request.method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed." });
      return;
    }
    const recordId = url.pathname.slice("/api/evidence-records/".length);
    if (!/^SL-[A-F0-9]{16}$/.test(recordId)) {
      writeJson(response, 400, { error: "Invalid evidence receipt ID." });
      return;
    }
    try {
      const record = await evidenceStore.find(recordId);
      if (!record) {
        writeJson(response, 404, { error: "Evidence receipt not found." });
        return;
      }
      writeJson(response, 200, { record });
    } catch (error) {
      console.error("Evidence read failed:", error instanceof Error ? error.message : "Unknown error");
      writeJson(response, 500, { error: "Could not read the evidence record." });
    }
    return;
  }

  let requested;
  try {
    requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  } catch {
    writeHead(response, 400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Invalid path");
    return;
  }
  if (request.method !== "GET") {
    writeHead(response, 405, { "content-type": "text/plain; charset=utf-8" });
    response.end("Method not allowed");
    return;
  }
  if (!publicAssetAllowed(requested)) {
    writeHead(response, 404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const filePath = resolve(root, requested);
  if (!filePath.startsWith(`${resolve(root)}${sep}`) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    writeHead(response, 404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  writeHead(response, 200, {
    "content-type": contentTypes[extname(filePath)] || "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(filePath).pipe(response);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`SpeciLoop ready at http://localhost:${port}`);
});
