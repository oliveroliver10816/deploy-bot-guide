#!/usr/bin/env bash
# Package the panel for upload to ail.com.de/deploy
#
#   ./build.sh
#
# Produces dist/gitku-vN.zip containing exactly what goes in public_html/deploy/.
# (the product is called Gitku; the URL stays /deploy so his links keep working)
#
# Everything that MODIFIES the page happens here, on a COPY in dist/ — never on the
# source. An earlier version injected into the source in place and, run four times,
# produced four "Help" buttons with duplicate ids that shipped to the client.
# The source keeps <!--KB_SCREENSHOT:name--> placeholders and is never written to.
#
# SCREENSHOT CONTRACT — what the front end can rely on after a build:
#   Each <!--KB_SCREENSHOT:name--> becomes
#     <img class="kbshot" src="<440px thumbnail, inline data URI>"
#          width="440" height="276" data-shot="name" data-w="1500" data-h="940"
#          alt="Screenshot: name">
#   width/height are the thumbnail's real pixels; data-w/data-h are the full-size
#   image's. window.KB_SHOTS[name] is that full-size 1500px data URI, and arrives
#   only after kb-shots.js loads: call window.kbShotsLoad(cb) to ask for it, or
#   listen for the 'kb-shots-ready' event. The inline src is never overwritten.
# Rebuild the images with:
#   python3 test/browser/shots.py && python3 panel/shots/build_shots.py
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
API_BASE="https://deploy-bot.gitku-b93f.workers.dev"
# Bob keeps every download. Each build gets its own numbered file so his
# downloads folder stays readable and he can tell versions apart at a glance.
VERSION="$(cat "$HERE/VERSION" 2>/dev/null || echo 1)"
ZIP="gitku-v${VERSION}.zip"
SHOTS="${SHOTS_JSON:-$HERE/shots/shots.json}"
# PANEL_OUT lets a test build a throw-away copy without clobbering the shipping
# ZIP in panel/dist (v11 needs a build that KEEPS the offline demo, so it cannot
# just reuse the real one).
OUT="${PANEL_OUT:-$HERE/dist}"
STAGE="$OUT/deploy"

rm -rf "$OUT"; mkdir -p "$STAGE"

[ -s "$HERE/public/index.html" ] || { echo "public/index.html missing or empty" >&2; exit 1; }
cp "$HERE/public/index.html" "$STAGE/index.html"

python3 - "$STAGE/index.html" "$API_BASE" "$SHOTS" "$VERSION" "${PANEL_MOCK:-}" <<'PY'
import base64, json, os, re, sys
path, base, shots_path, version = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
want_mock = bool(sys.argv[5]) if len(sys.argv) > 5 else False
s = open(path, encoding="utf-8").read()

# 1. point at the live API, force the offline mock off
before = s
s = re.sub(r'(const\s+(?:API_)?BASE\s*=\s*)["\'][^"\']*["\']', r'\1"%s"' % base, s, count=1)
s = re.sub(r'(const\s+MOCK\s*=\s*)(?:true|false)',
           r'\1' + ("true" if want_mock else "false"), s, count=1)
if s == before:
    sys.exit("could not rewrite BASE / MOCK — check the markup")

# 1b. the offline demo database is dead weight in a shipped panel: with
# MOCK=false nothing can ever reach it, and it is ~40 KB of the page. It stays
# in the SOURCE (the browser suites are the reason it exists) and is cut here.
# PANEL_MOCK=1 keeps it, which is how the test preview is built.
if not want_mock:
    a = s.index("const MOCK_API=(()=>{")
    b = s.index("\n})();\n", a) + len("\n})();\n")
    cut = s[a:b]
    if len(cut) < 20000:
        sys.exit(f"the offline demo block looks wrong ({len(cut)} bytes) — refusing to cut it")
    s = s[:a] + ("const MOCK_API={handle(){throw new Error("
                 "'This build has no offline demo data.');},restore(){}};\n") + s[b:]
    # the stub itself, plus its two guarded callers: api() and enter()
    if s.count("MOCK_API") != 3:
        sys.exit(f"MOCK_API is referenced {s.count('MOCK_API')} times, expected 3 — not cutting blindly")
    print(f"  offline demo data removed: {len(cut)/1024:.1f} KB")

