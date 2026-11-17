/*
 * airgap modem — text over sound, in the browser, with no server.
 *
 * 16-tone MFSK: every symbol is one of 16 frequencies between 1.0 and 3.4 kHz,
 * the band small phone speakers and microphones reproduce best, so each tone
 * carries 4 bits. A symbol rings for 70 ms and is followed by 20 ms of
 * silence, which lets a room's echo die down before the next one.
 *
 * A message travels as packets of up to PACKET bytes, each one its own frame:
 *
 *   preamble  0 F 0 F 0 F        six symbols the listener locks onto
 *   length    1 byte (of what follows, before the check)
 *   id        1 byte, the same for every packet of one message
 *   part      1 byte: packet number (high nibble) and count - 1 (low nibble)
 *   data      up to PACKET bytes of the message's UTF-8
 *   check     CRC-16/CCITT over everything from length to data
 *
 * Short packets are why long messages arrive: each one locks on afresh, so
 * clock drift and a moment of noise cost one packet, not the whole message,
 * and a packet heard on the second try fills the gap left by the first.
 *
 * The same file runs in the browser and in Node (for the tests): it only does
 * arithmetic on Float32Arrays; the page wires it to Web Audio.
 */
export const BASE = 1000, STEP = 160, TONES = 16;
export const SYM = 0.07, GAP = 0.02;           // seconds
export const PREAMBLE = [0, 15, 0, 15, 0, 15];
export const PACKET = 20;                      // data bytes per packet
export const MAX_BYTES = 160;                  // 8 packets, about 40 seconds of sound
export const LEVEL = 0.92;                     // loud: phone speakers are quiet
const QUIET = -1, PAUSE = 2;                   // silent slots between packets

const freq = (t) => BASE + t * STEP;

export function crc16(bytes) {
  let c = 0xffff;
  for (const b of bytes) {
    c ^= b << 8;
    for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}

let lastId = 0;
/** A message id: any byte, different from the last one this page used. */
export const newId = () => { let id; do id = Math.floor(Math.random() * 256); while (id === lastId); return (lastId = id); };

/** Text → the packets' symbols, preambles and pauses included (QUIET is a silent slot). */
export function symbolsFor(text, id = 0) {
  let data = new TextEncoder().encode(text);
  if (data.length > MAX_BYTES) data = data.slice(0, MAX_BYTES);
  const count = Math.max(1, Math.ceil(data.length / PACKET));
  const out = [];
  for (let k = 0; k < count; k++) {
    const chunk = [...data.slice(k * PACKET, (k + 1) * PACKET)];
    const body = [2 + chunk.length, id & 255, (k << 4) | (count - 1), ...chunk];
    const c = crc16(body);
    if (k) for (let i = 0; i < PAUSE; i++) out.push(QUIET);
    out.push(...PREAMBLE);
    for (const b of [...body, c >> 8, c & 0xff]) out.push(b >> 4, b & 15);
  }
  return out;
}

/** Symbols → audio samples at the given rate, with short fades so tones do not click. */
export function render(symbols, rate) {
  const n = Math.round(SYM * rate), g = Math.round(GAP * rate), fade = Math.round(0.006 * rate);
  const out = new Float32Array(symbols.length * (n + g) + Math.round(0.2 * rate));
  let o = Math.round(0.1 * rate);
  for (const s of symbols) {
    if (s !== QUIET) {
      const w = 2 * Math.PI * freq(s) / rate;
      for (let i = 0; i < n; i++) out[o + i] = LEVEL * Math.min(1, i / fade, (n - 1 - i) / fade) * Math.sin(w * i);
    }
    o += n + g;
  }
  return out;
}

export const encode = (text, rate, id = 0) => render(symbolsFor(text, id), rate);
export const duration = (text) => symbolsFor(text).length * (SYM + GAP) + 0.3;

/** Energy of one frequency in a window (Goertzel). */
function goertzel(x, start, len, f, rate) {
  const k = 2 * Math.cos(2 * Math.PI * f / rate);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < len; i++) { const s0 = x[start + i] + k * s1 - s2; s2 = s1; s1 = s0; }
  return s1 * s1 + s2 * s2 - k * s1 * s2;
}

/** The strongest of the 16 tones in a window, and how much it stands out. */
function strongest(x, start, len, rate) {
  let best = 0, bi = 0, sum = 0;
  for (let t = 0; t < TONES; t++) {
    const e = goertzel(x, start, len, freq(t), rate);
    sum += e;
    if (e > best) { best = e; bi = t; }
  }
  return { tone: bi, ratio: sum ? best / sum : 0, energy: best / len };
}

