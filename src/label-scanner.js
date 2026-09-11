const JS_QR_URL = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js";

let jsQrPromise;

function loadJsQr() {
  if (typeof globalThis.jsQR === "function") return Promise.resolve(globalThis.jsQR);
  if (jsQrPromise) return jsQrPromise;

  jsQrPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = JS_QR_URL;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.referrerPolicy = "no-referrer";
    script.onload = () => {
      if (typeof globalThis.jsQR === "function") resolve(globalThis.jsQR);
      else reject(new Error("The QR decoder did not initialize."));
    };
    script.onerror = () => reject(new Error("The QR decoder could not be loaded. Use manual label entry."));
    document.head.append(script);
  });
  jsQrPromise.catch(() => {
    jsQrPromise = undefined;
  });

  return jsQrPromise;
}

async function makeDecoder() {
  if ("BarcodeDetector" in globalThis) {
    try {
      const formats = typeof BarcodeDetector.getSupportedFormats === "function"
        ? await BarcodeDetector.getSupportedFormats()
        : ["qr_code"];
      if (formats.includes("qr_code")) {
        const detector = new BarcodeDetector({ formats: ["qr_code"] });
        return async (video) => {
          const results = await detector.detect(video);
          return results[0]?.rawValue?.trim() || "";
        };
      }
    } catch {
      // Fall through to the cross-browser decoder.
    }
  }

  const jsQr = await loadJsQr();
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Camera frames cannot be processed in this browser.");

  return async (video) => {
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (!sourceWidth || !sourceHeight) return "";
    const scale = Math.min(1, 720 / sourceWidth);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.drawImage(video, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);
    const frame = context.getImageData(0, 0, width, height);
    return jsQr(frame.data, width, height, { inversionAttempts: "attemptBoth" })?.data?.trim() || "";
  };
}

export class LabelScanner {
  constructor({ onStatus, onCode, onError }) {
    this.onStatus = onStatus;
    this.onCode = onCode;
    this.onError = onError;
    this.stream = null;
    this.video = null;
    this.decoder = null;
    this.frameRequest = null;
    this.detecting = false;
    this.lastScanAt = 0;
    this.stopped = true;
  }

  async start(video) {
    if (!video) throw new Error("The camera preview is unavailable. Use manual label entry.");
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera access is unavailable. Use manual label entry.");
    }

    this.stopped = false;
    this.video = video;
    this.onStatus("STARTING CAMERA");
    this.decoder = await makeDecoder();
    if (this.stopped) throw new Error("Camera scan was cancelled.");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
    } catch (error) {
      if (error?.name === "NotAllowedError") {
        throw new Error("Camera permission was denied. Allow camera access or use manual label entry.");
      }
      if (error?.name === "NotFoundError") {
        throw new Error("No camera was found. Use manual label entry.");
      }
      throw new Error("The camera could not be started. Use manual label entry.");
    }
    if (this.stopped) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
      throw new Error("Camera scan was cancelled.");
    }
    video.srcObject = this.stream;
    await video.play();
    if (this.stopped) throw new Error("Camera scan was cancelled.");
    this.onStatus("SCANNING QR");
    this.frameRequest = requestAnimationFrame((time) => this.scan(time));
  }

  async scan(time) {
    if (this.stopped) return;
    if (!this.detecting && time - this.lastScanAt >= 150 && this.video?.readyState >= 2) {
      this.detecting = true;
      this.lastScanAt = time;
      try {
        const code = await this.decoder(this.video);
        if (code && !this.stopped) {
          this.onStatus("QR CAPTURED");
          await this.onCode(code);
          return;
        }
      } catch (error) {
        if (!this.stopped) {
          await this.onError(error instanceof Error ? error : new Error("The QR label could not be scanned."));
          return;
        }
      } finally {
        this.detecting = false;
      }
    }
    if (!this.stopped) this.frameRequest = requestAnimationFrame((nextTime) => this.scan(nextTime));
  }

  async stop() {
    this.stopped = true;
    if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
    this.frameRequest = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.decoder = null;
    if (this.video) this.video.srcObject = null;
    this.video = null;
  }
}