# 2. Knowledge-base screenshots come in TWO sizes and go to two places.
#    The small one is inlined here, so a thumbnail is on screen the instant the
#    guide opens with no network at all. The big one (1500 px, readable) lives in
#    kb-shots.js and is fetched only when the guide is first opened — inlining
#    THAT would put half a megabyte on every load, including sign-in.
raw = json.load(open(shots_path)) if os.path.exists(shots_path) else {}


def webp_size(data_uri):
    """Read width/height out of the WebP bytes themselves. The JSON says what the
    encoder was asked for; only the header says what it produced."""
    b = base64.b64decode(data_uri.split(",", 1)[1])
    if b[:4] != b"RIFF" or b[8:12] != b"WEBP":
        raise SystemExit("a screenshot is not a WebP file")
    i = 12
    while i + 8 <= len(b):
        tag, n = b[i:i + 4], int.from_bytes(b[i + 4:i + 8], "little")
        d = b[i + 8:i + 8 + n]
        if tag == b"VP8X":
            return (int.from_bytes(d[4:7], "little") + 1,
                    int.from_bytes(d[7:10], "little") + 1)
        if tag == b"VP8 ":
            return (int.from_bytes(d[6:8], "little") & 0x3FFF,
                    int.from_bytes(d[8:10], "little") & 0x3FFF)
        if tag == b"VP8L":
            v = int.from_bytes(d[1:5], "little")
            return ((v & 0x3FFF) + 1, ((v >> 14) & 0x3FFF) + 1)
        i += 8 + n + (n & 1)
    raise SystemExit("no image chunk in a screenshot")


# Both file shapes are accepted: the two-tier {thumb, full, w, h, tw, th} written
# by shots/build_shots.py, and the older flat {name: dataURI}. An old file must
# still build — it just cannot offer an enlarged view.
shots, two_tier = {}, 0
for name, v in raw.items():
    if isinstance(v, dict):
        two_tier += 1
        tw, th = webp_size(v["thumb"])
        w, h = webp_size(v["full"])
        for label, said, got in (("tw", v.get("tw"), tw), ("th", v.get("th"), th),
                                 ("w", v.get("w"), w), ("h", v.get("h"), h)):
            if said is not None and said != got:
                sys.exit(f"{name}: shots.json says {label}={said}, the image header "
                         f"says {got} — rebuild with shots/build_shots.py")
        shots[name] = {"thumb": v["thumb"], "full": v["full"],
                       "w": w, "h": h, "tw": tw, "th": th}
    else:
        w, h = webp_size(v)
        shots[name] = {"thumb": None, "full": v, "w": w, "h": h, "tw": w, "th": h}
print("  shots.json shape: " + (
    f"two-tier (thumb+full), {two_tier}/{len(raw)} entries" if two_tier == len(raw) and raw
    else f"legacy flat (one size only), {len(raw) - two_tier}/{len(raw)} entries"
    if raw else "no file — screenshots skipped"))

# NB: [-] is inside the class, so a greedy match swallows the closing "--".
wanted = re.findall(r'<!--KB_SCREENSHOT:(.+?)-->', s)
missing = [w for w in wanted if w not in shots]
inline_bytes = 0
for name in set(wanted):
    tag = ''
    sh = shots.get(name)
    if sh and sh["thumb"]:
        # width/height are REQUIRED: they reserve the space, so opening the guide
        # does not reflow every chapter as the images land.
        tag = (f'<img class="kbshot" src="{sh["thumb"]}" '
               f'width="{sh["tw"]}" height="{sh["th"]}" data-shot="{name}" '
               f'data-w="{sh["w"]}" data-h="{sh["h"]}" alt="Screenshot: {name}">')
        inline_bytes += len(sh["thumb"])
    elif sh:
        # legacy file: nothing small enough to inline, so the loader fills it in
        tag = (f'<img class="kbshot" loading="lazy" width="{sh["tw"]}" '
               f'height="{sh["th"]}" data-shot="{name}" data-w="{sh["w"]}" '
               f'data-h="{sh["h"]}" alt="Screenshot: {name}">')
    s = s.replace(f'<!--KB_SCREENSHOT:{name}-->', tag)

