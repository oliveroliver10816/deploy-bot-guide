#!/usr/bin/env bash
# Package the panel for upload to ail.com.de/deploy
#
#   ./build.sh
#
# Produces dist/deploy-panel.zip containing exactly what goes in public_html/deploy/.
#
# Everything that MODIFIES the page happens here, on a COPY in dist/ — never on the
# source. An earlier version injected into the source in place and, run four times,
# produced four "Help" buttons with duplicate ids that shipped to the client.
# The source keeps <!--KB_SCREENSHOT:name--> placeholders and is never written to.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
API_BASE="https://deploy-bot.fleet-fefsba.workers.dev"
# Bob keeps every download. Each build gets its own numbered file so his
# downloads folder stays readable and he can tell versions apart at a glance.
VERSION="$(cat "$HERE/VERSION" 2>/dev/null || echo 1)"
ZIP="deploy-panel-v${VERSION}.zip"
SHOTS="${SHOTS_JSON:-$HERE/shots/shots.json}"
OUT="$HERE/dist"
STAGE="$OUT/deploy"

rm -rf "$OUT"; mkdir -p "$STAGE"

[ -s "$HERE/public/index.html" ] || { echo "public/index.html missing or empty" >&2; exit 1; }
cp "$HERE/public/index.html" "$STAGE/index.html"

python3 - "$STAGE/index.html" "$API_BASE" "$SHOTS" "$VERSION" <<'PY'
import json, os, re, sys
path, base, shots_path, version = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
s = open(path, encoding="utf-8").read()

# 1. point at the live API, force the offline mock off
before = s
s = re.sub(r'(const\s+(?:API_)?BASE\s*=\s*)["\'][^"\']*["\']', r'\1"%s"' % base, s, count=1)
s = re.sub(r'(const\s+MOCK\s*=\s*)(?:true|false)', r'\1false', s, count=1)
if s == before:
    sys.exit("could not rewrite BASE / MOCK — check the markup")

# 2. swap knowledge-base screenshot placeholders for embedded images
shots = json.load(open(shots_path)) if os.path.exists(shots_path) else {}
# NB: [-] is inside the class, so a greedy match swallows the closing "--".
wanted = re.findall(r'<!--KB_SCREENSHOT:(.+?)-->', s)
missing = [w for w in wanted if w not in shots]
for name in set(wanted):
    tag = (f'<img class="kbshot" loading="lazy" alt="Screenshot: {name}" src="{shots[name]}">'
           if name in shots else '')
    s = s.replace(f'<!--KB_SCREENSHOT:{name}-->', tag)

# 3. refuse to ship duplicate ids — this is exactly what went wrong before
ids = re.findall(r'\sid="([^"]+)"', s)
dupes = sorted({i for i in ids if ids.count(i) > 1})
if dupes:
    sys.exit(f"duplicate element ids in the page: {dupes}")

# stamp the version so a page can always be identified after upload
s = s.replace("<!doctype html>", f"<!doctype html>\n<!-- deploy panel v{version} -->", 1)
s = re.sub(r'(<title>)([^<]*)(</title>)', r'\1\2\3', s, count=1)

open(path, "w", encoding="utf-8").write(s)
print(f"  version: v{version}")
print(f"  screenshots embedded: {len(set(wanted)) - len(set(missing))}/{len(set(wanted))}")
if missing:
    print(f"  ! placeholders with no image: {sorted(set(missing))}")
print(f"  duplicate ids: none")
PY

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
<IfModule mod_expires.c>
  ExpiresActive On
  ExpiresByType text/html "access plus 0 seconds"
</IfModule>
EOF

cat > "$STAGE/README.txt" <<'EOF'
DEPLOY PANEL — what to do with this folder
==========================================
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
Sign in as the master account, open Settings, and paste:
  - your GitHub token   (Contents: Read and write. Add Administration: Read and write
                         and set it to All repositories for the "create repo" button)
  - your Heroku API key (dashboard.heroku.com -> Account settings -> API Key -> Reveal)
Then add your sites and link each one to its Heroku app.
The Help section in the panel explains every step with pictures.

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
