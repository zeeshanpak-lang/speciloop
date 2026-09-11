class SpeciLoopPCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSamples = 1600;
    this.pcm = new Int16Array(this.frameSamples);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    for (let index = 0; index < channel.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, channel[index]));
      this.pcm[this.offset] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this.offset += 1;

      if (this.offset === this.frameSamples) {
        const completeFrame = this.pcm;
        this.port.postMessage(completeFrame.buffer, [completeFrame.buffer]);
        this.pcm = new Int16Array(this.frameSamples);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("speciloop-pcm", SpeciLoopPCMProcessor);
