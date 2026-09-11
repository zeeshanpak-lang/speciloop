const SAMPLE_RATE = 16000;
const CONNECTION_TIMEOUT_MS = 10000;
let cachedDemoAccess = null;

function cancelledError() {
  const error = new Error("Voice capture was cancelled.");
  error.name = "AbortError";
  return error;
}

async function bodyFrom(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function defaultAccessGrant(fetchImplementation, signal) {
  if (cachedDemoAccess && cachedDemoAccess.expiresAt > Date.now() + 5000) return cachedDemoAccess.token;
  const response = await fetchImplementation("/api/demo-access", {
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  const body = await bodyFrom(response);
  if (!response.ok || typeof body.accessToken !== "string" || !body.accessToken) {
    throw new Error(body.error || "Public demo voice access is unavailable.");
  }
  cachedDemoAccess = {
    token: body.accessToken,
    expiresAt: Date.now() + Math.max(0, Number(body.expiresInSeconds || 0)) * 1000,
  };
  return cachedDemoAccess.token;
}

export class VoiceCapture {
  constructor({
    onStatus,
    onPartial,
    onFinal,
    onError,
    fetchImplementation = globalThis.fetch,
    WebSocketClass = globalThis.WebSocket,
    AudioContextClass = globalThis.AudioContext,
    AudioWorkletNodeClass = globalThis.AudioWorkletNode,
    mediaDevices = globalThis.navigator?.mediaDevices,
    accessGrant = defaultAccessGrant,
    setTimer = globalThis.setTimeout,
    clearTimer = globalThis.clearTimeout,
  }) {
    this.onStatus = onStatus;
    this.onPartial = onPartial;
    this.onFinal = onFinal;
    this.onError = onError;
    // Chromium's native Window.fetch rejects calls made with a class instance
    // as its receiver. Keep the injected function testable while preserving the
    // browser global as the receiver for both access-grant and token requests.
    this.fetchImplementation = fetchImplementation.bind(globalThis);
    this.WebSocketClass = WebSocketClass;
    this.AudioContextClass = AudioContextClass;
    this.AudioWorkletNodeClass = AudioWorkletNodeClass;
    this.mediaDevices = mediaDevices;
    this.accessGrant = accessGrant;
    this.setTimer = setTimer.bind(globalThis);
    this.clearTimer = clearTimer.bind(globalThis);
    this.socket = null;
    this.audioContext = null;
    this.worklet = null;
    this.source = null;
    this.silentGain = null;
    this.stream = null;
    this.tokenAbortController = null;
    this.stopping = false;
    this.started = false;
    this.finalDelivered = false;
    this.failed = false;
    this.cleanupQueue = Promise.resolve();
  }

  isActive() {
    return !this.stopping && !this.failed;
  }

  assertActive() {
    if (!this.isActive()) throw cancelledError();
  }

  async start() {
    if (this.started) throw new Error("Voice capture has already started.");
    this.started = true;
    this.onStatus("CONNECTING");
    this.tokenAbortController = new AbortController();
    try {
      const accessToken = await this.accessGrant(
        this.fetchImplementation,
        this.tokenAbortController.signal,
      );
      this.assertActive();
      const tokenResponse = await this.fetchImplementation("/api/streaming-token", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { "x-speciloop-demo-access": accessToken },
        signal: this.tokenAbortController.signal,
      });
      const tokenBody = await bodyFrom(tokenResponse);
      if (!tokenResponse.ok || !tokenBody.token) {
        if (tokenResponse.status === 401) cachedDemoAccess = null;
        throw new Error(tokenBody.error || "Could not obtain a temporary AssemblyAI token.");
      }
      this.assertActive();

      const params = new URLSearchParams({
        token: tokenBody.token,
        sample_rate: String(SAMPLE_RATE),
        speech_model: "universal-3-5-pro",
        domain: "medical-v1",
        voice_focus: "near-field",
        min_turn_silence: "300",
        max_turn_silence: "2500",
        keyterms_prompt: JSON.stringify([
          "thyroid lobe", "permanent pathology", "container", "left", "right",
        ]),
      });
      if (typeof this.WebSocketClass !== "function") {
        throw new Error("Streaming WebSocket support is unavailable in this browser.");
      }
      const socket = new this.WebSocketClass(`wss://streaming.assemblyai.com/v3/ws?${params}`);
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      await this.waitForSocketOpen(socket);
      this.assertActive();
      socket.addEventListener("message", (event) => this.handleMessage(event, socket));
      socket.addEventListener("error", () => this.handleUnexpectedFailure(
        new Error("AssemblyAI voice connection failed."),
        socket,
      ));
      socket.addEventListener("close", () => {
        if (this.isActive() && this.socket === socket) {
          this.handleUnexpectedFailure(new Error("The voice connection closed unexpectedly."), socket);
        }
      });

      if (!this.mediaDevices?.getUserMedia) throw new Error("Microphone capture is unavailable in this browser.");
      let stream;
      try {
        stream = await this.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });
      } catch (error) {
        if (!this.isActive()) throw cancelledError();
        if (error?.name === "NotAllowedError") {
          throw new Error("Microphone permission was denied. Allow microphone access or use typed input.");
        }
        if (error?.name === "NotFoundError") throw new Error("No microphone was found. Use typed input.");
        throw new Error("The microphone could not be started. Use typed input.");
      }
      if (!this.isActive()) {
        stream.getTracks().forEach((track) => track.stop());
        throw cancelledError();
      }
      this.stream = stream;

      const audioContext = new this.AudioContextClass({ sampleRate: SAMPLE_RATE });
      this.audioContext = audioContext;
      if (audioContext.sampleRate !== SAMPLE_RATE) {
        throw new Error(`Browser audio rate ${audioContext.sampleRate} Hz is unsupported.`);
      }
      if (audioContext.state === "suspended") await audioContext.resume();
      this.assertActive();
      await audioContext.audioWorklet.addModule("/src/pcm-processor.js");
      this.assertActive();
      const source = audioContext.createMediaStreamSource(stream);
      const worklet = new this.AudioWorkletNodeClass(audioContext, "speciloop-pcm");
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      this.source = source;
      this.worklet = worklet;
      this.silentGain = silentGain;
      source.connect(worklet);
      worklet.connect(silentGain).connect(audioContext.destination);
      worklet.port.onmessage = (event) => {
        const openState = this.WebSocketClass?.OPEN ?? 1;
        if (this.isActive() && this.socket === socket && socket.readyState === openState) {
          socket.send(event.data);
        }
      };
      this.onStatus("LIVE");
    } catch (error) {
      await this.cleanup();
      if (this.stopping || error?.name === "AbortError") throw cancelledError();
      throw error;
    } finally {
      this.tokenAbortController = null;
    }
  }

  waitForSocketOpen(socket) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        this.clearTimer(timer);
        callback(value);
      };
      const timer = this.setTimer(
        () => finish(reject, new Error("Voice connection timed out.")),
        CONNECTION_TIMEOUT_MS,
      );
      socket.addEventListener("open", () => finish(resolve), { once: true });
      socket.addEventListener(
        "error",
        () => finish(reject, new Error("AssemblyAI voice connection failed.")),
        { once: true },
      );
      socket.addEventListener(
        "close",
        () => finish(reject, this.stopping ? cancelledError() : new Error("The voice connection closed before capture began.")),
        { once: true },
      );
    });
  }

  handleMessage(event, socket = this.socket) {
    if (!this.isActive() || this.socket !== socket) return;
    try {
      const message = JSON.parse(event.data);
      if (message.type === "Begin") this.onStatus("LIVE");
      if (message.type === "SpeechStarted") this.onStatus("LISTENING");
      if (message.type === "Turn") {
        if (this.finalDelivered) return;
        const transcript = String(message.transcript || "").trim();
        if (!transcript) return;
        if (message.end_of_turn) {
          this.finalDelivered = true;
          if (this.worklet) this.worklet.port.onmessage = null;
          this.onStatus("REVIEW");
          this.onFinal(transcript);
          void this.stop();
        } else {
          this.onPartial(transcript);
        }
      }
      if (message.type === "Termination") void this.stop();
      if (message.type === "Error") throw new Error(message.error || "AssemblyAI returned an error.");
    } catch (error) {
      this.handleUnexpectedFailure(error instanceof Error ? error : new Error("Invalid voice event."), socket);
    }
  }

  handleUnexpectedFailure(error, socket = this.socket) {
    if (!this.isActive() || this.socket !== socket) return;
    this.failed = true;
    this.onError(error);
    void this.cleanup();
  }

  async stop() {
    this.stopping = true;
    this.tokenAbortController?.abort();
    await this.cleanup();
  }

  cleanup() {
    this.cleanupQueue = this.cleanupQueue.catch(() => {}).then(async () => {
      const socket = this.socket;
      this.socket = null;
      const worklet = this.worklet;
      this.worklet = null;
      const source = this.source;
      this.source = null;
      const silentGain = this.silentGain;
      this.silentGain = null;
      const stream = this.stream;
      this.stream = null;
      const audioContext = this.audioContext;
      this.audioContext = null;

      if (worklet) worklet.port.onmessage = null;
      try { worklet?.disconnect(); } catch {}
      try { source?.disconnect(); } catch {}
      try { silentGain?.disconnect(); } catch {}
      stream?.getTracks().forEach((track) => {
        try { track.stop(); } catch {}
      });
      if (audioContext && audioContext.state !== "closed") {
        try { await audioContext.close(); } catch {}
      }
      const openState = this.WebSocketClass?.OPEN ?? 1;
      const closedState = this.WebSocketClass?.CLOSED ?? 3;
      if (socket?.readyState === openState) {
        try { socket.send(JSON.stringify({ type: "Terminate" })); } catch {}
      }
      if (socket && socket.readyState !== closedState) {
        try { socket.close(); } catch {}
      }
      this.onStatus("OFFLINE");
    });
    return this.cleanupQueue;
  }
}
