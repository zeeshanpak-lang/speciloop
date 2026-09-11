import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const VOICE_GRANT_COOKIE = "speciloop_demo_grant";

function integerSetting(env, name, fallback, minimum, maximum) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function booleanSetting(value, fallback) {
  if (value === undefined || value === "") return fallback;
  if (/^(?:1|true|yes|on)$/i.test(value)) return true;
  if (/^(?:0|false|no|off)$/i.test(value)) return false;
  throw new Error("VOICE_DEMO_ENABLED must be true or false.");
}

export function readVoiceConfig(env = process.env) {
  return Object.freeze({
    enabled: booleanSetting(env.VOICE_DEMO_ENABLED, false),
    tokenExpiresInSeconds: integerSetting(env, "VOICE_TOKEN_EXPIRY_SECONDS", 60, 1, 600),
    maxSessionDurationSeconds: integerSetting(env, "VOICE_MAX_SESSION_SECONDS", 120, 60, 10800),
    tokenLimitPerGrant: integerSetting(env, "VOICE_TOKEN_LIMIT_PER_GRANT", 4, 1, 100),
    tokenLimitPerMinute: integerSetting(env, "VOICE_TOKEN_LIMIT_PER_MINUTE", 20, 1, 1000),
    grantLimitPerMinute: integerSetting(env, "VOICE_GRANT_LIMIT_PER_MINUTE", 30, 1, 1000),
    grantTtlSeconds: integerSetting(env, "VOICE_GRANT_TTL_SECONDS", 600, 60, 3600),
    secureCookie: Boolean(env.K_SERVICE) || env.NODE_ENV === "production",
  });
}

function hash(value) {
  return createHash("sha256").update(value).digest();
}

function sameHash(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right) || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function cookieValue(cookieHeader, name) {
  for (const part of String(cookieHeader || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return "";
}

function recent(times, now) {
  return times.filter((time) => now - time < 60_000);
}

export function createVoiceAccessController({
  config = readVoiceConfig(),
  now = () => Date.now(),
  randomBytesImplementation = randomBytes,
} = {}) {
  const grants = new Map();
  let grantTimes = [];
  let tokenTimes = [];

  function prune(currentTime) {
    grantTimes = recent(grantTimes, currentTime);
    tokenTimes = recent(tokenTimes, currentTime);
    for (const [grantId, grant] of grants) {
      if (grant.expiresAt <= currentTime) grants.delete(grantId);
    }
  }

  function issueGrant() {
    if (!config.enabled) return { allowed: false, status: 503, error: "Voice is disabled for this demo." };
    const currentTime = now();
    prune(currentTime);
    if (grantTimes.length >= config.grantLimitPerMinute) {
      return { allowed: false, status: 429, error: "Public demo voice access is temporarily at capacity." };
    }
    grantTimes.push(currentTime);
    const grantId = randomBytesImplementation(18).toString("base64url");
    const accessToken = randomBytesImplementation(32).toString("base64url");
    grants.set(grantId, {
      accessHash: hash(accessToken),
      expiresAt: currentTime + config.grantTtlSeconds * 1000,
      tokenCount: 0,
    });
    const cookie = [
      `${VOICE_GRANT_COOKIE}=${grantId}`,
      "HttpOnly",
      "SameSite=Strict",
      "Path=/",
      `Max-Age=${config.grantTtlSeconds}`,
      ...(config.secureCookie ? ["Secure"] : []),
    ].join("; ");
    return {
      allowed: true,
      status: 200,
      accessToken,
      expiresInSeconds: config.grantTtlSeconds,
      cookie,
    };
  }

  function authorizeTokenRequest({ cookieHeader, accessHeader }) {
    if (!config.enabled) return { allowed: false, status: 503, error: "Voice is disabled for this demo." };
    const currentTime = now();
    prune(currentTime);
    const grantId = cookieValue(cookieHeader, VOICE_GRANT_COOKIE);
    const grant = grants.get(grantId);
    if (!grant || typeof accessHeader !== "string" || !accessHeader) {
      return { allowed: false, status: 401, error: "A valid public demo voice grant is required." };
    }
    if (!sameHash(grant.accessHash, hash(accessHeader))) {
      return { allowed: false, status: 401, error: "A valid public demo voice grant is required." };
    }
    if (grant.tokenCount >= config.tokenLimitPerGrant) {
      return { allowed: false, status: 429, error: "This demo voice grant has reached its token limit." };
    }
    if (tokenTimes.length >= config.tokenLimitPerMinute) {
      return { allowed: false, status: 429, error: "Voice token issuance is temporarily at capacity." };
    }
    grant.tokenCount += 1;
    tokenTimes.push(currentTime);
    return { allowed: true, status: 200 };
  }

  return { issueGrant, authorizeTokenRequest };
}

export function assemblyAiTokenUrl(config) {
  const url = new URL("https://streaming.assemblyai.com/v3/token");
  url.searchParams.set("expires_in_seconds", String(config.tokenExpiresInSeconds));
  url.searchParams.set("max_session_duration_seconds", String(config.maxSessionDurationSeconds));
  return url;
}

export async function requestAssemblyAiTemporaryToken({
  apiKey,
  config,
  fetchImplementation = fetch,
  signal = AbortSignal.timeout(8000),
}) {
  const response = await fetchImplementation(assemblyAiTokenUrl(config), {
    headers: { Authorization: apiKey },
    signal,
  });
  return { status: response.status, body: await response.text() };
}
