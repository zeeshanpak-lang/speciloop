import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assemblyAiTokenUrl,
  createVoiceAccessController,
  readVoiceConfig,
  requestAssemblyAiTemporaryToken,
  VOICE_GRANT_COOKIE,
} from "./voice-access.mjs";

function deterministicBytes(size) {
  return Buffer.alloc(size, size);
}

describe("bounded public demo voice access", () => {
  it("issues a cookie-bound grant without embedding a reusable browser secret", () => {
    const config = readVoiceConfig({ VOICE_DEMO_ENABLED: "true", VOICE_GRANT_TTL_SECONDS: "120" });
    const access = createVoiceAccessController({ config, now: () => 1000, randomBytesImplementation: deterministicBytes });
    const grant = access.issueGrant();
    assert.equal(grant.allowed, true);
    assert.match(grant.cookie, new RegExp(`^${VOICE_GRANT_COOKIE}=`));
    assert.match(grant.cookie, /HttpOnly/);
    assert.doesNotMatch(grant.cookie, new RegExp(grant.accessToken));
    assert.equal(access.authorizeTokenRequest({
      cookieHeader: grant.cookie.split(";")[0],
      accessHeader: grant.accessToken,
    }).allowed, true);
  });

  it("rejects missing cookies, incorrect access tokens, and exhausted grants", () => {
    const config = readVoiceConfig({ VOICE_DEMO_ENABLED: "true", VOICE_TOKEN_LIMIT_PER_GRANT: "1" });
    const access = createVoiceAccessController({ config, randomBytesImplementation: deterministicBytes });
    const grant = access.issueGrant();
    const cookieHeader = grant.cookie.split(";")[0];
    assert.equal(access.authorizeTokenRequest({ accessHeader: grant.accessToken }).status, 401);
    assert.equal(access.authorizeTokenRequest({ cookieHeader, accessHeader: "wrong" }).status, 401);
    assert.equal(access.authorizeTokenRequest({ cookieHeader, accessHeader: grant.accessToken }).allowed, true);
    assert.equal(access.authorizeTokenRequest({ cookieHeader, accessHeader: grant.accessToken }).status, 429);
  });

  it("implements a server-controlled voice-disable switch", () => {
    const config = readVoiceConfig({ VOICE_DEMO_ENABLED: "false" });
    const access = createVoiceAccessController({ config });
    assert.equal(access.issueGrant().status, 503);
    assert.equal(access.authorizeTokenRequest({}).status, 503);
  });

  it("applies process-local global grant and token issuance limits", () => {
    const config = readVoiceConfig({
      VOICE_DEMO_ENABLED: "true",
      VOICE_GRANT_LIMIT_PER_MINUTE: "1",
      VOICE_TOKEN_LIMIT_PER_MINUTE: "1",
      VOICE_TOKEN_LIMIT_PER_GRANT: "4",
    });
    const access = createVoiceAccessController({ config, randomBytesImplementation: deterministicBytes });
    const grant = access.issueGrant();
    assert.equal(access.issueGrant().status, 429);
    const auth = { cookieHeader: grant.cookie.split(";")[0], accessHeader: grant.accessToken };
    assert.equal(access.authorizeTokenRequest(auth).allowed, true);
    assert.equal(access.authorizeTokenRequest(auth).status, 429);
  });

  it("sets official temporary-token duration parameters within documented bounds", () => {
    const config = readVoiceConfig({
      VOICE_DEMO_ENABLED: "true",
      VOICE_TOKEN_EXPIRY_SECONDS: "45",
      VOICE_MAX_SESSION_SECONDS: "180",
    });
    const url = assemblyAiTokenUrl(config);
    assert.equal(url.searchParams.get("expires_in_seconds"), "45");
    assert.equal(url.searchParams.get("max_session_duration_seconds"), "180");
    assert.throws(() => readVoiceConfig({ VOICE_TOKEN_EXPIRY_SECONDS: "601" }), /1 through 600/);
    assert.throws(() => readVoiceConfig({ VOICE_MAX_SESSION_SECONDS: "59" }), /60 through 10800/);
  });

  it("mints tokens through an injected provider request", async () => {
    let observed;
    const result = await requestAssemblyAiTemporaryToken({
      apiKey: "mock-provider-key",
      config: readVoiceConfig({ VOICE_DEMO_ENABLED: "true", VOICE_MAX_SESSION_SECONDS: "180" }),
      fetchImplementation: async (url, options) => {
        observed = { url: String(url), options };
        return new Response(JSON.stringify({ token: "mock-temporary-token" }), { status: 200 });
      },
      signal: new AbortController().signal,
    });
    assert.equal(result.status, 200);
    assert.match(observed.url, /max_session_duration_seconds=180/);
    assert.equal(observed.options.headers.Authorization, "mock-provider-key");
    assert.match(result.body, /mock-temporary-token/);
  });
});
