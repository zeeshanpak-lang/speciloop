# Third-party notices

SpeciLoop loads two pinned browser libraries from jsDelivr for the synthetic QR demonstration:

- `jsQR` 1.4.0 for cross-browser QR decoding — Apache License 2.0.
- `qrcodejs` 1.0.0 for rendering the printable synthetic demo labels — MIT License.

The camera workflow first uses the browser's native `BarcodeDetector` when QR support is available. If the external decoder cannot load, the product keeps the deterministic manual-label fallback available.
