"""Shared harness for the browser suites: build the MOCK page from source,
serve it, hand back a base URL. Lives in the repo on purpose — an earlier set of
these suites was written in a scratch directory and was lost when it was wiped."""
import http.server, os, socketserver, tempfile, threading

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "panel", "public", "index.html")

def serve_mock(port):
    src = open(os.path.abspath(SRC), encoding="utf-8").read()
    assert "const MOCK=false;" in src, "source no longer carries the MOCK switch"
    work = tempfile.mkdtemp(prefix="gitku-mock-")
    open(os.path.join(work, "index.html"), "w", encoding="utf-8").write(
        src.replace("const MOCK=false;", "const MOCK=true;", 1))
    os.chdir(work)
    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.TCPServer(("127.0.0.1", port), Q)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{port}/", srv

class Run:
    def __init__(self): self.passed = self.failed = 0
    def ok(self, cond, name, extra=""):
        if cond: self.passed += 1; print(f"  ✓ {name}")
        else: self.failed += 1; print(f"  ✗ {name}  {extra}")
    def done(self, label):
        print(f"\n{'✅' if self.failed==0 else '❌'} {label}: {self.passed} passed, {self.failed} failed\n")
        return 0 if self.failed == 0 else 1

def wait_for(pg, fn, timeout=9000, step=70):
    import time
    end = time.time() + timeout/1000
    while time.time() < end:
        try:
            if fn(): return True
        except Exception: pass
        pg.wait_for_timeout(step)
    return False

def signin(pg, base, who="owner"):
    pg.goto(base)
    pg.fill("#loginForm input[name=username]", who)
    pg.fill("#loginForm input[name=password]", "x")
    pg.click("#loginBtn")
    pg.wait_for_selector("#shell:not([hidden])", timeout=20000)
    pg.wait_for_timeout(2000)


def mock_page():
    """Write the CURRENT source as a MOCK page and return its path.

    ⚠️ Every file:// suite used to default to a page frozen in a scratch
    directory. It was five days old and still reported green — so those runs
    proved nothing about the build being shipped. Build from source, always.
    """
    src = open(os.path.abspath(SRC), encoding="utf-8").read()
    assert "const MOCK=false;" in src, "source no longer carries the MOCK switch"
    work = tempfile.mkdtemp(prefix="gitku-page-")
    out = os.path.join(work, "index.html")
    open(out, "w", encoding="utf-8").write(src.replace("const MOCK=false;", "const MOCK=true;", 1))
    return out


def real_page():
    """The page with MOCK left OFF — for checks that must reach real fetch().

    ⚠️ v8 §7 used to look for this beside a scratch file and SKIP ITSELF when it
    was not there. A check that quietly skips is not a check.
    """
    src = open(os.path.abspath(SRC), encoding="utf-8").read()
    work = tempfile.mkdtemp(prefix="gitku-real-")
    out = os.path.join(work, "index.html")
    open(out, "w", encoding="utf-8").write(src)
    return out
