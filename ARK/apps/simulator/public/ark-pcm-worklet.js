// Audio rendering thread: downmixed PCM16 at the AudioContext's 16 kHz rate.
// No simulation state, network, or command handling runs here.
class ArkPCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.samples = new Int16Array(2048)
    this.offset = 0
    this.energy = 0
  }
  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel) return true
    for (const raw of channel) {
      const sample = Math.max(-1, Math.min(1, raw))
      this.samples[this.offset++] = Math.round(sample * (sample < 0 ? 32768 : 32767))
      this.energy += sample * sample
      if (this.offset === this.samples.length) {
        this.port.postMessage({ pcm: this.samples.buffer, level: Math.sqrt(this.energy / this.offset) }, [this.samples.buffer])
        this.samples = new Int16Array(2048)
        this.offset = 0
        this.energy = 0
      }
    }
    // Outputs remain silent; connecting to destination keeps processing active.
    return true
  }
}
registerProcessor('ark-pcm', ArkPCMProcessor)
