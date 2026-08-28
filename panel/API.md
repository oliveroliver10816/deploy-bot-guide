# Panel API contract  (backend: Cloudflare Worker, base https://deploy-bot.fleet-fefsba.workers.dev)

All endpoints under /api. JSON in, JSON out. Auth: `Authorization: Bearer <session>` except /api/login.
CORS locked to https://ail.com.de. Preflight cached 24h (Access-Control-Max-Age: 86400).
Errors: { error: "human readable" } with a 4xx/5xx status.

Roles: the database stores `master`; **every response says `owner`**. Only People is owner-only.

POST /api/login            {username, password} -> {session, role, username, expires}  role = "owner" | "va"
POST /api/logout           {} -> {ok}
GET  /api/me               -> {username, role}

---------------------------------------------------------------------------
GET /api/state   — everything the screen needs in ONE call
---------------------------------------------------------------------------
Every list is **NEWEST FIRST** (v10). Nothing is alphabetical any more.

{
  sites: [ {                      // === apps: also returned as `apps` (same array)
    id: "12",                     // STRING, always
    label, app: "heroku-name",
    url, app_url: "https://….herokuapp.com/",
    owner, repo, branch, dir,     // "" when not linked
    linked: true|false,
    buildpack: "php"|null,
    buildpack_checked: true|false,
    account: "heroku e-mail",
    created_at: "ISO UTC"|null,   // v10 — when the app was first seen
    repo_created_at: "ISO"|null   // v10 — when its repository was first seen
  } ],
  accounts: {
    github: [ {id, account, login, created_at} ],     // v10: created_at, newest first
    heroku: [ {id, account, email, created_at} ]
  },
  combos: [ {id, label, github, heroku, github_conn_id, heroku_conn_id, apps, created_at} ],
  users:  [ {username, role} ],
  recent: [ {id, at, who, file, sites, ok, failed, targets} ],
  needs:  { unlinked, no_combo },
  me:     { username, role }
}

Ordering: apps `created_at DESC, id DESC` · accounts `created_at DESC, id DESC` ·
combos `created_at DESC, id DESC` · repos (in /api/repos) `created_at DESC, id DESC`.
`created_at` may be null only on rows that predate the column; those sort last but keep
their id order, which is their real creation order.

GET  /api/repos            -> {repos:[{id (STRING), label, owner, name, branch, dir, account, created_at}]}
                              newest first (v10)

---------------------------------------------------------------------------
Deploy
---------------------------------------------------------------------------
POST /api/deploy           multipart/form-data:
                             file=<binary>   (repeat for many files)
                             paths=<json array, same order, relative paths>
                             sites=<json array of APP ids>   max 10
                             mode="auto"|"replace"|"new"
                        -> {batch, targets:[{site_id, label, status}]}
GET  /api/batch/{id}       -> {batch, done, undone, targets:[{site_id,label,url,status,detail,path,build_url}]}
     status: committing | building | live | failed | skipped | no_app | **unknown**
     ⚠ v10 adds **`unknown`** — a build Heroku stopped answering about. It is TERMINAL,
       so it counts towards `done`. `detail` says the file IS committed and points at
       dashboard.heroku.com/apps/<app>/activity. Give it a pill; anything unmapped
       currently renders its raw name, which is readable but plain.
POST /api/undo/{batch}     -> {batch}   reverts every target in that batch, redeploys

A target may sit in `building` for at most 20 minutes. After that the panel stops
claiming to know and writes `unknown`. A failed poll no longer marks a deploy failed —
it leaves it building and puts "Waiting for Heroku — …" in `detail`.

---------------------------------------------------------------------------
Accounts, pairs, links
---------------------------------------------------------------------------
POST /api/token            {kind:"github"|"heroku", token} -> {account, kind, discovered}
DELETE /api/token/{id}     -> {ok}
POST /api/combo            {github_conn_id, heroku_conn_id, label?} -> {ok, discovered}
DELETE /api/combo/{id}     -> {ok}
POST /api/refresh          {} -> {apps, repos, linked, errors[]}
GET  /api/discover/{kind}  kind=repos|apps -> {items, repos, apps}

POST /api/link             {app_id, repo_id}      -> {ok, replaced, app}
     • Linking an app that is ALREADY linked is allowed. `replaced` is the previous
       "owner/name" (or null), and the log records `re-linked an app` with
       detail `was owner/old -> owner/new`.
     • {app_id, repo_id:null} still unlinks (old shape kept working).
     • {site_id, heroku_name} still works (oldest shape).
