// Procedural suit audio (no sound files): thin Mars wind outside, suit fan hum, breathing that speeds up
// with exertion, and muffled footfalls transmitted through the suit. Starts on the first user gesture.

export class SuitAudio {
  private ctx: AudioContext | null = null;
  private wind!: GainNode;
  private breath!: GainNode;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private breathT = 0;
  muted = false;

  start() {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.6;
    this.master.connect(ctx.destination);
    // brown noise buffer
    const len = ctx.sampleRate * 4;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }

    const src = (filterHz: number, q: number, gain: number) => {
      const s = ctx.createBufferSource();
      s.buffer = this.noise; s.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = "lowpass"; f.frequency.value = filterHz; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = gain;
      s.connect(f).connect(g).connect(this.master);
      s.start();
      return { g, f };
    };
    this.wind = src(380, 0.7, 0.18).g;      // Mars air is thin: quiet, low wind
    src(1400, 4, 0.025);                    // suit ventilation fan
    const hum = ctx.createOscillator();
    hum.frequency.value = 118; hum.type = "sine";
    const hg = ctx.createGain(); hg.gain.value = 0.012;
    hum.connect(hg).connect(this.master); hum.start();
    this.breath = src(900, 1.2, 0).g;
  }

  /** exertion 0..1 drives breathing rate and depth. */
  update(dt: number, exertion: number, windStrength: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.6, t, 0.1);
    this.wind.gain.setTargetAtTime(0.08 + windStrength * 0.25, t, 0.5);
    const rate = 0.25 + exertion * 0.35; // breaths per second
    this.breathT += dt * rate;
    const ph = this.breathT % 1;
    const env = ph < 0.4 ? Math.sin((ph / 0.4) * Math.PI) : ph < 0.5 ? 0 : Math.sin(((ph - 0.5) / 0.5) * Math.PI) * 0.7;
    this.breath.gain.setTargetAtTime(env * (0.03 + exertion * 0.05), t, 0.05);
  }

  step() {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass"; f.frequency.value = 160;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    s.connect(f).connect(g).connect(this.master);
    s.start(t, Math.random() * 3, 0.3);
  }

  beep(freq = 880, dur = 0.12) {
    if (!this.ctx || this.muted) return;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const t = this.ctx.currentTime;
    o.frequency.value = freq; o.type = "triangle";
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  }
}
