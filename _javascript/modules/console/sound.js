/**
 * Console sound: a start-up sting played once, then a seamless ambient loop
 * (the loop file already has the start-up cut out and a crossfaded seam).
 * Uses the Web Audio API so the loop is gapless; browsers only allow audio after
 * a user gesture, so everything starts from `unlock()` called inside a click/key.
 */

const STORAGE_KEY = 'anco-console-sound';
const FADE = 0.4; // seconds the start-up fades into the loop
const START_GAIN = 0.7;
const LOOP_GAIN = 0.35;

export class ConsoleSound {
  constructor({ startUrl, loopUrl }) {
    this.startUrl = startUrl;
    this.loopUrl = loopUrl;
    this.ctx = null;
    this.master = null;
    this.buffers = null;
    this.sources = [];
    this.playing = false;
    this.lastTick = 0;
    this.tickBuffer = null;

    let stored = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      // storage blocked: default to on
    }
    this.enabled = stored !== 'off';
  }

  get supported() {
    return Boolean(globalThis.AudioContext || globalThis.webkitAudioContext);
  }

  /** Must be called from a user gesture (click / key press). */
  unlock() {
    if (!this.supported) return;

    if (!this.ctx) {
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      this.ctx = new Context();
      this.master = this.ctx.createGain();
      this.master.gain.value = 1;
      this.master.connect(this.ctx.destination);
    }

    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  async load() {
    if (this.buffers) return this.buffers;

    const decode = async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      return this.ctx.decodeAudioData(await response.arrayBuffer());
    };

    const [start, loop] = await Promise.all([decode(this.startUrl), decode(this.loopUrl)]);
    this.buffers = { start, loop };
    return this.buffers;
  }

  async start() {
    if (!this.enabled || !this.supported || this.playing) return;
    this.unlock();

    try {
      const { start, loop } = await this.load();
      if (!this.enabled || this.playing) return;

      const now = this.ctx.currentTime + 0.05;
      const joinAt = now + Math.max(0, start.duration - FADE);
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setValueAtTime(1, this.ctx.currentTime);

      const startSource = this.ctx.createBufferSource();
      startSource.buffer = start;
      const startGain = this.ctx.createGain();
      startGain.gain.setValueAtTime(START_GAIN, now);
      startGain.gain.setValueAtTime(START_GAIN, joinAt);
      startGain.gain.linearRampToValueAtTime(0, joinAt + FADE);
      startSource.connect(startGain).connect(this.master);
      startSource.start(now);

      const loopSource = this.ctx.createBufferSource();
      loopSource.buffer = loop;
      loopSource.loop = true;
      const loopGain = this.ctx.createGain();
      loopGain.gain.setValueAtTime(0, joinAt);
      loopGain.gain.linearRampToValueAtTime(LOOP_GAIN, joinAt + FADE);
      loopSource.connect(loopGain).connect(this.master);
      loopSource.start(joinAt);

      this.sources = [startSource, loopSource];
      this.playing = true;
    } catch (error) {
      console.warn('Console sound unavailable:', error);
    }
  }

  stop() {
    if (!this.ctx || !this.playing) return;

    const end = this.ctx.currentTime + 0.25;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setValueAtTime(this.master.gain.value, this.ctx.currentTime);
    this.master.gain.linearRampToValueAtTime(0, end);
    for (const source of this.sources) {
      try {
        source.stop(end + 0.05);
      } catch {
        // already stopped
      }
    }
    this.sources = [];
    this.playing = false;
  }

  setEnabled(value) {
    this.enabled = value;
    try {
      localStorage.setItem(STORAGE_KEY, value ? 'on' : 'off');
    } catch {
      // ignore
    }

    if (value) {
      this.unlock();
      void this.start();
    } else {
      this.stop();
    }
  }

  /** A faint key-click for the typewriter effect. */
  tick() {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;

    const now = this.ctx.currentTime;
    if (now - this.lastTick < 0.045) return; // never more than ~22 clicks a second
    this.lastTick = now;

    if (!this.tickBuffer) {
      const length = Math.floor(this.ctx.sampleRate * 0.012);
      this.tickBuffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = this.tickBuffer.getChannelData(0);
      for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
    }

    const source = this.ctx.createBufferSource();
    source.buffer = this.tickBuffer;
    source.playbackRate.value = 0.85 + Math.random() * 0.4;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1800 + Math.random() * 900;

    const gain = this.ctx.createGain();
    gain.gain.value = 0.16;
    source.connect(filter).connect(gain).connect(this.master);
    source.start(now);
  }
}