/**
 * A listener: push microphone samples in, get messages out.
 * It keeps a few seconds of audio, looks for a preamble every 1/8 symbol,
 * reads each packet from the middle of its slots, and puts packets together
 * by message id. A message is delivered once all its packets are in, from any
 * number of tries; parts of an unfinished message are kept for two minutes.
 */
export class Receiver {
  // onPart({ id, k, count, have, clarity }) for every packet read, clarity being how much the
  // tones stood out (1 = nothing else heard); onMessage({ text, id, at }) once a message is whole.
  constructor(rate, { onMessage, onLevel, onError, onPart } = {}) {
    this.rate = rate;
    this.n = Math.round(SYM * rate);
    this.slot = this.n + Math.round(GAP * rate);
    this.hop = Math.max(1, Math.round(this.slot / 8));
    // Room for the longest packet and its preamble, with plenty to spare.
    this.buf = new Float32Array(Math.round(this.slot * (PREAMBLE.length + 2 * (PACKET + 5)) * 2 + rate * 2));
    this.len = 0;
    this.pos = 0;            // next hop to analyse
    this.cb = { onMessage, onLevel, onError, onPart };
    this.cooldown = 0;
    this.parts = new Map();  // id → { count, got: Map(k → bytes), at }
  }

  push(samples) {
    if (this.len + samples.length > this.buf.length) {
      // Drop the oldest audio, keeping everything a packet in flight could need.
      const keep = this.buf.length - samples.length;
      const drop = this.len - keep;
      if (drop > 0) { this.buf.copyWithin(0, drop, this.len); this.len -= drop; this.pos = Math.max(0, this.pos - drop); }
    }
    this.buf.set(samples, this.len);
    this.len += samples.length;
    this.scan();
  }

  scan() {
    const { n, slot, hop } = this;
    const need = PREAMBLE.length * slot;
    while (this.pos + need + n <= this.len) {
      if (this.cooldown > 0) { this.pos += hop; this.cooldown -= hop; continue; }
      const p = this.pos;
      const win = Math.round(n * 0.6), off = Math.round(n * 0.2);
      // Does a preamble start here? Every one of its six slots must carry its tone, clearly.
      let ok = true;
      for (let i = 0; i < PREAMBLE.length && ok; i++) {
        const r = strongest(this.buf, p + i * slot + off, win, this.rate);
        if (r.tone !== PREAMBLE[i] || r.ratio < 0.45) ok = false;
      }
      if (this.cb.onLevel && p % (hop * 4) < hop) this.cb.onLevel(strongest(this.buf, p, n, this.rate));
      if (!ok) { this.pos += hop; continue; }
      // Refine: slide within one hop to the offset where the preamble rings strongest.
      let bestP = p, bestE = -1;
      for (let d = -hop; d <= hop; d += Math.max(1, Math.round(hop / 4))) {
        if (p + d < 0) continue;
        let e = 0;
        for (let i = 0; i < PREAMBLE.length; i++) e += goertzel(this.buf, p + d + i * slot + off, win, freq(PREAMBLE[i]), this.rate);
        if (e > bestE) { bestE = e; bestP = p + d; }
      }
      const r = this.read(bestP + PREAMBLE.length * slot);
      if (r === 'wait') return;               // the rest has not arrived yet
      if (r) { this.packet(r.body, r.clarity); this.pos = bestP + r.symbols * slot; this.cooldown = slot; }
      else { this.cb.onError && this.cb.onError('crc'); this.pos = bestP + PREAMBLE.length * slot; }
    }
  }

  /** Reads one packet from `start`; 'wait' if it is not all here yet, null if it fails the check. */
  read(start) {
    const { n, slot } = this;
    const win = Math.round(n * 0.6), off = Math.round(n * 0.2);
    let clear = 0, seen = 0;
    const sym = (i) => { const r = strongest(this.buf, start + i * slot + off, win, this.rate); clear += r.ratio; seen++; return r.tone; };
    if (start + 2 * slot > this.len) return 'wait';
    const length = (sym(0) << 4) | sym(1);
    if (length < 2 || length > PACKET + 2) return null;
    const total = 2 * (1 + length + 2);
    if (start + total * slot > this.len) return 'wait';
    const bytes = [];
    for (let i = 0; i < total; i += 2) bytes.push((sym(i) << 4) | sym(i + 1));
    const body = bytes.slice(0, 1 + length), c = (bytes[1 + length] << 8) | bytes[2 + length];
    if (crc16(body) !== c) return null;
    return { body, symbols: PREAMBLE.length + total, clarity: clear / seen };
  }

