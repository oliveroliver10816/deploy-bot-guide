#!/usr/bin/env python3
"""Turn the native PNG captures into the two-tier shots.json the panel needs.

    python3 panel/shots/build_shots.py [pngdir] [out.json]

One image cannot do both jobs. A screenshot small enough to inline on every page
load is far too small to read, and one big enough to read is far too heavy to
inline. So every shot is emitted TWICE:

  thumb  ~440 px wide, squeezed under a per-image and a whole-set budget.
         These are inlined in index.html, so they need no network at all and are
         on screen the moment the guide opens.
  full   1500 px wide (above 720p), quality ~80. These live in kb-shots.js and
         are fetched only when the guide is first opened.

Encoder: Pillow's libwebp binding. cwebp is NOT installed on this box and
ImageMagick's WebP delegate gives no per-image size control, so quality is
searched here instead — encode, measure the real bytes, step down, repeat.
Every recorded w/h is read back out of the encoded file, never assumed.
"""
import io, json, os, sys

try:
    from PIL import Image, features
except ImportError:                                             # pragma: no cover
    sys.exit("Pillow is required (python3 -c 'import PIL') — install it or "
             "point this at another encoder")
if not features.check("webp"):                                  # pragma: no cover
    sys.exit("this Pillow has no WebP support")

HERE = os.path.dirname(os.path.abspath(__file__))
PNGDIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "png")
OUTJSON = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "shots.json")

NAMES = ["01-login", "02-sites", "05-filechosen", "06-confirm",
         "08-done", "09-keys", "11-addsite", "12-people"]

FULL_W = 1500          # above 720p, and an exact 2:1 halving of the 3000 px capture
FULL_Q = 80
THUMB_W = 440
# The budgets are measured on the DATA URI, not the raw WebP, because the data
# URI is what is actually pasted into index.html — base64 is ~4/3 of the bytes
# and measuring the binary would quietly ship a third more than the budget says.
THUMB_MAX = 6 * 1024   # per thumbnail, as shipped
SET_MAX = 55 * 1024    # every thumbnail together, since they all ship inline


def load_flat(path):
    """Screenshots have no meaningful transparency; flatten so WebP stores 3 channels."""
    im = Image.open(path)
    im.load()
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.split()[-1])
        return bg
    return im.convert("RGB")


def resize_to_width(im, w):
    if im.width <= w:
        return im.copy()          # never upscale: it adds bytes and no detail
    h = max(1, round(im.height * w / im.width))
    return im.resize((w, h), Image.LANCZOS)


def encode(im, quality):
    buf = io.BytesIO()
    im.save(buf, format="WEBP", quality=quality, method=6)
    return buf.getvalue()


def data_uri(b):
    import base64
    return "data:image/webp;base64," + base64.b64encode(b).decode("ascii")


def encode_under(im, limit):
    """Highest quality whose REAL shipped size (the data URI) fits the limit."""
    best = None
    for q in range(90, 4, -5):
        b = encode(im, q)
        if len(data_uri(b)) <= limit:
            return b, q
        best = (b, q)
    return best                    # nothing fit; caller reports it


def real_size(b):
    """Read the dimensions back out of the encoded bytes — a WebP header says what
    it is, and the encoder's arguments are not evidence."""
    with Image.open(io.BytesIO(b)) as im:
        if im.format != "WEBP":
            raise SystemExit("encoder did not produce WebP")
        return im.size


def main():
    missing = [n for n in NAMES if not os.path.exists(os.path.join(PNGDIR, n + ".png"))]
    if missing:
        sys.exit(f"no capture for {missing} in {PNGDIR} — run test/browser/shots.py first")

    out, rows = {}, []
    thumb_total = full_total = thumb_raw = full_raw = 0
    for n in NAMES:
        src = load_flat(os.path.join(PNGDIR, n + ".png"))
        full_b = encode(resize_to_width(src, FULL_W), FULL_Q)
        thumb_im = resize_to_width(src, THUMB_W)
        thumb_b, tq = encode_under(thumb_im, THUMB_MAX)

        fw, fh = real_size(full_b)
        tw, th = real_size(thumb_b)
        tu, fu = data_uri(thumb_b), data_uri(full_b)
        out[n] = {"thumb": tu, "full": fu, "w": fw, "h": fh, "tw": tw, "th": th}
        thumb_total += len(tu); full_total += len(fu)
        thumb_raw += len(thumb_b); full_raw += len(full_b)
        rows.append((n, src.size, (tw, th), len(tu), tq, (fw, fh), len(fu)))

    print(f"  encoder: Pillow {Image.__version__} / libwebp {features.version('webp')}"
          f" (cwebp not installed)")
    print(f"  {'shot':16} {'capture':>11}  {'thumb':>9} {'KB':>6} {'q':>3}   "
          f"{'full':>10} {'KB':>7}      (KB = as shipped, base64)")
    for n, cap, t, tb, tq, f, fb in rows:
        flag = "" if tb <= THUMB_MAX else "  ! over per-image budget"
        print(f"  {n:16} {cap[0]}x{cap[1]:<5}  {t[0]}x{t[1]:<4} {tb/1024:6.1f} {tq:3}   "
              f"{f[0]}x{f[1]:<5} {fb/1024:7.1f}{flag}")
    print(f"  inline thumbnails: {thumb_total/1024:.1f} KB shipped "
          f"({thumb_raw/1024:.1f} KB of WebP) — budget {SET_MAX/1024:.0f} KB")
    print(f"  full images:       {full_total/1024:.1f} KB shipped "
          f"({full_raw/1024:.1f} KB of WebP), fetched only when the guide opens")

    bad = [r[0] for r in rows if r[3] > THUMB_MAX]
    if bad:
        sys.exit(f"thumbnails over {THUMB_MAX/1024:.0f} KB: {bad}")
    if thumb_total > SET_MAX:
        sys.exit(f"inline set is {thumb_total/1024:.1f} KB, over the "
                 f"{SET_MAX/1024:.0f} KB budget")

    with open(OUTJSON, "w", encoding="utf-8") as fh:
        json.dump(out, fh)
    print(f"  wrote {OUTJSON} ({os.path.getsize(OUTJSON)/1024:.0f} KB, "
          f"{len(out)} shots, keys: thumb/full/w/h/tw/th)")


if __name__ == "__main__":
    main()
