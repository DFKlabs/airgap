"""Draw the reel, frame by frame, with headless Chrome.

reel.html exposes render(t), which draws one frame at time t on a
2160x3840 canvas and returns it as a JPEG. This script asks for every frame
and pipes them into ffmpeg, one file per chapter, so a change to one chapter
only redraws that chapter.

    python3 render.py stills 1.2 9.6 33.2      -> build/stills/*.jpg
    python3 render.py chapters                 -> build/video.mp4
    python3 render.py cover 3.4                -> build/cover.jpg
"""
import base64, json, os, subprocess, sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent.resolve()
BUILD = HERE / "build"
O, END, FPS = 1.7, 49.0, 30            # voice offset, length, frame rate
CHAPTERS = [0, 4.48, 9.53, 18.45, 25.48, 32.23, 42.59]   # voice time of each cut
CHROME = os.environ.get("CHROME")      # optional: path to a Chrome/Chromium binary


def open_page(p):
    browser = p.chromium.launch(executable_path=CHROME) if CHROME else p.chromium.launch()
    page = browser.new_page()
    page.goto((HERE / "reel.html").as_uri())
    page.evaluate("ready()")
    words = json.loads((HERE / "words.json").read_text())
    chirp = json.loads((BUILD / "chirp.json").read_text())
    page.evaluate("([w,c,o,e])=>setup(w,c,o,e)", [words, chirp, O, END])
    return browser, page


def frame(page, t, cover=False):
    data = page.evaluate("([t,c])=>render(t,c)", [t, cover])
    return base64.b64decode(data.split(",", 1)[1])


def chapter(job):
    f0, f1, out = job
    tmp = out.with_suffix(".part.mp4")
    ff = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "image2pipe", "-framerate", str(FPS), "-c:v", "mjpeg",
                           "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
                           "-r", str(FPS), str(tmp)], stdin=subprocess.PIPE)
    with sync_playwright() as p:
        browser, page = open_page(p)
        for f in range(f0, f1):
            ff.stdin.write(frame(page, f / FPS))
        browser.close()
    ff.stdin.close()
    if ff.wait() == 0:
        tmp.replace(out)                # a stopped render never leaves a short file behind
    return out


def main(mode, args):
    BUILD.mkdir(exist_ok=True)
    if mode == "stills":
        (BUILD / "stills").mkdir(exist_ok=True)
        with sync_playwright() as p:
            browser, page = open_page(p)
            for t in map(float, args):
                (BUILD / "stills" / f"{t:05.2f}.jpg").write_bytes(frame(page, t))
            browser.close()
    elif mode == "cover":
        with sync_playwright() as p:
            browser, page = open_page(p)
            (BUILD / "cover.jpg").write_bytes(frame(page, float(args[0]) if args else 3.4, cover=True))
            browser.close()
    elif mode == "chapters":
        cuts = [round((c + O if c else 0) * FPS) for c in CHAPTERS] + [round(END * FPS)]
        jobs = [(cuts[i], cuts[i + 1], BUILD / f"chapter{i}.mp4") for i in range(len(CHAPTERS))]
        with ProcessPoolExecutor(max_workers=os.cpu_count() or 2) as pool:
            parts = list(pool.map(chapter, jobs))
        (BUILD / "chapters.txt").write_text("".join(f"file '{p.name}'\n" for p in parts))
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(BUILD / "chapters.txt"),
                        "-c", "copy", str(BUILD / "video.mp4")], check=True)
        print(BUILD / "video.mp4")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