  /** Files a packet under its message and delivers the message when it is whole. */
  packet(body, clarity = 1) {
    const id = body[1], k = body[2] >> 4, count = (body[2] & 15) + 1, data = body.slice(3);
    if (k >= count) return;
    const now = Date.now();
    for (const [key, m] of this.parts) if (now - m.at > 120000) this.parts.delete(key);
    let m = this.parts.get(id);
    if (!m || m.count !== count) { m = { count, got: new Map(), at: now }; this.parts.set(id, m); }
    m.got.set(k, data); m.at = now;
    this.cb.onPart && this.cb.onPart({ id, k, count, have: m.got.size, clarity });
    if (m.got.size < count) return;
    // Once whole, a later try is delivered again when it has run from its first
    // packet to its last, so it is answered once per try, not once per packet.
    if (m.since) { m.since.add(k); if (k !== count - 1 || !m.since.has(0)) return; }
    m.since = new Set();
    const all = [];
    for (let i = 0; i < count; i++) all.push(...m.got.get(i));
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(all)); } catch (e) { this.parts.delete(id); this.cb.onError && this.cb.onError('utf8'); return; }
    this.cb.onMessage && this.cb.onMessage({ text, id, at: now });
  }
}

/*
 * Delivery receipts. A phone that reads a message answers with a tiny one of
 * its own: the ACK control character and the CRC of what it read, as four hex
 * digits. The sender matches it to the message it sent and marks it heard.
 * About two seconds of sound.
 */
export const ACK = '\u0006';
export const ackFor = (text) => ACK + crc16([...new TextEncoder().encode(text)]).toString(16).padStart(4, '0');
export const ackOf = (text) => (text.length === 5 && text[0] === ACK && /^[0-9a-f]{4}$/.test(text.slice(1)) ? text.slice(1) : null);
export const idOf = (text) => ackFor(text).slice(1);

/*
 * Morse, for when a person should be able to hear it too. One tone at
 * MORSE_HZ, International Morse timing (dot 1, dash 3, gap 1, letter 3,
 * word 7 units); 15 words a minute makes a unit 80 ms.
 */
export const MORSE_HZ = 800, MORSE_WPM = 15;
export const MORSE = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--',
  N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--', '/': '-..-.', '(': '-.--.', ')': '-.--.-', '&': '.-...',
  ':': '---...', ';': '-.-.-.', '=': '-...-', '+': '.-.-.', '-': '-....-', '"': '.-..-.', '@': '.--.-.',
};
const UNMORSE = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));
const FOLD = { Á: 'A', À: 'A', Ä: 'A', Â: 'A', É: 'E', È: 'E', Ë: 'E', Ê: 'E', Í: 'I', Ï: 'I', Ó: 'O', Ö: 'O', Ô: 'O', Ú: 'U', Ü: 'U', Ñ: 'N', Ç: 'C' };

/** What Morse can carry of a text: upper case, accents folded, the rest dropped. */
export function morseText(text) {
  return text.toUpperCase().split('').map((c) => FOLD[c] || c).filter((c) => c === ' ' || MORSE[c]).join('').replace(/\s+/g, ' ').trim();
}
export const morseCode = (text) => morseText(text).split(' ').map((w) => w.split('').map((c) => MORSE[c]).join(' ')).join(' / ');

export function morseEncode(text, rate, wpm = MORSE_WPM) {
  const u = Math.round(1.2 / wpm * rate), fade = Math.round(0.005 * rate), w = 2 * Math.PI * MORSE_HZ / rate;
  const marks = [];                       // [on?, units]
  morseText(text).split(' ').forEach((word, wi) => {
    if (wi) marks.push([0, 7]);
    word.split('').forEach((c, ci) => {
      if (ci) marks.push([0, 3]);
      MORSE[c].split('').forEach((s, si) => { if (si) marks.push([0, 1]); marks.push([1, s === '.' ? 1 : 3]); });
    });
  });
  const total = marks.reduce((a, m) => a + m[1], 0);
  const out = new Float32Array(total * u + Math.round(0.3 * rate));
  let o = Math.round(0.1 * rate);
  for (const [on, k] of marks) {
    const n = k * u;
    if (on) for (let i = 0; i < n; i++) out[o + i] = LEVEL * Math.min(1, i / fade, (n - 1 - i) / fade) * Math.sin(w * (o + i));
    o += n;
  }
  return out;
}
export const morseDuration = (text, wpm = MORSE_WPM) => morseEncode(text, 8000, wpm).length / 8000;

