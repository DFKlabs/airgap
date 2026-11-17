# The voice-over

49 seconds, in English. Generated with ElevenLabs (Eleven v4, voice **Roger – Laid-Back, Casual,
Resonant**, Stability 50 %, Similarity 75 %, Language English), the whole script in one generation.
Two takes were made; `audio/voice.mp3` is take 2, chosen because it moves more in pitch
(5.8 semitones of spread against 5.3), so it sounds less flat.

The free ElevenLabs plan allows non-commercial use with attribution, so every post carries
**Voice: elevenlabs.io**.

## What was pasted into ElevenLabs

Audio tags in square brackets set the delivery; they are not spoken.

```
[intrigued] This sound just carried a text message. [short pause] No internet involved.

Here's how you turn data into sound… [curious] and how the phone knows nothing got lost.

[explaining] It's called frequency-shift keying. Each pitch stands for a number. Use sixteen pitches, and every single tone carries four bits.

Each tone plays for seventy milliseconds. Then silence, so echoes from the room fade before the next one.

[curious] But how does the receiver know a message is starting? [short pause] A preamble. A fixed pattern it's always listening for.

[excited] And the genius part: a checksum. A small number calculated from the whole message. If one tone is misheard, the numbers don't match… [serious] and the message is rejected.

[warm] Same idea as old dial-up modems. [short pause] Just in your pocket.
```

The spoken words alone are in `script.txt`; `align.py` matches them to the recording.

## Why it is built this way

- **The hook is a sound.** The reel opens on the real chirp before a word is said, so the first
  second already asks a question.
- **A promise at 3 s** ("…and how the phone knows nothing got lost") opens a loop that the
  checksum chapter closes at 0:34.
- **Every number is the modem's own**, read from `app/modem.js`: 16 tones from 1.0 to 3.4 kHz,
  70 ms + 20 ms, the `0F0F0F` preamble, CRC-16 values computed on the real packet.
- **Chapters with a progress bar** on top tell the viewer how much is left.
- **The URL never appears in the video.** It explains the technology; the link lives in the post.