LOADER = """
<script>
/* The full-size knowledge-base screenshots load on demand: they cannot be looked
   at before a click, so nothing is fetched during sign-in or on the deploy screen.
   The small inline thumbnails are already in the markup and are never replaced —
   an image that arrived with the page must not be swapped for a network one. */
(function(){
  var started=false, shots=null, waiting=[];
  function apply(){
    if(!shots) return;
    /* Only fills images that have NO src of their own. With a two-tier
       shots.json every thumbnail is inline, so this touches nothing; with an
       older one-size file it is the only way the picture ever appears. */
    var imgs=document.querySelectorAll('img[data-shot]:not([data-shot-done])');
    for(var i=0;i<imgs.length;i++){
      var im=imgs[i], d=shots[im.getAttribute('data-shot')];
      if(d && !im.getAttribute('src')) im.src=d;
      im.setAttribute('data-shot-done','1');
    }
    while(waiting.length) try{ waiting.shift()(shots); }catch(e){}
  }
  function load(cb){
    if(cb) waiting.push(cb);
    if(shots){ apply(); return; }
    if(started) return;
    started=true;
    var sc=document.createElement('script');
    sc.src='kb-shots.js';
    sc.onload=function(){
      shots=window.KB_SHOTS||{};
      apply();
      try{ window.dispatchEvent(new Event('kb-shots-ready')); }catch(e){}
    };
    sc.onerror=function(){
      /* Tell everyone who is waiting that it is not coming. Leaving them queued
         meant a hover could only escape through its own timeout, so a missing
         kb-shots.js showed a spinner for six seconds on EVERY hover. Note we do
         NOT cache an empty result: a later attempt is still allowed to succeed. */
      started=false;
      var q=waiting; waiting=[];
      for(var i=0;i<q.length;i++){ try{ q[i](null); }catch(e){} }
    };
    document.head.appendChild(sc);
  }
  /* Anything that wants the big version (a hover-to-enlarge, say) can ask for it
     directly instead of waiting for the click handler below. */
  window.kbShotsLoad=load;
  function need(){ return !!document.querySelector('img[data-shot]'); }
  document.addEventListener('click', function(){ setTimeout(function(){ if(need()) load(); }, 50); }, true);
  document.addEventListener('pointerover', function(e){
    var t=e.target;
    if(t && t.nodeType===1 && t.hasAttribute && t.hasAttribute('data-shot')) load();
  }, true);
})();
</script>
"""
if wanted:
    # The LAST </body>, never the first: the offline mock embeds a sample HTML
    # document as a string, so an early </body> lives inside JavaScript and
    # injecting there closes the real script block and breaks the whole page.
    k = s.rindex("</body>")
    s = s[:k] + LOADER + s[k:]

# 2b. refuse to ship an UNBALANCED STYLESHEET.
#     v29 shipped `@media (max-width:900px){.ro-when{display:none}` with no
#     closing brace, which silently swallowed the next nine rules into the
#     mobile query — so the whole new fold control had NO styling on his 34"
#     monitor and drew as a raw grey OS button. Nothing caught it: the page
#     parsed, the JS ran, and every behavioural test passed.
_bad = []
for _m in re.finditer(r"<style[^>]*>(.*?)</style>", s, re.S):
    _css = re.sub(r"/\*.*?\*/", "", _m.group(1), flags=re.S)
    _d = 0
    for _ch in _css:
        if _ch == "{": _d += 1
        elif _ch == "}":
            _d -= 1
            if _d < 0: _bad.append("a stray closing brace"); _d = 0
    if _d: _bad.append(f"{_d} unclosed block(s)")
if _bad:
    sys.exit("  stylesheet is UNBALANCED: " + ", ".join(_bad))
print("  stylesheet braces: balanced")

# 3. refuse to ship duplicate ids — this is exactly what went wrong before
# An id written as a bare `${...}` cannot be judged from the text: the same
# template can legitimately appear in several mutually exclusive branches of one
# helper and still resolve to different ids. Those are asserted in the BROWSER
# instead (test/browser/v8.py walks every view and fails on a runtime duplicate).
ids = [i for i in re.findall(r'\sid="([^"]+)"', s) if "${" not in i]
dupes = sorted({i for i in ids if ids.count(i) > 1})
if dupes:
    sys.exit(f"duplicate element ids in the page: {dupes}")

# stamp the version so a page can always be identified after upload
if s.lstrip().lower().startswith("<!doctype"):
    k = s.lower().index("<!doctype")
    e = s.index(">", k) + 1
    s = s[:e] + f"\n<!-- deploy panel v{version} -->" + s[e:]
