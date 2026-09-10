'use strict';
/*
 * Meld Hall — procedural WebAudio: buses (music/effects/ambience/voice),
 * independent volumes, event mapping, captions hook, focus behavior.
 * Effects prefer authored samples (sfx/<name>.opus, see sfx/manifest.json),
 * lazily fetched/decoded after the user-gesture unlock; the synthesized
 * fallbacks below run while a sample is loading or if it is unavailable.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MeldAudio = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {

  function Audio() {
    this.ctx = null;
    this.buses = {};
    this.settings = { music: 0.5, effects: 0.8, ambience: 0.4, voice: 0, muted: false, captions: true };
    this.captionListener = null;
    this.musicNodes = null;
    this.ambNodes = null;
    this.sfxBuffers = {};   // name -> decoded AudioBuffer
    this.sfxLoading = {};   // name -> true while a fetch/decode is in flight
    this.sfxFailed = {};    // name -> true after a failed load (use synthesis)
  }

  Audio.prototype.ensure = function () {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      const master = this.ctx.createGain();
      master.connect(this.ctx.destination);
      this.master = master;
      for (const b of ['music', 'effects', 'ambience', 'voice']) {
        const g = this.ctx.createGain();
        g.connect(master);
        this.buses[b] = g;
      }
      this.applySettings(this.settings);
      this._startAmbience();
      this._startMusic();
    } catch (_) { this.ctx = null; }
  };

  Audio.prototype.applySettings = function (s) {
    this.settings = Object.assign(this.settings, s || {});
    if (!this.ctx) return;
    const m = this.settings.muted ? 0 : 1;
    this.master.gain.value = m;
    for (const b in this.buses) this.buses[b].gain.value = (this.settings[b] != null ? this.settings[b] : 0.5);
  };

  Audio.prototype.caption = function (text) {
    if (this.settings.captions && this.captionListener) this.captionListener(text);
  };
  Audio.prototype.onCaption = function (fn) { this.captionListener = fn; };

  function tone(ctx, bus, freq, dur, type, gain, slide) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, ctx.currentTime + dur);
    g.gain.value = gain;
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g); g.connect(bus);
    o.start(); o.stop(ctx.currentTime + dur);
  }
  function noise(ctx, bus, dur, gain, filterFreq) {
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; ++i) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filterFreq || 2000;
    const g = ctx.createGain(); g.gain.value = gain;
    src.connect(f); f.connect(g); g.connect(bus);
    src.start();
  }

  // Event hierarchy: ack < legal move < combo/goal < round completion.
  // Authored one-shot samples per event (basenames under sfx/, from
  // sfx/manifest.json); multiple names per event are rotated. Every event
  // keeps its synthesized fallback below for loading/failure.
  const SFX_BASE = 'sfx/';
  const SFX_EVENTS = {
    select: ['card-select', 'card-deselect'],
    invalid: ['invalid-buzz'],
    draw: ['card-draw', 'card-draw-take'],
    meld: ['meld-fan'],
    layoff: ['layoff-tap'],
    discard: ['card-discard'],
    turn: ['turn-chime'],
    roundWin: ['round-win'],
    roundLose: ['round-lose'],
    achievement: ['achievement-chime'],
    deal: ['deal-round'],
    hint: ['hint-shimmer'],
    matchWin: ['match-win'],
    ui: ['ui-click', 'ui-confirm'],
  };
  const SFX_CAPTIONS = {
    select: 'Card selected',
    invalid: 'That action is not legal',
    draw: 'Card drawn',
    meld: 'Meld played',
    layoff: 'Card laid off',
    discard: 'Card discarded',
    turn: 'Your turn',
    roundWin: 'Round won',
    roundLose: 'Round lost',
    achievement: 'Achievement unlocked',
    deal: 'Cards dealt',
    hint: 'Hint offered',
    matchWin: 'Match won',
  };

  Audio.prototype._loadSample = function (name) {
    if (this.sfxLoading[name] || this.sfxFailed[name] || this.sfxBuffers[name]) return;
    if (typeof fetch !== 'function') { this.sfxFailed[name] = true; return; }
    this.sfxLoading[name] = true;
    const self = this;
    fetch(SFX_BASE + name + '.opus')
      .then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.arrayBuffer();
      })
      .then(function (ab) { return self.ctx.decodeAudioData(ab); })
      .then(function (buf) { self.sfxBuffers[name] = buf; })
      .catch(function () { self.sfxFailed[name] = true; })
      .then(function () { self.sfxLoading[name] = false; });
  };

  // Try to play an authored sample for the event. Returns true when a
  // decoded buffer was actually started; otherwise kicks off a lazy load
  // and returns false so the caller runs the synthesized fallback.
  Audio.prototype._trySample = function (kind) {
    const names = SFX_EVENTS[kind];
    if (!names) return false;
    for (let i = 0; i < names.length; ++i) this._loadSample(names[i]);
    const start = Math.floor(Math.random() * names.length);
    for (let i = 0; i < names.length; ++i) {
      const buf = this.sfxBuffers[names[(start + i) % names.length]];
      if (!buf) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.buses.effects);
      src.start();
      if (SFX_CAPTIONS[kind]) this.caption(SFX_CAPTIONS[kind]);
      return true;
    }
    return false;
  };

  Audio.prototype.play = function (kind) {
    if (!this.ctx) return;
    const fx = this.buses.effects;
    if (this._trySample(kind)) return;
    switch (kind) {
      case 'select': tone(this.ctx, fx, 660, 0.07, 'sine', 0.15); this.caption('Card selected'); break;
      case 'invalid': tone(this.ctx, fx, 180, 0.18, 'square', 0.12, 120); this.caption('That action is not legal'); break;
      case 'draw': noise(this.ctx, fx, 0.09, 0.2, 3000); tone(this.ctx, fx, 440, 0.1, 'triangle', 0.12); this.caption('Card drawn'); break;
      case 'meld':
        tone(this.ctx, fx, 523, 0.12, 'sine', 0.16);
        tone(this.ctx, fx, 659, 0.14, 'sine', 0.16);
        tone(this.ctx, fx, 784, 0.2, 'sine', 0.18);
        this.caption('Meld played'); break;
      case 'layoff': tone(this.ctx, fx, 587, 0.14, 'sine', 0.16, 660); this.caption('Card laid off'); break;
      case 'discard': noise(this.ctx, fx, 0.08, 0.15, 1800); tone(this.ctx, fx, 330, 0.1, 'sine', 0.1); this.caption('Card discarded'); break;
      case 'turn': tone(this.ctx, fx, 500, 0.06, 'sine', 0.08); this.caption('Your turn'); break;
      case 'roundWin':
        [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.ctx && tone(this.ctx, fx, f, 0.25, 'sine', 0.2), i * 120));
        this.caption('Round won'); break;
      case 'roundLose':
        [440, 392, 330].forEach((f, i) => setTimeout(() => this.ctx && tone(this.ctx, fx, f, 0.3, 'sine', 0.15), i * 140));
        this.caption('Round lost'); break;
      case 'achievement': tone(this.ctx, fx, 880, 0.3, 'triangle', 0.2, 1320); this.caption('Achievement unlocked'); break;
      case 'deal':
        [0, 90, 180, 270, 360].forEach((d) => setTimeout(() => this.ctx && noise(this.ctx, fx, 0.07, 0.16, 2600), d));
        this.caption('Cards dealt'); break;
      case 'hint': tone(this.ctx, fx, 990, 0.12, 'sine', 0.12, 1320); this.caption('Hint offered'); break;
      case 'matchWin':
        [523, 659, 784, 1047, 1319].forEach((f, i) => setTimeout(() => this.ctx && tone(this.ctx, fx, f, 0.35, 'triangle', 0.2), i * 130));
        this.caption('Match won'); break;
      case 'ui': tone(this.ctx, fx, 700, 0.05, 'sine', 0.08); break;
    }
  };

  Audio.prototype._startAmbience = function () {
    // quiet hall room tone: filtered looping noise
    const ctx = this.ctx;
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; ++i) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 220;
    src.connect(f); f.connect(this.buses.ambience);
    src.start();
    this.ambNodes = [src];
  };

  Audio.prototype._startMusic = function () {
    // gentle adaptive stem: slow chord pad; intensity rises near round end via setMusicIntensity
    const ctx = this.ctx;
    const chords = [[261.6, 329.6, 392], [220, 261.6, 329.6], [196, 246.9, 293.7], [174.6, 220, 261.6]];
    let step = 0;
    const self = this;
    this.musicIntensity = 0;
    this._musicTimer = setInterval(function () {
      if (!self.ctx || document.hidden) return;
      const chord = chords[step++ % chords.length];
      const dur = 3.2;
      for (const f of chord) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'triangle'; o.frequency.value = f * (1 + self.musicIntensity * 0.5);
        g.gain.setValueAtTime(0.0001, ctx.currentTime);
        g.gain.linearRampToValueAtTime(0.05 + self.musicIntensity * 0.05, ctx.currentTime + 0.8);
        g.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + dur);
        o.connect(g); g.connect(self.buses.music);
        o.start(); o.stop(ctx.currentTime + dur);
      }
    }, 3000);
  };
  Audio.prototype.setMusicIntensity = function (v) { this.musicIntensity = Math.max(0, Math.min(1, v)); };

  Audio.prototype.setBackground = function (hidden) {
    if (!this.ctx) return;
    // background tabs: duck everything but keep lifecycle alive
    this.master.gain.value = hidden ? 0 : (this.settings.muted ? 0 : 1);
  };

  return new Audio();
});
