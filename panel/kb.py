#!/usr/bin/env python3
"""
Inject the gated knowledge base into panel/public/index.html.

The KB lives INSIDE the panel, behind the same login, with screenshots embedded
as WebP data URIs. That means: no second page to secure, no image URLs anyone
can fetch without signing in, and zero extra backend requests to serve it.

Idempotent — run it again after a design change and it replaces the old section.
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = os.path.join(HERE, "public", "index.html")
SHOTS = "/tmp/claude-0/-root-workspace/a118e9ed-148f-4f48-82a8-214aea5700d1/scratchpad/kbshots/shots.json"

shots = json.load(open(SHOTS)) if os.path.exists(SHOTS) else {}
img = lambda n, alt: (
    f'<img class="kbshot" loading="lazy" alt="{alt}" src="{shots[n]}">' if n in shots else ""
)

CSS = """
/*KB:CSS:START*/
/* ---- knowledge base ---- */
#scr-help .wrap{padding-bottom:80px}
.kbnav{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 26px}
.kbnav a{display:inline-block;padding:10px 14px;border-radius:999px;background:var(--card);
  border:1px solid var(--line);text-decoration:none;color:var(--ink);font-weight:650;font-size:15px;min-height:44px;
  display:inline-flex;align-items:center}
.kbnav a:hover{border-color:var(--go)}
.kbsec{margin:0 0 40px;scroll-margin-top:78px}
.kbsec > h2{font-size:26px;margin:0 0 6px;letter-spacing:-.01em}
.kbsec > p.lead{margin:0 0 18px}
.kbstep{counter-increment:kb;position:relative;padding:0 0 26px 52px;margin:0}
.kbsteps{counter-reset:kb;list-style:none;padding:0;margin:0}
.kbstep::before{content:counter(kb);position:absolute;left:0;top:0;width:34px;height:34px;border-radius:10px;
  background:var(--go);color:#fff;font-weight:800;font-size:17px;display:grid;place-items:center}
.kbstep b.t{display:block;font-size:18px;margin-bottom:4px}
.kbshot{display:block;width:100%;max-width:620px;height:auto;border-radius:12px;border:1px solid var(--line);
  margin:12px 0 4px;box-shadow:0 2px 10px rgba(0,0,0,.06)}
.kbnote{border-left:4px solid var(--go);background:rgba(11,107,77,.06);border-radius:0 10px 10px 0;
  padding:12px 16px;margin:12px 0}
.kbnote.warn{border-left-color:#B4530A;background:rgba(180,83,10,.07)}
.kbnote p{margin:0}
.kbtable{width:100%;border-collapse:collapse;margin:8px 0 4px}
.kbtable th,.kbtable td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top;font-size:16px}
.kbtable th{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut)}
.kbtable td:first-child{white-space:nowrap;font-weight:700}
@media (max-width:560px){ .kbstep{padding-left:44px} .kbsec > h2{font-size:22px} }
/* Adding a Help button pushed the header past a 390px phone (it needed 491px).
   Let the bar wrap and drop the role chip rather than shrink tap targets. */
