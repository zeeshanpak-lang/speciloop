import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VoiceCapture } from "./voice.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Mock condition was not reached.");
}

class MockSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = MockSocket.CONNECTING;
    this.sent = [];
    MockSocket.instances.push(this);
  }

  open() {
    this.readyState = MockSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  send(value) {
    this.sent.push(value);
  }

  close() {
    if (this.readyState === MockSocket.CLOSED) return;
    this.readyState = MockSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  message(value) {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: JSON.stringify(value) });
    this.dispatchEvent(event);
  }
}

class MockNode {
  constructor() {
    this.disconnected = 0;
  }
  connect(node) { return node; }
  disconnect() { this.disconnected += 1; }
}

class MockWorkletNode extends MockNode {
  constructor() {
    super();
    this.port = { onmessage: null };
  }
}

class MockAudioContext {
  static instances = [];
  static addModule = async () => {};

  constructor({ sampleRate }) {
    this.sampleRate = sampleRate;
    this.state = "running";
    this.closeCalls = 0;
    this.destination = new MockNode();
    this.audioWorklet = { addModule: (...args) => MockAudioContext.addModule(...args) };
    MockAudioContext.instances.push(this);
  }
  createMediaStreamSource() { return new MockNode(); }
  createGain() {
    const node = new MockNode();
    node.gain = { value: 1 };
    return node;
  }
  async resume() { this.state = "running"; }
  async close() { this.closeCalls += 1; this.state = "closed"; }
}

function streamFixture() {
  const track = { stopCalls: 0, stop() { this.stopCalls += 1; } };
  return { stream: { getTracks: () => [track] }, track };
}

