"""Nothing may escape the box it lives in — every screen, six widths.

Exists because a repo chip ran out through the side of a Deploy card: the name
was 30 characters, the chip was nowrap, nothing capped it. Page-level overflow
checks never saw it, because the page did not scroll — only the card leaked.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _serve import serve_mock, Run, wait_for, signin
from playwright.sync_api import sync_playwright

BASE, srv = serve_mock(8680)
r = Run()

# Scrollable wrappers are the honest exception: they are MEANT to hold something
# wider than themselves, so the walk stops there.
WALK = """(sel)=>{
  const bad=[];
  const scrolly=el=>{const c=getComputedStyle(el);
    return /(auto|scroll)/.test(c.overflowX)||/(auto|scroll)/.test(c.overflowY);};
  document.querySelectorAll(sel).forEach(box=>{
    if(!box.getClientRects().length) return;
    const b=box.getBoundingClientRect();
    const walk=(el)=>{
      for(const ch of el.children){
        const cs=getComputedStyle(ch);
        if(cs.display==='none'||cs.visibility==='hidden'||cs.position==='fixed'||cs.position==='absolute') continue;
        if(!ch.getClientRects().length) continue;
        const rc=ch.getBoundingClientRect();
        const overRight=Math.round(rc.right-b.right), overLeft=Math.round(b.left-rc.left);
        if(overRight>1||overLeft>1) bad.push({box:box.className.split(' ')[0],
          el:(ch.className&&ch.className.split?ch.className.split(' ')[0]:ch.tagName),
          text:(ch.innerText||'').trim().slice(0,40), overRight, overLeft});
        if(!scrolly(ch)) walk(ch);
      }
    };
    if(!scrolly(box)) walk(box);
  });
  return bad;
}"""

SCREENS = [("#/deploy", ".site-card"), ("#/apps", ".apptbl-row"), ("#/repos", ".ltbl-row"),
           ("#/accounts", ".ltbl-row"), ("#/accounts", ".panel"), ("#/new", ".panel"),
           ("#/files", ".panel"), ("#/log", ".panel"), ("#/deploy", ".panel")]

with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={"width": 1680, "height": 1000}); pg = ctx.new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    signin(pg, BASE)
    for w in (3440, 1680, 1366, 1280, 900, 390):
        pg.set_viewport_size({"width": w, "height": 950})
        print(f"\n-- {w}px --")
        seen = set()
        for href, sel in SCREENS:
            pg.click(f'.nav-item[href="{href}"]')
            pg.wait_for_timeout(700 if (href, sel) in seen else 1400)
            seen.add((href, sel))
            bad = pg.evaluate(WALK, sel)
            r.ok(not bad, f"{href} {sel}: nothing escapes its box", str(bad[:3]))
        ovf = pg.evaluate("document.documentElement.scrollWidth-document.documentElement.clientWidth")
        r.ok(ovf <= 0, f"the page itself does not scroll sideways at {w}px", str(ovf))
    r.ok(not errs, "no page errors", str(errs[:3]))
    b.close()
srv.shutdown()
sys.exit(r.done("bounds"))