POST /api/unlink           {app_id}                -> {ok, was, app, already?}     ← NEW in v10
     • Clears the link and the cached buildpack. Returns `was` = "owner/name" it used
       to point at, and `app` = the app in exactly `state.sites[]` shape, so the page
       can swap the row in without re-reading the screen.
     • Unbinding something already unbound answers 200 with `already:true` — not an error.
     • Never deletes the repository or the Heroku app. It only breaks the association.

POST /api/repo/create      {conn_id, name}         -> {owner, repo, full_name, branch, account, private}
POST /api/app/create       {conn_id, name, region} -> {name, web_url, id, account}
POST /api/makedeployable   {app_id}                -> {ok, added:"index.php"} | {ok, already:"php"}
PATCH /api/app/{id}        {dir, branch}           -> {ok}

---------------------------------------------------------------------------
Files inside an app's repository   (works on the APP id)
---------------------------------------------------------------------------
GET  /api/files/{appId}    -> {app, repo, branch, truncated, entries:[{path,type,size,sha,mode}], buildpack}
                              ⚠ `mode` is new in v10 (100644 / 100755 / 120000)
GET  /api/file?app=&path=  -> {contentB64, sha, size}

POST /api/files/{appId}
  {
    message?: "commit message",
    files?:   [ {path, contentB64} ],
    remove?:  [ "path" | "folder" ],          // folder expanded server-side
    rename?:  [ {from, to} ],                 // ← NEW in v10; file OR folder
    overwrite?: true,                         // required to rename onto an existing path
    publish?: false                           // skip the rebuild
  }
  -> {ok, commitSha, changed, removed, renamed, buildpack, build:{id,status}|{error}|null}

  ONE commit and ONE build for everything in the request — a rename is never a
  delete plus an add, because half of that pair can succeed on its own.

  Rename rules:
   • `from` may be a file or a FOLDER; a folder moves every blob beneath it and keeps
     the shape below it. File modes are preserved.
   • Renaming onto a path that already exists → **409**, message names the clash and
     says to send `overwrite:true`.
   • Refused with 400: `..` anywhere, an empty or `.` segment, a missing `from`/`to`,
     a path over 400 characters, moving a folder into itself, and a `from` that is not
     in the repository ("There is nothing called X in this repository to rename").
   • `from === to` is a no-op, not an error.
   • Two paths may swap names in one request (with `overwrite:true`) and both survive.
   • A request that would change nothing → 400 "There is nothing to change in that request."

---------------------------------------------------------------------------
GET /api/logs   — the activity log
---------------------------------------------------------------------------
Query (all optional, and they combine):
   ?kind=person|panel      person = somebody pressed something
                           panel  = the backend did it on its own
   ?only=errors            only rows with ok=0
   ?q=<text>               case-insensitive, matches actor/action/target/detail/error/ref

-> {
     entries: [ {
       id, at, actor, action, target, detail, ok,   // ← unchanged, old pages still work
       kind:  "person" | "panel",                   // ← new
       error: "why it failed"|null,                 // ← new, present whenever ok=0
       ref:   "batch id / heroku app / owner-repo"|null   // ← new
     } ],
     total,        // how many match the filter in all
     shown,        // how many came back
     limit: 200,   // the cap
     truncated,    // total > shown
     filter: {kind, only, q}
   }

⚠ Sort by `id` DESC, not by `Date.parse(at)`. Several rows are written inside the same
millisecond (a build starting and finishing, a refresh linking three apps), and sorting
on the timestamp alone reorders them arbitrarily. `id` is now returned for exactly this.

What `kind:"panel"` rows say: `started a build` · `a build finished` (detail "live"/"failed",
error = the tail of the Heroku log) · `gave up waiting for a build` · `could not read a
build status` · `linked an app by itself` · `checked what Heroku will build` ·
`rebuilt after a file change` · `could not rebuild after a file change` · `could not read a
GitHub/Heroku account` · `brought the database up to date`.

Failures always carry `error` in the same words the screen shows — a GitHub refusal names
the permission to grant and the repository, a Heroku failure names the key. A row with
ok=0 and no error is a bug.

---------------------------------------------------------------------------
People
---------------------------------------------------------------------------
POST /api/user             {username, password, role}  -> {ok}   owner only
DELETE /api/user/{username} -> {ok}                              owner only
POST /api/password          {old, new} -> {ok}                   self