function captureFixture({
  getUserMedia,
  onError = () => {},
  onPartial = () => {},
  onFinal = () => {},
  accessGrant = async () => "mock-access",
}) {
  MockSocket.instances = [];
  MockAudioContext.instances = [];
  MockAudioContext.addModule = async () => {};
  const statuses = [];
  const capture = new VoiceCapture({
    onStatus: (status) => statuses.push(status),
    onPartial,
    onFinal,
    onError,
    fetchImplementation: async () => new Response(JSON.stringify({ token: "mock-token" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    WebSocketClass: MockSocket,
    AudioContextClass: MockAudioContext,
    AudioWorkletNodeClass: MockWorkletNode,
    mediaDevices: { getUserMedia },
    accessGrant,
  });
  return { capture, statuses };
}

describe("voice capture lifecycle", () => {
  it("binds receiver-sensitive browser functions to the global context", async () => {
    MockSocket.instances = [];
    MockAudioContext.instances = [];
    MockAudioContext.addModule = async () => {};
    const calls = [];
    const { stream, track } = streamFixture();
    const receiverSensitiveFetch = function (url) {
      assert.equal(this, globalThis);
      calls.push(url);
      const body = url === "/api/demo-access"
        ? { accessToken: "browser-access", expiresInSeconds: 60 }
        : { token: "browser-token" };
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    };
    const receiverSensitiveSetTimer = function (callback, delay) {
      assert.equal(this, globalThis);
      return setTimeout(callback, delay);
    };
    const receiverSensitiveClearTimer = function (timer) {
      assert.equal(this, globalThis);
      clearTimeout(timer);
    };
    const capture = new VoiceCapture({
      onStatus: () => {},
      onPartial: () => {},
      onFinal: () => {},
      onError: () => {},
      fetchImplementation: receiverSensitiveFetch,
      WebSocketClass: MockSocket,
      AudioContextClass: MockAudioContext,
      AudioWorkletNodeClass: MockWorkletNode,
      mediaDevices: { getUserMedia: async () => stream },
      setTimer: receiverSensitiveSetTimer,
      clearTimer: receiverSensitiveClearTimer,
    });

    const starting = capture.start();
    await until(() => MockSocket.instances.length === 1);
    MockSocket.instances[0].open();
    await starting;
    await capture.stop();

    assert.deepEqual(calls, ["/api/demo-access", "/api/streaming-token"]);
    assert.equal(track.stopCalls, 1);
  });

  it("aborts a pending access request during cancellation", async () => {
    let observedSignal;
    const { capture } = captureFixture({
      getUserMedia: async () => { throw new Error("must not run"); },
      accessGrant: async (_fetch, signal) => new Promise((_resolve, reject) => {
        observedSignal = signal;
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
    });
    const starting = capture.start();
    await until(() => observedSignal);
    await capture.stop();
    await assert.rejects(starting, /cancelled/i);
    assert.equal(observedSignal.aborted, true);
    assert.equal(MockSocket.instances.length, 0);
  });

  it("cancels cleanly while the streaming socket is still connecting", async () => {
    let mediaRequested = false;
    const { capture } = captureFixture({
      getUserMedia: async () => { mediaRequested = true; return streamFixture().stream; },
    });
    const starting = capture.start();
    await until(() => MockSocket.instances.length === 1);
    const socket = MockSocket.instances[0];
    await capture.stop();
    await assert.rejects(starting, /cancelled/i);
    assert.equal(socket.readyState, MockSocket.CLOSED);
    assert.equal(mediaRequested, false);
  });

  it("stops microphone tracks delivered after cancellation", async () => {
    const permission = deferred();
    const { stream, track } = streamFixture();
    const { capture } = captureFixture({ getUserMedia: () => permission.promise });
    const starting = capture.start();
    await until(() => MockSocket.instances.length === 1);
    MockSocket.instances[0].open();
    await until(() => capture.socket?.readyState === MockSocket.OPEN);
    await capture.stop();
    permission.resolve(stream);
    await assert.rejects(starting, /cancelled/i);
    assert.equal(track.stopCalls, 1);
    assert.equal(capture.stream, null);
    assert.equal(capture.socket, null);
  });

  it("cleans resources when cancelled while the audio worklet is loading", async () => {
    const moduleLoad = deferred();
    MockAudioContext.addModule = () => moduleLoad.promise;
    const { stream, track } = streamFixture();
    const { capture } = captureFixture({ getUserMedia: async () => stream });
    MockAudioContext.addModule = () => moduleLoad.promise;
    const starting = capture.start();
    await until(() => MockSocket.instances.length === 1);
    MockSocket.instances[0].open();
    await until(() => MockAudioContext.instances.length === 1);
    await capture.stop();
    moduleLoad.resolve();
    await assert.rejects(starting, /cancelled/i);
    assert.equal(track.stopCalls, 1);
    assert.equal(MockAudioContext.instances[0].state, "closed");
  });

  it("cleans up and reports an unexpected socket closure once", async () => {
    const { stream, track } = streamFixture();
    const errors = [];
    const { capture, statuses } = captureFixture({
      getUserMedia: async () => stream,
      onError: (error) => errors.push(error.message),
    });
    const starting = capture.start();
    await until(() => MockSocket.instances.length === 1);
    const socket = MockSocket.instances[0];
    socket.open();
    await starting;
    socket.close();
    await until(() => track.stopCalls === 1);
    assert.deepEqual(errors, ["The voice connection closed unexpectedly."]);
    assert.equal(MockAudioContext.instances[0].state, "closed");
    assert.equal(statuses.at(-1), "OFFLINE");
  });

  it("ignores stale socket callbacks and makes repeated cleanup safe", async () => {
    const { stream, track } = streamFixture();
    const partials = [];
    const finals = [];
    const { capture } = captureFixture({
      getUserMedia: async () => stream,
      onPartial: (value) => partials.push(value),
      onFinal: (value) => finals.push(value),
    });
    const starting = capture.start();
    await until(() => MockSocket.instances.length === 1);
    const socket = MockSocket.instances[0];
    socket.open();
    await starting;
    await capture.stop();
    await capture.stop();
    capture.handleMessage({ data: JSON.stringify({ type: "Turn", transcript: "stale", end_of_turn: true }) }, socket);
    assert.deepEqual(partials, []);
    assert.deepEqual(finals, []);
    assert.equal(track.stopCalls, 1);
    assert.equal(MockAudioContext.instances[0].closeCalls, 1);
  });
});