/**
 * Hears Morse: the tone's energy in 10 ms blocks against two neighbours, so a
 * voice or a chord does not count as a mark; marks and gaps are measured in
 * blocks and read against the dot length the sender is actually using.
 * onChar(text so far) while it arrives, onText(text) after a pause.
 */
export class MorseReceiver {
  constructor(rate, { onChar, onText } = {}) {
    this.rate = rate; this.block = Math.round(rate * 0.01); this.cb = { onChar, onText };
    this.rest = new Float32Array(0); this.floor = 0; this.warm = 0; this.peak = 0;
    this.on = false; this.run = 0; this.pend = 0; this.lastDot = 0; this.heard = false; this.unit = Math.round(1.2 / MORSE_WPM * 100);
    this.sym = ''; this.text = ''; this.idle = 0;
  }
  push(samples) {
    let x = samples;
    if (this.rest.length) { x = new Float32Array(this.rest.length + samples.length); x.set(this.rest); x.set(samples, this.rest.length); }
    const B = this.block; let i = 0;
    for (; i + B <= x.length; i += B) this.step(x, i, B);
    this.rest = x.slice(i);
  }
  step(x, start, B) {
    const e = (f) => { const k = 2 * Math.cos(2 * Math.PI * f / this.rate); let s1 = 0, s2 = 0; for (let i = 0; i < B; i++) { const s0 = x[start + i] + k * s1 - s2; s2 = s1; s1 = s0; } return (s1 * s1 + s2 * s2 - k * s1 * s2) / B; };
    const t = e(MORSE_HZ), side = Math.max(e(MORSE_HZ - 300), e(MORSE_HZ + 300));
    // The floor is the room's usual level at this pitch (only quiet blocks feed it) and the
    // peak is the loudest recent mark. A mark has to clear both by a margin, so noise does
    // not count, and neither does the room's echo trailing a mark at a quarter of its level.
    if (this.warm < 25) { this.floor = (this.floor * this.warm + t) / (this.warm + 1); this.warm++; return; }   // a quarter second to learn the room
    if (t < this.floor * 4) this.floor = Math.max(1e-9, this.floor * 0.95 + t * 0.05);
    this.peak = Math.max(t, this.peak * 0.997);
    const hi = Math.max(this.floor * 12, this.peak * 0.12), lo = Math.max(this.floor * 6, this.peak * 0.06);
    // Hysteresis: easier to stay on than to come on. And a change counts only
    // once it has held for two blocks, so a one-block dropout or blip is ignored.
    const raw = this.on ? t > lo && t > side * 2 : t > hi && t > side * 4;
    if (raw === this.on) { this.run += this.pend + 1; this.pend = 0; if (!raw) this.gap(); return; }
    if (++this.pend < 2) return;
    if (this.on) this.mark(this.run); else this.space(this.run);
    this.on = raw; this.run = this.pend; this.pend = 0;
  }
  // A room's echo makes every mark longer and every gap shorter by the same
  // amount, so the unit is read from a dot and the gap after it together.
  mark(n) {
    if (n < 3) return;                        // too short to be a dot
    const dot = n < this.unit * 2;
    if (dot) this.lastDot = n;
    this.sym += dot ? '.' : '-';
  }
  space(n) {
    if (n < this.unit * 2) {
      if (this.lastDot && n >= this.unit / 2 && this.lastDot >= this.unit / 2) { const u = (this.lastDot + n) / 2; this.unit = Math.min(16, Math.max(5, Math.round(this.heard ? this.unit * 0.5 + u * 0.5 : u))); this.heard = true; }
      this.lastDot = 0;
      return;
    }
    this.letter();
    if (n >= this.unit * 5 && this.text && !this.text.endsWith(' ')) this.text += ' ';
  }
  letter() {
    if (!this.sym) return;
    const c = UNMORSE[this.sym]; this.sym = '';
    if (c) { this.text += c; this.cb.onChar && this.cb.onChar(this.text); }
  }
  gap() {
    // A long silence ends the message: the pending letter, then the whole text.
    if (this.run >= this.unit * 3) this.letter();
    if (this.run >= this.unit * 12 && this.text) {
      const t = this.text.trim(); this.text = ''; this.heard = false;
      if (t.replace(/ /g, '').length >= 2) this.cb.onText && this.cb.onText(t);
    }
  }
}