@media (max-width:470px){
  header.app .wrap{flex-wrap:wrap;row-gap:2px;padding-top:6px;padding-bottom:6px}
  header.app .rolechip{display:none}
  header.app .iconbtn{padding:0 8px;font-size:14px}
}
/*KB:CSS:END*/
"""

SECTION = f"""
<!--KB:HTML:START-->
<!-- ================= HELP / KNOWLEDGE BASE ================= -->
<section id="scr-help" hidden>
  <header class="app">
    <div class="wrap">
      <button class="iconbtn" id="btn-help-back" type="button">&larr; Back</button>
      <span class="brand" style="font-size:18px">How to use this</span>
      <span class="hspace"></span>
    </div>
  </header>
  <div class="wrap">

    <nav class="kbnav">
      <a href="#kb-update">Update a website</a>
      <a href="#kb-undo">Undo a mistake</a>
      <a href="#kb-status">What the words mean</a>
      <a href="#kb-keys">Connect keys</a>
      <a href="#kb-add">Add a website</a>
      <a href="#kb-people">Add your VA</a>
      <a href="#kb-trouble">If something goes wrong</a>
    </nav>

    <section class="kbsec" id="kb-update">
      <h2>Update a website</h2>
      <p class="lead">This is the whole job. Four taps and a file.</p>
      <ol class="kbsteps">
        <li class="kbstep">
          <b class="t">Sign in</b>
          Your username and password. Nothing else to fill in.
          {img("01-login", "The sign in screen")}
        </li>
        <li class="kbstep">
          <b class="t">Tick the websites that should get the file</b>
          Each one shows its domain name, the folder the file will land in, and whether it
          rebuilds afterwards. Tick as many as you like, or use <b>Select all</b>.
          {img("02-sites", "Choosing which websites to update")}
        </li>
        <li class="kbstep">
          <b class="t">Drop the file in</b>
          Drag it onto the box, or tap the box to browse. You will see its name and size.
          {img("05-filechosen", "The chosen file")}
        </li>
        <li class="kbstep">
          <b class="t">Check the summary and press Deploy</b>
          It lists every site and the exact folder the file goes into. This is the last point
          where nothing has changed yet.
          {img("06-confirm", "Confirm before deploying")}
        </li>
        <li class="kbstep">
          <b class="t">Watch it finish</b>
          Each site reports on its own. You can close the page — the work carries on.
          {img("08-done", "Per-site results, including one failure")}
        </li>
      </ol>
      <div class="kbnote">
        <p><b>Same name replaces, new name adds.</b> If the folder already has a file with that
        name, yours replaces it. If not, yours is added.</p>
      </div>
    </section>

    <section class="kbsec" id="kb-undo">
      <h2>Undo a mistake</h2>
      <p class="lead">Nothing here is permanent. Undo puts back exactly what was there before.</p>
      <ol class="kbsteps">
        <li class="kbstep">
          <b class="t">Press &ldquo;Undo this deploy&rdquo;</b>
          It is on the results screen, and on the deploy screen as <b>Undo it</b> next to the last deploy.
        </li>
        <li class="kbstep">
          <b class="t">Press it a second time to confirm</b>
          Every site in that batch is put back and rebuilt &mdash; not just one of them.
        </li>
      </ol>
      <div class="kbnote">
        <p>If the file was brand new, undo removes it again. If it replaced something, the old
        version comes back byte for byte.</p>
      </div>
    </section>

    <section class="kbsec" id="kb-status">
      <h2>What the words mean</h2>
      <table class="kbtable">
        <tr><th>Word</th><th>What happened</th></tr>
        <tr><td>Committing</td><td>Saving your file into the website&rsquo;s code.</td></tr>
        <tr><td>Building</td><td>Saved. The app is rebuilding itself now. Usually one to three minutes.</td></tr>
        <tr><td>Live</td><td>Done. Visitors see it.</td></tr>
        <tr><td>Saved (no app)</td><td>The file is saved, but this site has no app linked, so nothing was rebuilt. Not an error.</td></tr>
        <tr><td>Failed</td><td>The file <b>was</b> saved but the rebuild did not work, so visitors still see the old version. The reason is printed underneath.</td></tr>
      </table>
      <div class="kbnote warn">
        <p><b>Some sites can succeed while others fail.</b> That is normal and the screen says so
        plainly. A failure on one site never affects the others.</p>
      </div>
    </section>

    <section class="kbsec" id="kb-keys">
      <h2>Connect your keys <span class="rolechip">owner only</span></h2>
      <p class="lead">Do this once. The keys are stored on the server, never in this page.</p>
      <ol class="kbsteps">
        <li class="kbstep">
          <b class="t">Open Settings &rarr; Keys</b>
          {img("09-keys", "The keys screen")}
        </li>
        <li class="kbstep">
          <b class="t">Paste your GitHub token</b>
          Make it at <b>github.com/settings/tokens</b> &rarr; Fine-grained token.
          Give it <b>Contents: Read and write</b>. If you want the &ldquo;create a new repo&rdquo;
          button to work, set it to <b>All repositories</b> and also give it
          <b>Administration: Read and write</b>.
        </li>
        <li class="kbstep">
          <b class="t">Paste your Heroku API key</b>
          <b>dashboard.heroku.com</b> &rarr; Account settings &rarr; scroll to <b>API Key</b> &rarr; Reveal.
        </li>
      </ol>
      <div class="kbnote">
        <p>The panel checks each key immediately and tells you which account it belongs to. If it
        says the key was rejected, nothing was saved &mdash; just paste a correct one.</p>
      </div>
    </section>

    <section class="kbsec" id="kb-add">
      <h2>Add a website <span class="rolechip">owner only</span></h2>
      <ol class="kbsteps">
        <li class="kbstep">
          <b class="t">Settings &rarr; Websites &rarr; Add a website</b>
          {img("11-addsite", "Adding a website")}
        </li>
        <li class="kbstep">
          <b class="t">Pick the repo, then fill three boxes</b>
          <b>Domain shown to users</b> is the name everyone sees, e.g. <code>mysite.com</code>.
          <b>Folder</b> is where uploaded files land, e.g. <code>public/</code>.
          <b>Heroku app</b> is the app that rebuilds &mdash; leave it as None to only save files.
        </li>
      </ol>
      <div class="kbnote warn">
        <p><b>The folder matters more than anything else here.</b> Get it wrong and files land in
        the wrong place. If you are unsure, look at where the site&rsquo;s existing
        <code>index.html</code> lives.</p>
      </div>
    </section>

    <section class="kbsec" id="kb-people">
      <h2>Add your VA <span class="rolechip">owner only</span></h2>
      <ol class="kbsteps">
        <li class="kbstep">
          <b class="t">Settings &rarr; People &rarr; Add a VA</b>
          Give them a username and a password, and send those to them.
          {img("12-people", "Managing who can sign in")}
        </li>
      </ol>
      <div class="kbnote">
        <p>A VA can deploy and undo. They cannot open Settings, see your keys, add websites, or
        add people. There is nothing they can press that reveals a key.</p>
      </div>
    </section>

    <section class="kbsec" id="kb-trouble">
      <h2>If something goes wrong</h2>
      <table class="kbtable">
        <tr><th>You see</th><th>Do this</th></tr>
        <tr><td>Wrong username or password</td><td>Check for a stray space. After ten wrong tries it locks for fifteen minutes.</td></tr>
        <tr><td>Your session expired</td><td>Normal after twelve hours. Sign in again.</td></tr>
        <tr><td>Nothing loads at all</td><td>Check the address is exactly the one you were given. The panel only works from that address.</td></tr>
        <tr><td>Failed on one site</td><td>Read the reason under the site name. Press <b>Undo this deploy</b> to put it back, then tell Bob.</td></tr>
        <tr><td>Lost track of the deploy</td><td>Press <b>Check again</b>. The deploy itself keeps running on the server regardless.</td></tr>
        <tr><td>A site is missing from the list</td><td>It has not been added yet &mdash; owner adds it in Settings &rarr; Websites.</td></tr>
      </table>
      <div class="kbnote">
        <p><b>Nothing you can press here can break a website permanently.</b> Every deploy can be
        undone, and a failed rebuild leaves visitors on the version that was already working.</p>
      </div>
    </section>

  </div>
