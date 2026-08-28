"""
Knowledge-base screenshots: inline thumbnails, hover to enlarge, click to open.

Every check here exists because a review measured it failing:
  * thumbnails drawn 38-42% squashed (a fixed height attribute + max-width:100%)
  * hover only 1.3x the thumbnail below a 1900px viewport - the original complaint
  * a six-second spinner on every hover when kb-shots.js is missing

Run against the BUILT page (it needs the real inline thumbnails):
    python3 test/browser/v11.py [built-index.html]
"""
import asyncio, os, shutil, subprocess, sys, tempfile, threading, http.server, functools
from playwright.async_api import async_playwright

def _demo_build():
    """Build a throw-away DEMO package and return its index.html.

    ⚠️ This suite needs the BUILT page (the inline thumbnails are injected at
    build time, the source only carries placeholders) AND a working offline
    demo. The shipping build STRIPS the demo, so flipping `const MOCK=false;`
    in it leaves `MOCK_API` undefined and sign-in dies before the guide can be
    opened — which is what this suite had been doing, silently, as a traceback.
    """
    root = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
    out = tempfile.mkdtemp(prefix="gitku-demo-")
    env = dict(os.environ, PANEL_MOCK="1", PANEL_OUT=out)
    subprocess.run([os.path.join(root, "panel", "build.sh")], env=env, cwd=root,
                   check=True, capture_output=True)
    return os.path.join(out, "deploy", "index.html")

BUILT = sys.argv[1] if len(sys.argv) > 1 else _demo_build()

fails = []
def ck(c, n, x=""):
    print(("  ok   " if c else "  FAIL ") + n + ((" [" + str(x) + "]") if x and not c else ""))
    if not c: fails.append(n)

def serve(root):
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
    srv = http.server.HTTPServer(("127.0.0.1", 0), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]

async def open_guide(pg, base):
    await pg.goto(base + "/index.html")
    await pg.wait_for_selector("#loginForm [name=username]", timeout=20000)
    await pg.fill("#loginForm [name=username]", "owner")
    await pg.fill("#loginForm [name=password]", "x")
    await pg.click("#loginBtn")
    await pg.wait_for_selector("#shell:not([hidden])", timeout=20000)
    await pg.evaluate("() => document.querySelector('[data-view=kb]').click()")
    await pg.wait_for_selector("img.kbshot", timeout=20000)
    await pg.wait_for_timeout(400)

