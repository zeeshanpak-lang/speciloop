import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { primaryDemoCase, syntheticCases } from '../src/domain/cases.js';
import { INPUT_MODES, inputModeLabel } from '../src/domain/evidence-contract.js';
import { verifyStatement } from '../src/domain/verifier.js';

// Exercise actual template functions without a browser or provider credentials.
// These are markup unit tests, not rendered browser or hardware tests.
const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
function call(name, state = {}) {
  const names = ['escapeHtml', 'comparisonMarkup', 'sampleButtons', 'captureMarkup', 'completeMarkup', 'evidenceMarkup', 'eventModeMarkup', 'formatTime'];
  const functions = names.map((fn) => {
    const start = source.indexOf(`function ${fn}(`);
    const next = source.indexOf('\nfunction ', start + 1);
    return source.slice(start, next < 0 ? undefined : next);
  }).join('\n');
  const context = {
    session: { phase: 'AWAIT_CALLOUT', order: primaryDemoCase, audit: [] },
    notice: null, receipt: null, coordinator: { captureActive: false },
    voiceState: 'OFFLINE', scannerState: 'CAMERA OFF', voiceBinding: null,
    scannerBinding: null, liveTranscript: '', pendingInputMode: INPUT_MODES.MANUAL_TEXT,
    INPUT_MODES, inputModeLabel, primaryDemoCase, syntheticCases,
    correctStatement: 'Left thyroid lobe, permanent pathology, one container.',
    wrongStatement: 'Right thyroid lobe, permanent pathology, one container.',
    ...state,
  };
  return runInNewContext(`${functions}\n${name}()`, context);
}

test('capture presents instrument and transcript in separate layout regions', () => {
  const html = call('captureMarkup');
  assert.match(html, /class="capture-layout"/);
  assert.match(html, /class="capture-instrument\s*"/);
  assert.match(html, /<button[^>]*id="mic-button"[^>]*aria-label="Start live transcription"[^>]*aria-pressed="false"/);
  assert.match(html, /class="capture-editor"/);
  assert.match(html, /id="voice-button"/);
  assert.match(html, /id="evidence-input"/);
});
test('active capture preserves readonly input and blocked verification', () => {
  const html = call('captureMarkup', { coordinator: { captureActive: true }, voiceBinding: {} });
  assert.match(html, /textarea[^>]*readonly/);
  assert.match(html, /id="verify-button" disabled/);
  assert.match(html, /Cancel voice capture/);
  assert.match(html, /<button[^>]*id="mic-button"[^>]*aria-label="Cancel voice capture"[^>]*aria-pressed="true"/);
});
test('label step retains camera, manual input, and printable QR controls', () => {
  const html = call('captureMarkup', { session: { phase: 'AWAIT_LABEL', order: primaryDemoCase } });
  assert.match(html, /id="scanner-button"/);
  assert.match(html, /id="label-video"/);
  assert.match(html, /<input id="evidence-input"/);
  assert.match(html, /demo-labels.html/);
  assert.doesNotMatch(html, /id="voice-button"/);
});
test('mismatch compares all four fields from actual verifier output', () => {
  const notice = verifyStatement(primaryDemoCase, 'Right thyroid lobe, permanent pathology, one container.');
  const html = call('comparisonMarkup', { notice });
  assert.match(html, /comparison-mismatch/);
  assert.match(html, /<td>left<\/td><td>right/);
  assert.match(html, /Disposition/);
  assert.match(html, /Containers/);
  assert.match(html, /not acceptance/);
});
test('comparison escapes untrusted values and reports unresolved fields', () => {
  const html = call('comparisonMarkup', { notice: { status: 'RETRY', parsed: { anatomicalStructure: '<img src=x>' } } });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /Not resolved/);
});
test('receipt keeps limitations and hash available under technical disclosure', () => {
  const html = call('completeMarkup', { session: { phase: 'COMPLETE' }, receipt: { recordId: 'TEST-RECEIPT', recordedAt: '2026-09-18', evidenceHash: 'test-hash' } });
  assert.match(html, /Submitted fields are consistent/);
  assert.match(html, /<details class="technical-details">/);
  assert.match(html, /test-hash/);
  assert.match(html, /does not prove speech or a physical scan occurred/);
});
test('evidence is an initially closed named native dialog with a close control', () => {
  const html = call('evidenceMarkup');
  assert.match(html, /<dialog id="evidence-dialog" class="evidence-panel" aria-label="Session evidence">/);
  assert.match(html, /id="close-evidence"/);
});
