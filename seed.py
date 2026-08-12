#!/usr/bin/env python3
"""
Load a GitHub or Heroku credential straight into the bot's database, without
needing the bot to exist yet.

Why this exists: the normal route is /connect inside Telegram, but that needs a
live bot, and the bot needs a BotFather token. This breaks the ordering so the
API keys can be loaded first and the only remaining step is creating the bot.

    ./seed.py github ghp_xxxxxxxx
    ./seed.py heroku HRKU-xxxxxxxx
    ./seed.py list

The token is verified against the real API before it is stored and is never
printed. It is passed to wrangler in a temp FILE, so it never appears in the
wrangler process's argument list. Omit the token argument to be prompted for it
hidden, which also keeps it out of this process's argv and your shell history.
"""
import json, os, subprocess, sys, tempfile, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
WRANGLER_CFG = os.path.join(HERE, "worker", "wrangler.json")
CF = "/root/.config/cloudflare/osanix-fleetview.json"


def cf_env():
    c = json.load(open(CF))
    e = dict(os.environ)
    e["CLOUDFLARE_API_KEY"] = c["api_key"]
    e["CLOUDFLARE_EMAIL"] = c["email"]
    return e


def _run(cmd):
    r = subprocess.run(cmd, env=cf_env(), capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"D1 failed:\n{r.stderr[-1500:]}")
    return r.stdout


def d1_write(sql):
    """Writes go through a file so a token containing shell metacharacters is
    never interpreted by a shell or logged in a process list."""
    fd, path = tempfile.mkstemp(suffix=".sql")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(sql)
        _run(["wrangler", "d1", "execute", "deploy_bot", "--remote",
              "--config", WRANGLER_CFG, "--file", path, "-y"])
    finally:
        os.unlink(path)


def d1_read(sql):
    """Reads MUST use --command. Wrangler's --file mode returns only a summary
    ("Total queries executed"), never the selected rows, which reads exactly
    like an empty table."""
    out = _run(["wrangler", "d1", "execute", "deploy_bot", "--remote",
                "--config", WRANGLER_CFG, "--command", sql, "--json"])
    i = out.find("[")  # wrangler prints progress lines before the JSON
    if i < 0:
        sys.exit(f"Unexpected wrangler output:\n{out[:500]}")
    return json.loads(out[i:])[0]["results"]


def api(url, token, kind):
    req = urllib.request.Request(url)
    if kind == "github":
        req.add_header("Authorization", f"Bearer {token}")
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("User-Agent", "deploy-bot")
    else:
        req.add_header("Authorization", f"Bearer {token}")
        req.add_header("Accept", "application/vnd.heroku+json; version=3")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"{kind} rejected that credential (HTTP {e.code}). Nothing was stored.")


def q(s):
    return "'" + str(s).replace("'", "''") + "'"


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("github", "heroku", "list"):
        sys.exit(__doc__)

    if sys.argv[1] == "list":
        rows = d1_read("SELECT kind, account, created_at FROM connections ORDER BY kind;")
        if not rows:
            print("  no accounts connected yet")
        for r in rows:
            print(f"  {r['kind']:7} {r['account']}   (added {r['created_at'][:19]})")
        repos = d1_read("SELECT label, owner, name, branch FROM repos ORDER BY label;")
        if not repos:
            print("  no repos registered yet")
        for r in repos:
            print(f"  repo    {r['label']}  ->  {r['owner']}/{r['name']} @ {r['branch']}")
        apps = d1_read("SELECT label, heroku_name, repo_id FROM apps ORDER BY label;")
        if not apps:
            print("  no Heroku apps registered yet")
        for r in apps:
            link = f"repo #{r['repo_id']}" if r["repo_id"] else "NOT LINKED"
            print(f"  app     {r['label']}  ->  {link}")
        users = d1_read("SELECT telegram_id, name, role FROM users ORDER BY role;")
        for r in users:
            print(f"  user    {r['name']} ({r['telegram_id']}) — {r['role']}")
        return

    kind = sys.argv[1]
    token = sys.argv[2] if len(sys.argv) > 2 else ""
    if not token:
        try:
            import getpass
            token = getpass.getpass(f"Paste the {kind} token (hidden): ").strip()
        except Exception:
            sys.exit("No token given.")
    if not token:
        sys.exit("No token given.")

    if kind == "github":
        who = api("https://api.github.com/user", token, kind)["login"]
    else:
        who = api("https://api.heroku.com/account", token, kind)["email"]

    d1_write(
        "INSERT INTO connections (kind, label, token, account, created_at) VALUES "
        f"({q(kind)}, {q(who)}, {q(token)}, {q(who)}, datetime('now')) "
        "ON CONFLICT (kind, label) DO UPDATE SET token=excluded.token, account=excluded.account;"
    )
    print(f"Stored {kind} account: {who}")
    print("Next: create the bot, run ./setup.sh <bot-token>, then /addrepo and /addapp in Telegram.")


if __name__ == "__main__":
    main()