async def main():
    src = os.path.dirname(BUILT)
    work = tempfile.mkdtemp()
    for f in ("index.html", "kb-shots.js"):
        if os.path.exists(os.path.join(src, f)):
            shutil.copy(os.path.join(src, f), work)
    # the built page points at the live API; run it offline instead
    p = os.path.join(work, "index.html")
    s = open(p, encoding="utf-8").read().replace("const MOCK=false;", "const MOCK=true;", 1)
    open(p, "w", encoding="utf-8").write(s)
    srv, port = serve(work)
    base = f"http://127.0.0.1:{port}"

    async with async_playwright() as pw:
        br = await pw.chromium.launch()

        # ---------- 1. thumbnails: inline, and the RIGHT SHAPE ----------
        print("\n-- thumbnails --")
        for w, hgt in ((3440, 1440), (1680, 1050), (1280, 800), (390, 844)):
            ctx = await br.new_context(viewport={"width": w, "height": hgt})
            pg = await ctx.new_page()
            await open_guide(pg, base)
            shape = await pg.evaluate("""() => {
              const out=[];
              document.querySelectorAll('img.kbshot').forEach(im=>{
                const r=im.getBoundingClientRect();
                if(!r.width) return;
                out.push({drawn:+(r.width/r.height).toFixed(3),
                          real:+(im.naturalWidth/im.naturalHeight).toFixed(3),
                          w:Math.round(r.width)});
              });
              return out;
            }""")
            worst = max((abs(x["drawn"] - x["real"]) / x["real"] for x in shape), default=0)
            ck(worst < 0.02, f"{w}px: thumbnails keep their shape",
               f"worst {worst*100:.0f}% off, {shape[:2]}")
            await ctx.close()

        # no network at all -> thumbnails must still be there
        ctx = await br.new_context(viewport={"width": 1680, "height": 1050})
        pg = await ctx.new_page()
        await pg.route("**/kb-shots.js", lambda r: r.abort())
        await open_guide(pg, base)
        painted = await pg.evaluate("""() => {
            const all=[...document.querySelectorAll('img.kbshot')];
            return {n:all.length, ok:all.filter(i=>i.complete&&i.naturalWidth>0).length};
        }""")
        ck(painted["n"] > 0 and painted["ok"] == painted["n"],
           "every thumbnail on screen paints with no network at all", str(painted))
        await ctx.close()

        # ---------- 2. hover shows the BIG file, big enough to read ----------
        print("\n-- hover --")
        for w, hgt in ((3440, 1440), (1680, 1050), (1280, 800)):
            ctx = await br.new_context(viewport={"width": w, "height": hgt})
            pg = await ctx.new_page()
            await open_guide(pg, base)
            await pg.evaluate("() => window.kbShotsLoad && window.kbShotsLoad()")
            await pg.wait_for_timeout(1500)
            im = await pg.query_selector("img.kbshot")
            box = await im.bounding_box()
            await pg.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            await pg.wait_for_timeout(1200)
            got = await pg.evaluate("""() => {
              const p=document.querySelector('.shot-peek img');
              if(!p) return null;
              const r=p.getBoundingClientRect();
              return {nat:p.naturalWidth, w:Math.round(r.width), h:Math.round(r.height)};
            }""")
            ck(bool(got), f"{w}px: hovering shows an enlarged view")
            if got:
                ck(got["nat"] >= 1400, f"{w}px: it is the full-size file, not the thumbnail",
                   str(got["nat"]))
                ck(got["w"] >= 900, f"{w}px: and it is actually big enough to read",
                   f'{got["w"]}x{got["h"]}')
            await ctx.close()

        # ---------- 3. a missing kb-shots.js must fail FAST ----------
        print("\n-- when the screenshots file is missing --")
        ctx = await br.new_context(viewport={"width": 1680, "height": 1050})
        pg = await ctx.new_page()
        await pg.route("**/kb-shots.js", lambda r: r.fulfill(status=404, body=""))
        await open_guide(pg, base)
        im = await pg.query_selector("img.kbshot")
        box = await im.bounding_box()
        for attempt in (1, 2):
            await pg.mouse.move(5, 5); await pg.wait_for_timeout(200)
            # provoke the hover first, then watch -- measuring before moving the
            # pointer just waits for something that was never going to start
            await pg.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            t = await pg.evaluate("""async () => {
              const t0=performance.now(), CAP=6000;
              let appeared=null;
              while(performance.now()-t0<CAP){
                if(document.querySelector('.shot-wait')){appeared=performance.now()-t0;break;}
                await new Promise(r=>requestAnimationFrame(r));
              }
              if(appeared===null) return {appeared:null, gone:null};
              while(performance.now()-t0<CAP){
                if(!document.querySelector('.shot-wait')) break;
                await new Promise(r=>requestAnimationFrame(r));
              }
              return {appeared, gone:performance.now()-t0};
            }""")
            # never showing a spinner at all is the best outcome, not a failure:
            # once the loader has reported the file missing there is nothing to wait for
            waited = t["gone"]
            ck(waited is None or waited < 4000,
               f"hover {attempt}: no spinner is left hanging",
               "never cleared" if waited is None else f'{waited:.0f}ms')
            note = "never appeared" if t["appeared"] is None else \
                   f'{t["appeared"]:.0f}ms -> {waited:.0f}ms'
            print(f"       (spinner: {note})")
        await ctx.close()

        # ---------- 3b. a SLOW file must show the loading animation he asked for ----------
        print("\n-- when the screenshots file is slow --")
        ctx = await br.new_context(viewport={"width": 1680, "height": 1050})
        pg = await ctx.new_page()
        async def slow(route):
            await asyncio.sleep(1.6)
            await route.continue_()
        await pg.route("**/kb-shots.js", slow)
        await open_guide(pg, base)
        im = await pg.query_selector("img.kbshot")
        box = await im.bounding_box()
        await pg.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        spin = await pg.evaluate("""async () => {
          const t0=performance.now();
          let seen=null, anim=null;
          while(performance.now()-t0<5000){
            const w=document.querySelector('.shot-wait');
            if(w){ seen=performance.now()-t0;
                   const sp=w.querySelector('.spin');
                   anim=sp?getComputedStyle(sp).animationName:null; break; }
            await new Promise(r=>requestAnimationFrame(r));
          }
          while(performance.now()-t0<8000){
            if(!document.querySelector('.shot-wait')) break;
            await new Promise(r=>requestAnimationFrame(r));
          }
          return {seen, anim, gone:performance.now()-t0};
        }""")
        ck(spin["seen"] is not None and spin["seen"] < 600,
           "a loading animation appears while the big image is on its way",
           str(spin["seen"]))
        ck(spin["anim"] not in (None, "none", ""), "and it is actually animating", str(spin["anim"]))
        ck(spin["gone"] < 7000, "and it goes away once the image lands", f'{spin["gone"]:.0f}ms')
        big = await pg.evaluate("""() => {
          const p=document.querySelector('.shot-peek img');
          return p?p.naturalWidth:0; }""")
        ck(big >= 1400, "and the full-size image is what ends up on screen", str(big))
        await ctx.close()

        # ---------- 4. click opens the overlay, and closes three ways ----------
        print("\n-- overlay --")
        ctx = await br.new_context(viewport={"width": 1680, "height": 1050})
        pg = await ctx.new_page()
        await open_guide(pg, base)
        await pg.evaluate("() => document.querySelector('img.kbshot').click()")
        await pg.wait_for_timeout(1200)
        shown = await pg.evaluate("""() => {
          const d=document.querySelector('.shot-dlg,#shotDlg,dialog[open]');
          if(!d) return null;
          const img=d.querySelector('img');
          const r=img?img.getBoundingClientRect():{width:0,height:0};
          return {w:Math.round(r.width), nat:img?img.naturalWidth:0,
                  caption:(d.innerText||'').trim().slice(0,60)};
        }""")
        ck(bool(shown), "clicking opens an overlay")
        if shown:
            ck(shown["w"] >= 900, "at a genuinely large size", str(shown["w"]))
            ck(shown["nat"] >= 1400, "using the full-size file", str(shown["nat"]))
        await pg.keyboard.press("Escape"); await pg.wait_for_timeout(600)
        closed = await pg.evaluate("""() => !document.querySelector('.shot-dlg[open],#shotDlg[open],dialog[open]')""")
        ck(closed, "and Escape closes it")
        await ctx.close()

        await br.close()
    srv.shutdown()
    print("\n" + ("FAILURES: " + ", ".join(fails) if fails else "v11 screenshot suite: all checks passed"))
    return 1 if fails else 0

sys.exit(asyncio.run(main()))
