// The reel's sound effects come from the real modem, not from a sample:
// the hook is the word "hey" exactly as airgap would send it.
//
//   node chirp.mjs      -> build/chirp.f32, build/sweep.f32, build/pre.f32, build/chirp.json
import { symbolsFor, render, PREAMBLE, crc16 } from '../app/modem.js';
import { mkdirSync, writeFileSync } from 'fs';

const rate = 44100, id = 0x2a;
mkdirSync('build', { recursive: true });
const syms = symbolsFor('hey', id);
const f32 = (name, pcm) => writeFileSync(`build/${name}.f32`, Buffer.from(pcm.buffer));
f32('chirp', render(syms, rate));
f32('sweep', render([...Array(16).keys()], rate));   // the 16 tones, 0..F
f32('pre', render(PREAMBLE, rate));                   // 0F0F0F

// The checksum chapter shows real numbers: the packet as sent, and the same
// packet with one tone misheard ('y' 0x79 heard as 'z' 0x7a: nibble 9 -> A).
const body = [2 + 3, id, 0, ...new TextEncoder().encode('hey')];
const bad = [...body]; bad[5] = 0x7a;
writeFileSync('build/chirp.json', JSON.stringify({ syms, crc: crc16(body), crcBad: crc16(bad), body }));
console.log(`${syms.length} symbols, CRC-16 0x${crc16(body).toString(16)} sent, 0x${crc16(bad).toString(16)} misheard`);
