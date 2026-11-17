"""Force-align the known voice-over script to the recording.

Writes words.json: one entry per word of script.txt, with its start and end
in seconds. The captions are drawn from it, word by word.

    python3 align.py audio/voice.mp3
"""
import json, re, subprocess, sys, tempfile, wave
from pathlib import Path
from pocketsphinx import Decoder

HERE = Path(__file__).parent
# Words the default dictionary does not know, in CMU phonemes.
EXTRA = {"checksum": "CH EH K S AH M", "misheard": "M IH S HH ER D",
         "preamble": "P R IY AE M B AH L", "modems": "M OW D AH M Z"}


def norm(w):
    return re.sub(r"[^a-z']", "", w.lower())


def main(audio):
    script = (HERE / "script.txt").read_text().split()
    tokens = [(w, [p for p in (norm(x) for x in w.split("-")) if p]) for w in script]
    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", audio, "-ac", "1", "-ar", "16000", tmp.name], check=True)
        pcm = wave.open(tmp.name, "rb").readframes(10**9)
    d = Decoder(samprate=16000, bestpath=False)
    for w, ph in EXTRA.items():
        if d.lookup_word(w) is None:
            d.add_word(w, ph, True)
    words = [a for _, parts in tokens for a in parts]
    missing = [w for w in words if d.lookup_word(w) is None]
    if missing:
        sys.exit(f"add these to EXTRA: {missing}")
    d.set_align_text(" ".join(words))
    d.start_utt(); d.process_raw(pcm, full_utt=True); d.end_utt()
    segs = [(re.sub(r"\(\d+\)$", "", s.word), s.start_frame / 100, (s.end_frame + 1) / 100)
            for s in d.seg() if s.word not in ("<s>", "</s>", "<sil>", "(NULL)")]
    out, i = [], 0
    for shown, parts in tokens:
        chunk = segs[i:i + len(parts)]; i += len(parts)
        assert [c[0] for c in chunk] == parts, (shown, chunk)
        out.append({"w": shown, "s": round(chunk[0][1], 3), "e": round(chunk[-1][2], 3)})
    (HERE / "words.json").write_text(json.dumps(out))
    print(f"{len(out)} words, {out[0]['s']:.2f}s to {out[-1]['e']:.2f}s")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else str(HERE / "audio" / "voice.mp3"))