s = re.sub(r'(<title>)([^<]*)(</title>)', r'\1\2\3', s, count=1)

open(path, "w", encoding="utf-8").write(s)
print(f"  version: v{version}")
print(f"  screenshots embedded: {len(set(wanted)) - len(set(missing))}/{len(set(wanted))}")
if missing:
    print(f"  ! placeholders with no image: {sorted(set(missing))}")
print(f"  inline thumbnails in index.html: {inline_bytes/1024:.1f} KB")
print(f"  duplicate ids: none")
PY

python3 - "$SHOTS" "$STAGE/kb-shots.js" <<'PY2'
import json, os, sys
src, dst = sys.argv[1], sys.argv[2]
raw = json.load(open(src)) if os.path.exists(src) else {}
# ONLY the full-size images. The thumbnails are already inline in index.html;
# shipping them again here would pay for every one of them twice.
shots = {k: (v["full"] if isinstance(v, dict) else v) for k, v in raw.items()}
payload = sum(len(v) for v in shots.values())
open(dst, "w", encoding="utf-8").write("window.KB_SHOTS=" + json.dumps(shots) + ";")
print(f"  kb-shots.js: {os.path.getsize(dst)/1024:.1f} KB "
      f"({payload/1024:.1f} KB of images, {len(shots)} full-size), "
      f"loaded only when the guide is opened")
PY2

cat > "$STAGE/robots.txt" <<'EOF'
User-agent: *
Disallow: /
EOF

cat > "$STAGE/.htaccess" <<'EOF'
# Never index this panel.
<IfModule mod_headers.c>
  Header set X-Robots-Tag "noindex, nofollow, noarchive"
  Header set X-Frame-Options "DENY"
  Header set X-Content-Type-Options "nosniff"
  Header set Referrer-Policy "no-referrer"
</IfModule>
Options -Indexes

# Compress the page. It is one self-contained file, so this is the single
# biggest thing the host can do for how fast the panel opens: ~276 KB of
# markup and script becomes ~76 KB on the wire.
<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/plain text/css text/javascript
  AddOutputFilterByType DEFLATE application/javascript application/x-javascript
  AddOutputFilterByType DEFLATE image/svg+xml application/json
</IfModule>
<IfModule mod_brotli.c>
  AddOutputFilterByType BROTLI_COMPRESS text/html text/css text/javascript
  AddOutputFilterByType BROTLI_COMPRESS application/javascript application/json
</IfModule>

<IfModule mod_expires.c>
  ExpiresActive On
  # The page must never be stale — a new upload has to take effect at once.
  ExpiresByType text/html "access plus 0 seconds"
  # The knowledge-base screenshots never change within a version, and they are
  # the bulk of the bytes. Let the browser keep them.
  ExpiresByType application/javascript "access plus 7 days"
</IfModule>
EOF

cat > "$STAGE/README.txt" <<'EOF'
GITKU — what to do with this folder
===================================
(version is in the folder name and in the first line of index.html)

1. Unzip it.
2. Upload the CONTENTS of the "deploy" folder into  public_html/deploy/
   (so the page ends up at  https://ail.com.de/deploy/ )
   Include the hidden .htaccess file. In cPanel File Manager:
   Settings -> tick "Show Hidden Files" first, or it will be skipped.
3. Open  https://ail.com.de/deploy/  and sign in.

No database, no PHP, nothing to edit.

FIRST TIME IN
-------------
Sign in as the owner account, open "Accounts & keys" in the left rail, and paste:
  - your GitHub token   (Contents: Read and write. Add Administration: Read and write
                         and set it to All repositories, so Gitku can make repos for you)
  - your Heroku API key (dashboard.heroku.com -> Account settings -> API Key -> Reveal)
Pair one GitHub account with one Heroku account and your apps appear on their own.
"New site" then makes a whole site - repo, app and the link between them - from one name.
The Guide in the left rail explains every step with pictures.

NOTHING SECRET IS IN THESE FILES
--------------------------------
Your tokens are stored on the backend, never in this page.
EOF

cd "$OUT"
zip -qr "$ZIP" deploy
cd - >/dev/null

echo "Built: $OUT/$ZIP"
unzip -l "$OUT/$ZIP" | sed 's/^/  /'
echo "md5: $(md5sum "$OUT/$ZIP" | cut -d' ' -f1)"
echo
echo "Next build: bump panel/VERSION to $((VERSION + 1))"