</section>
<!--KB:HTML:END-->
"""

JS = """
/*KB:JS:START*/
function openHelp(){ show('scr-help'); window.scrollTo(0,0); }
function closeHelp(){ show(S.session ? 'scr-main' : 'scr-login'); window.scrollTo(0,0); }
/*KB:JS:END*/
"""


def main():
    s = open(PAGE, encoding="utf-8").read()

    # Remove any previously injected KB. Marker-bounded on purpose: an earlier
    # version matched a CSS comment and swallowed the entire <script> block.
    for a, b in (("<!--KB:HTML:START-->", "<!--KB:HTML:END-->"),
                 ("/*KB:CSS:START*/", "/*KB:CSS:END*/"),
                 ("/*KB:JS:START*/", "/*KB:JS:END*/")):
        while a in s and b in s:
            i, j = s.index(a), s.index(b) + len(b)
            if j <= i:
                break
            s = s[:i] + s[j:]

    # 1. styles
    if "/*KB:CSS:START*/" not in s:
        s = s.replace("</style>", CSS + "\n</style>", 1)

    # 2. the section, before the settings screen
    s = s.replace('<!-- ================= SETTINGS ================= -->',
                  SECTION + '\n<!-- ================= SETTINGS ================= -->', 1)

    # 3. show() must know about it
    s = s.replace("for(const s of ['scr-login','scr-main','scr-settings'])",
                  "for(const s of ['scr-login','scr-main','scr-settings','scr-help'])", 1)

    # 4. a Help button in both headers
    s = s.replace('<button class="iconbtn" id="btn-settings" type="button">Settings</button>',
                  '<button class="iconbtn" id="btn-help" type="button">Help</button>\n'
                  '      <button class="iconbtn" id="btn-settings" type="button">Settings</button>', 1)
    s = s.replace('<button class="iconbtn" id="btn-back" type="button">&larr; Back</button>',
                  '<button class="iconbtn" id="btn-back" type="button">&larr; Back</button>\n'
                  '      <span class="hspace"></span>\n'
                  '      <button class="iconbtn" id="btn-help2" type="button">Help</button>', 1)

    # 5. behaviour
    s = s.replace("function openSettings(){", JS + "\nfunction openSettings(){", 1)
    s = s.replace("boot();", """
['btn-help','btn-help2'].forEach(id=>{ const b=document.getElementById(id); if(b) b.addEventListener('click',openHelp); });
{ const b=document.getElementById('btn-help-back'); if(b) b.addEventListener('click',closeHelp); }
boot();""", 1)

    open(PAGE, "w", encoding="utf-8").write(s)
    print(f"KB injected — page is now {len(s)/1024:.0f} KB with {len(shots)} screenshots")


if __name__ == "__main__":
    main()
