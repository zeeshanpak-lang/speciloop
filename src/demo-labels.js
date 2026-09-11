const errorMessage = document.querySelector("#render-error");

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = false;
}

if (typeof globalThis.QRCode !== "function") {
  showError("The QR renderer could not load. Confirm that you are online, then refresh this page.");
} else {
  try {
    const settings = {
      width: 240,
      height: 240,
      colorDark: "#07110f",
      colorLight: "#ffffff",
      correctLevel: globalThis.QRCode.CorrectLevel.H,
    };
    new globalThis.QRCode(document.querySelector("#wrong-qr"), {
      ...settings,
      text: "SL-OR318-02",
    });
    new globalThis.QRCode(document.querySelector("#correct-qr"), {
      ...settings,
      text: "SL-OR204-01",
    });
  } catch {
    showError("The synthetic QR labels could not be rendered. Refresh the page or use manual label entry.");
  }
}

document.querySelector("#print-labels")?.addEventListener("click", () => window.print());
