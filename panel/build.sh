#!/usr/bin/env bash
# Package the panel for upload to ail.com.de/deploy
#
#   ./build.sh
#
# Produces dist/deploy-panel.zip containing exactly what goes in public_html/deploy/.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
API_BASE="https://deploy-bot.fleet-fefsba.workers.dev"
OUT="$HERE/dist"
STAGE="$OUT/deploy"

rm -rf "$OUT"; mkdir -p "$STAGE"

if [ ! -s "$HERE/public/index.html" ]; then
  echo "public/index.html is missing or empty — nothing to package." >&2
  exit 1
fi

cp "$HERE/public/index.html" "$STAGE/index.html"

# Point the page at the live API and make sure the offline mock is off.
python3 - "$STAGE/index.html" "$API_BASE" <<'PY'
import re, sys
path, base = sys.argv[1], sys.argv[2]
s = open(path, encoding="utf-8").read()
before = s
s = re.sub(r'(const\s+(?:API_)?BASE\s*=\s*)["\'][^"\']*["\']', r'\1"%s"' % base, s, count=1)
s = re.sub(r'(const\s+MOCK\s*=\s*)(?:true|false)', r'\1false', s, count=1)
if s == before:
    print("  ! WARNING: could not find API_BASE / MOCK to rewrite — check the markup", file=sys.stderr)
open(path, "w", encoding="utf-8").write(s)
PY

# Keep it out of search engines even if the URL leaks. The login is the real lock.
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

# No directory listing.
Options -Indexes

# The page is one file; let the browser cache it briefly but always revalidate.
<IfModule mod_expires.c>
  ExpiresActive On
  ExpiresByType text/html "access plus 0 seconds"
</IfModule>
EOF

cat > "$STAGE/README.txt" <<'EOF'
DEPLOY PANEL — what to do with this folder
==========================================

1. Unzip it.
2. Upload the CONTENTS of the "deploy" folder into your site's  public_html/deploy/
   (so the page ends up at  https://ail.com.de/deploy/ )
   Include the hidden .htaccess file. In cPanel File Manager:
   Settings -> tick "Show Hidden Files" first, or it will be skipped.
3. Open  https://ail.com.de/deploy/  and sign in.

That is the whole install. No database, no PHP, no settings to edit.

FIRST TIME IN
-------------
Sign in as the master account, open Settings, and paste:
  - your GitHub token   (Contents: Read and write. Add Administration: Read and write
                         and set it to All repositories if you want the "create repo" button)
  - your Heroku API key (dashboard.heroku.com -> Account settings -> API Key -> Reveal)
Then add your sites: pick the repo, give it the domain name you want to see,
and set the folder files should land in. Link each one to its Heroku app.

NOTHING SECRET IS IN THESE FILES
--------------------------------
Your tokens are stored on the backend, never in this page. Anyone who downloads
every file here gets an empty shell.

IF THE PAGE LOADS BUT NOTHING WORKS
-----------------------------------
It is almost always the address. The backend only accepts requests coming from
https://ail.com.de — if you put the panel on a different domain, say so and it
takes one minute to allow.
EOF

cd "$OUT"
zip -qr deploy-panel.zip deploy
cd - >/dev/null

echo "Built: $OUT/deploy-panel.zip"
ls -la "$OUT/deploy-panel.zip"
echo
echo "Contents:"
unzip -l "$OUT/deploy-panel.zip" | sed 's/^/  /'
echo
echo "md5: $(md5sum "$OUT/deploy-panel.zip" | cut -d' ' -f1)"
