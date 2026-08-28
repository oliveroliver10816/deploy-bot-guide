"""Capture knowledge-base screenshots from the current design (mock data).

    python3 test/browser/shots.py [page.html] [outdir]

With no page argument it builds its own MOCK preview from panel/public/index.html,
so a capture always reflects the front end as it stands right now.

The PNGs are written at NATIVE resolution — viewport 1500x940 at
device_scale_factor=2 is 3000x1880 real pixels. Nothing is downscaled here.
Resizing is the encoder's job (panel/shots/build_shots.py), which needs the full
detail to produce a readable 1500px "full" image; throwing it away at capture time
is what left the guide with 900px screenshots nobody could read.
"""
import asyncio, os, re, shutil, sys, tempfile
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, "panel", "public", "index.html")
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "panel", "shots", "png")
NAMES = ["01-login", "02-sites", "05-filechosen", "06-confirm",
         "08-done", "09-keys", "11-addsite", "12-people"]
# The panel picks its theme from the OS when nobody has chosen one, and falls back
# to dark. Playwright's browser reports "light", so an unpinned capture would have
# quietly reshot the whole guide in the other theme — pin it to the panel's own
# default instead of inheriting whatever the machine running this happens to say.
THEME = os.environ.get("SHOT_THEME", "dark")


def mock_build(dest_dir):
    """Copy the source page and force the offline mock on. The source is never written to."""
    s = open(SRC, encoding="utf-8").read()
    out = re.sub(r'(const\s+MOCK\s*=\s*)(?:true|false)', r'\1true', s, count=1)
    if out == s and "const MOCK=true" not in s:
        sys.exit("could not switch the page into MOCK mode — check the markup")
    p = os.path.join(dest_dir, "index.html")
    open(p, "w", encoding="utf-8").write(out)
    return p


async def main(page_path):
    os.makedirs(OUT, exist_ok=True)
    taken = []
    async with async_playwright() as p:
        br = await p.chromium.launch()
        pg = await br.new_page(viewport={"width": 1500, "height": 940},
                               device_scale_factor=2, color_scheme=THEME)
        async def shot(n, sel=None):
            el = await pg.query_selector(sel) if sel else None
            path = f"{OUT}/{n}.png"
            await (el.screenshot(path=path) if el else pg.screenshot(path=path))
            taken.append(n)
            print("shot", n)
        await pg.goto(f"file://{page_path}"); await pg.wait_for_timeout(500)
        await pg.evaluate("()=>{const n=document.querySelector('#demoNote'); if(n) n.hidden=true;}")
        await shot("01-login", "#auth")
        await pg.fill('#loginForm [name=username]', "owner"); await pg.fill('#loginForm [name=password]', "x")
        await pg.click("#loginBtn"); await pg.wait_for_selector("#shell:not([hidden])", timeout=20000)
        await pg.wait_for_timeout(700)
        await shot("02-sites")
        await pg.click("label:has(#selAll)"); await pg.wait_for_timeout(400)
        await pg.set_input_files("input[type=file]", {"name": "summer-sale.html", "mimeType": "text/html", "buffer": b"<h1>hi</h1>"})
        await pg.wait_for_timeout(500)
        await shot("05-filechosen")
        await shot("06-confirm")
        await pg.click("#deployBtn")
        for _ in range(20):
            await pg.wait_for_timeout(2000)
            t = await pg.evaluate("() => (document.querySelector('#activityBody')||{innerText:''}).innerText")
            u = await pg.evaluate("""() => [...document.querySelectorAll('button')].some(b=>b.offsetParent!==null&&/undo/i.test(b.textContent))""")
            if u and any(w in t.lower() for w in ("live", "failed", "saved")): break
        await shot("08-done")
        el = await pg.query_selector("[data-view=settings]")
        if el: await el.click()
        await pg.wait_for_timeout(1000)
        await shot("09-keys")
        tabs = await pg.query_selector_all(".tab")
        if len(tabs) > 1:
            await tabs[1].click(); await pg.wait_for_timeout(2500); await shot("11-addsite")
        if len(tabs) > 3:
            await tabs[3].click(); await pg.wait_for_timeout(1200); await shot("12-people")
        await br.close()

    missing = [n for n in NAMES if n not in taken]
    for n in taken:
        # Report what actually landed on disk, read back from the file, not from
        # the arguments we passed to the screenshot call.
        from PIL import Image
        with Image.open(f"{OUT}/{n}.png") as im:
            print(f"  {n:16} {im.size[0]}x{im.size[1]} png "
                  f"{os.path.getsize(f'{OUT}/{n}.png')/1024:.0f} KB")
    print(f"captured {len(taken)}/{len(NAMES)} into {OUT}")
    if missing:
        sys.exit(f"MISSING screenshots: {missing}")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        asyncio.run(main(os.path.abspath(sys.argv[1])))
    else:
        tmp = tempfile.mkdtemp(prefix="panelpreview-")
        try:
            asyncio.run(main(mock_build(tmp)))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
