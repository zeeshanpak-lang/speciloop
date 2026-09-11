export class InteractionCoordinator {
  constructor() {
    this.revision = 0;
    this.nextId = 1;
    this.activeCapture = null;
    this.activeSubmission = null;
  }

  beginCapture(session) {
    if (this.activeCapture || this.activeSubmission) return null;
    this.revision += 1;
    const token = Object.freeze({
      type: "capture",
      id: this.nextId++,
      sessionId: session.id,
      phase: session.phase,
    });
    this.activeCapture = token;
    return token;
  }

  isCaptureCurrent(token, session) {
    return this.activeCapture === token
      && token?.sessionId === session.id
      && token?.phase === session.phase;
  }

  endCapture(token) {
    if (this.activeCapture !== token) return false;
    this.activeCapture = null;
    return true;
  }

  beginSubmission(session) {
    if (this.activeCapture || this.activeSubmission) return null;
    this.revision += 1;
    const token = Object.freeze({
      type: "submission",
      id: this.nextId++,
      sessionId: session.id,
      phase: session.phase,
    });
    this.activeSubmission = token;
    return token;
  }

  isSubmissionCurrent(token, session) {
    return this.activeSubmission === token
      && token?.sessionId === session.id
      && token?.phase === session.phase;
  }

  endSubmission(token, { changed = false } = {}) {
    if (this.activeSubmission !== token) return false;
    this.activeSubmission = null;
    if (changed) this.revision += 1;
    return true;
  }

  noteSessionChange() {
    this.revision += 1;
    this.activeCapture = null;
    this.activeSubmission = null;
  }

  noteActivity() {
    this.revision += 1;
  }

  snapshot(session) {
    return Object.freeze({
      revision: this.revision,
      sessionId: session.id,
      phase: session.phase,
    });
  }

  isSnapshotCurrent(snapshot, session) {
    return snapshot?.revision === this.revision
      && snapshot?.sessionId === session.id
      && snapshot?.phase === session.phase;
  }

  get captureActive() {
    return Boolean(this.activeCapture);
  }
}
