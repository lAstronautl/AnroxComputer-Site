/**
 * Console sound: a start-up sting played once, then a seamless ambient loop
 * (the loop file already has the start-up cut out and a crossfaded seam).
 * Uses the Web Audio API so the loop is gapless; browsers only allow audio after
 * a user gesture, so everything starts from `unlock()` called inside a click/key.
 */

const STORAGE_KEY = 'anco-console-sound';
const VOLUME_KEY = 'anco-console-volume';
const DEFAULT_VOLUME = 0.8;
const PHASE_KEY = 'anco-loop-phase'; // wall-clock moment when the loop was at its start (shared by all pages)
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

    let volume = DEFAULT_VOLUME;
    try {
      const saved = parseFloat(localStorage.getItem(VOLUME_KEY));
      if (Number.isFinite(saved)) volume = Math.min(1, Math.max(0, saved));
    } catch {
      // storage blocked: default volume
    }
    this.volume = volume;
    if (volume === 0) this.enabled = false;

    // an "off" left by the old sound button does not count: until the knob has been used the sound is on
    let usedKnob = false;
    try {
      usedKnob = localStorage.getItem(VOLUME_KEY) !== null;
    } catch {
      // ignore
    }
    if (!usedKnob) this.enabled = true;
  }

  /** What actually reaches the speakers: the volume knob, or silence when muted. */
  get level() {
    return this.enabled ? this.volume : 0;
  }

  /** Volume knob (0..1). Zero is the same as muted; anything above turns the sound on. */
  setVolume(value) {
    this.volume = Math.min(1, Math.max(0, value));
    this.enabled = this.volume > 0;

    try {
      localStorage.setItem(VOLUME_KEY, String(this.volume));
      localStorage.setItem(STORAGE_KEY, this.enabled ? 'on' : 'off');
    } catch {
      // ignore
    }

    if (this.ctx && this.master) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setTargetAtTime(this.level, this.ctx.currentTime, 0.03);
    }
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
      this.master.gain.value = this.level;
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
      this.master.gain.setValueAtTime(this.level, this.ctx.currentTime);

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

  /**
   * Ambient loop only (no start-up sting), for the site pages in the console theme. Its position follows a shared
   * wall clock (see PHASE_KEY), so moving between pages does not restart the music from the top.
   */
  async startLoop() {
    if (!this.enabled || !this.supported || this.playing || !this.loopUrl) return;
    this.unlock();
    if (this.ctx.state !== 'running') return; // the browser has not allowed audio yet: retried on the next gesture

    try {
      if (!this.loopBuffer) {
        const response = await fetch(this.loopUrl);
        if (!response.ok) throw new Error(String(response.status));
        this.loopBuffer = await this.ctx.decodeAudioData(await response.arrayBuffer());
      }
      if (!this.enabled || this.playing || this.ctx.state !== 'running') return;

      // the loop keeps its own clock: wherever the previous page was, this one joins at the same moment
      const duration = this.loopBuffer.duration;
      let phase = 0;
      try {
        phase = parseFloat(localStorage.getItem(PHASE_KEY)) || 0;
        if (!phase || phase > Date.now()) {
          phase = Date.now();
          localStorage.setItem(PHASE_KEY, String(phase));
        }
      } catch {
        phase = Date.now();
      }
      const offset = duration ? ((Date.now() - phase) / 1000) % duration : 0;

      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(this.level, now);

      const source = this.ctx.createBufferSource();
      source.buffer = this.loopBuffer;
      source.loop = true;
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(LOOP_GAIN, now + (offset > 1 ? 0.4 : 1.2));
      source.connect(gain).connect(this.master);
      source.start(0, offset);

      this.sources = [source];
      this.playing = true;
    } catch (error) {
      console.warn('Ambient loop unavailable:', error);
    }
  }

  /** Plays just the start-up sting (no loop), e.g. for the site boot screen. */
  async sting() {
    if (!this.enabled || !this.supported || !this.ctx || this.ctx.state !== 'running' || !this.startUrl) return;

    try {
      const response = await fetch(this.startUrl);
      if (!response.ok) throw new Error(String(response.status));
      const buffer = await this.ctx.decodeAudioData(await response.arrayBuffer());

      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      const gain = this.ctx.createGain();
      gain.gain.value = START_GAIN;
      source.connect(gain).connect(this.master);
      source.start();
    } catch (error) {
      console.warn('Start-up sound unavailable:', error);
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

  /** Mute / unmute without touching the start-up sting or the loop (used by the site-wide switch). */
  mute(value) {
    this.enabled = !value;
    if (!value && this.volume === 0) this.volume = DEFAULT_VOLUME;
    try {
      localStorage.setItem(STORAGE_KEY, value ? 'off' : 'on');
    } catch {
      // ignore
    }
    if (value) {
      this.stop();
    }
  }

  setEnabled(value) {
    this.enabled = value;
    if (value && this.volume === 0) this.volume = DEFAULT_VOLUME;
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

  /** Synthesised flashbang: a loud crack, then a ringing in the ears while everything else is muffled. */
  flashbang() {
    this.unlock();
    if (!this.enabled || !this.ctx) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;

    // everything already playing (the ambient loop) is muffled for a few seconds
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(this.level * 0.12, now + 0.05);
    this.master.gain.setValueAtTime(this.level * 0.12, now + 4.5);
    this.master.gain.linearRampToValueAtTime(this.level, now + 7);

    const out = ctx.createGain();
    out.gain.value = this.level;
    out.connect(ctx.destination); // bypass the muffled master

    // the bang: white noise with a fast decay
    const length = Math.floor(ctx.sampleRate * 0.9);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.setValueAtTime(9000, now);
    lowpass.frequency.exponentialRampToValueAtTime(400, now + 0.8);
    const bang = ctx.createGain();
    bang.gain.setValueAtTime(0.9, now);
    bang.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
    noise.connect(lowpass).connect(bang).connect(out);
    noise.start(now);

    // the ringing: a high sine that fades out slowly
    const ring = ctx.createOscillator();
    ring.type = 'sine';
    ring.frequency.value = 3150;
    const ringGain = ctx.createGain();
    ringGain.gain.setValueAtTime(0.0001, now);
    ringGain.gain.linearRampToValueAtTime(0.16, now + 0.15);
    ringGain.gain.setValueAtTime(0.16, now + 2);
    ringGain.gain.exponentialRampToValueAtTime(0.0001, now + 7);
    ring.connect(ringGain).connect(out);
    ring.start(now);
    ring.stop(now + 7.2);
  }

  /** A faint key-click for the typewriter effect. */
  tick() {
    this.click(0.16, 0.045); // never more than ~22 clicks a second
  }

  /** A firmer click for keys the player presses. */
  key() {
    this.click(0.32, 0.015);
  }

  click(volume, minGap) {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;

    const now = this.ctx.currentTime;
    if (now - this.lastTick < minGap) return;
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
    gain.gain.value = volume;
    source.connect(filter).connect(gain).connect(this.master);
    source.start(now);
  }
}
