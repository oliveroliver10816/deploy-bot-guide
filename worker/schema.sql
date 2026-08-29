-- deploy-bot schema
--
-- Design notes that matter:
--  * Credentials live in `connections`, one row per ACCOUNT (a GitHub account, a Heroku
--    account). Adding a second GitHub account or a second Heroku account later is one
--    more row, not a code change. That is what makes "connect a new git / new heroku"
--    a two-minute job forever.
--  * `repos` and `apps` each point at the connection that can reach them, so a repo on
--    account A and a repo on account B coexist without ambiguity.
--  * `deploys` keeps prev_blob_sha so /undo can restore the exact previous bytes without
--    needing git history or a clone.

CREATE TABLE IF NOT EXISTS connections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,              -- 'github' | 'heroku'
  label       TEXT NOT NULL,              -- friendly name shown in buttons
  token       TEXT NOT NULL,
  account     TEXT,                       -- github login / heroku email, verified at connect time
  note        TEXT,                       -- free text: which client/site is on this key
  created_at  TEXT NOT NULL,
  UNIQUE (kind, label)
);

CREATE TABLE IF NOT EXISTS repos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT NOT NULL UNIQUE,     -- what the VA sees, e.g. "Main site"
  owner         TEXT NOT NULL,
  name          TEXT NOT NULL,
  branch        TEXT NOT NULL DEFAULT 'main',
  connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  url           TEXT,                     -- the domain shown to the user
  dir           TEXT DEFAULT '',          -- folder an uploaded file lands in
  -- Same naming rule as apps.heroku_created_at above — never call these created_at.
  gh_created_at TEXT,                     -- GitHub's own repository created_at
  pushed_at     TEXT,                     -- GitHub's pushed_at: when files last changed (any branch)
  UNIQUE (owner, name)
);

CREATE TABLE IF NOT EXISTS apps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT NOT NULL UNIQUE,
  heroku_name   TEXT NOT NULL,
  connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  repo_id       INTEGER REFERENCES repos(id) ON DELETE SET NULL,
  web_url       TEXT,
  created_at    TEXT NOT NULL,
  combo_id      INTEGER,                  -- which GitHub+Heroku pair it came from
  buildpack     TEXT,                     -- what Heroku will detect; NULL = nothing, so it cannot build
  buildpack_sha TEXT,                     -- the commit that answer came from, so an unchanged repo is skipped
  paused        INTEGER DEFAULT 0,        -- 1 = marked not in use (kept; no longer shown since v20)
  note          TEXT,                     -- his note about this site, shown on Apps AND under the name on Deploy
  note_color    TEXT,                     -- default|red|amber|green|blue|violet — a NAME, mapped per theme
  released_at   TEXT,                     -- Heroku's own released_at: when the code serving this address last changed
  built_sha     TEXT,                     -- the commit this app last built; differs from HEAD => rebuild it
  -- ⚠️ NAME IT heroku_created_at, NEVER created_at: runMigrations back-fills any
  -- new column called created_at with the time the migration ran, which would
  -- then be printed on screen as a creation date. That is a lie one rename away.
  heroku_created_at TEXT,                 -- Heroku's own "when app was created" 
  UNIQUE (connection_id, heroku_name)
);

CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  name        TEXT,
  role        TEXT NOT NULL,              -- 'owner' | 'va'
  added_at    TEXT NOT NULL
);

-- One in-flight conversation per user. `data` is JSON and also carries the
-- button option list, because Telegram caps callback_data at 64 bytes and a
-- repo path can easily exceed that -- buttons therefore carry an index only.
CREATE TABLE IF NOT EXISTS state (
  telegram_id INTEGER PRIMARY KEY,
  step        TEXT,
  data        TEXT,
  updated_at  TEXT NOT NULL
);

-- Remembers the folder the VA used last for a given repo, so the common case
-- ("same folder as last time") is one tap instead of a walk down the tree.
CREATE TABLE IF NOT EXISTS last_paths (
  telegram_id INTEGER NOT NULL,
  repo_id     INTEGER NOT NULL,
  dir         TEXT NOT NULL,
  PRIMARY KEY (telegram_id, repo_id)
);

CREATE TABLE IF NOT EXISTS deploys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id   INTEGER NOT NULL,
  repo_id       INTEGER NOT NULL,
  app_id        INTEGER,
  path          TEXT NOT NULL,
  file_name     TEXT,
  commit_sha    TEXT,
  prev_blob_sha TEXT,                     -- NULL when the file did not exist before
  new_blob_sha  TEXT,
  build_id      TEXT,
  build_status  TEXT,                     -- pending | succeeded | failed | no_app | error
  build_error   TEXT,
  chat_id       INTEGER,
  message_id    INTEGER,                  -- message edited in place with the build result
  is_undo       INTEGER DEFAULT 0,
  created_at    TEXT NOT NULL,
  finished_at   TEXT
);

CREATE INDEX IF NOT EXISTS deploys_pending ON deploys (build_status, created_at);
CREATE INDEX IF NOT EXISTS deploys_recent  ON deploys (created_at DESC);

-- ---- web panel ---------------------------------------------------------
-- Applied at deploy time. The request path no longer runs any DDL: traffic is
-- low enough that most requests hit a cold isolate, so doing it per-request
-- cost ~15 D1 round trips on every single call.

CREATE TABLE IF NOT EXISTS panel_users (
  username   TEXT PRIMARY KEY,
  pass_hash  TEXT NOT NULL,
  salt       TEXT NOT NULL,
  role       TEXT NOT NULL,              -- master | va
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  role       TEXT NOT NULL,
  expires    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip       TEXT PRIMARY KEY,
  n        INTEGER NOT NULL,
  first_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id         TEXT PRIMARY KEY,
  who        TEXT NOT NULL,
  file_name  TEXT NOT NULL,
  mode       TEXT,
  created_at TEXT NOT NULL,
  last_poll  TEXT                          -- throttles the on-read Heroku refresh
);

CREATE TABLE IF NOT EXISTS batch_targets (
  batch_id      TEXT NOT NULL,
  repo_id       INTEGER NOT NULL,
  app_id        INTEGER,
  path          TEXT,
  status        TEXT,
  detail        TEXT,
  commit_sha    TEXT,
  prev_blob_sha TEXT,
  new_blob_sha  TEXT,
  build_id      TEXT,
  build_url     TEXT,
  files_json    TEXT,                      -- every path this target wrote, for undo
  started_at    TEXT,                      -- when the build was handed to Heroku; anchors the give-up clock
  finished_at   TEXT,
  PRIMARY KEY (batch_id, repo_id)
);

CREATE INDEX IF NOT EXISTS bt_pending ON batch_targets (status);

-- v29: when a file last changed, from OUR OWN records.
--
-- Gitku does ~99% of the writes to these repos, so it already knows. GitHub
-- cannot answer this cheaply: a git tree carries no dates at all, and
-- `GET /commits?path=` is one request PER FILE against a hard 50-subrequest
-- ceiling per Worker invocation. One row per (repo, path), upserted by every
-- write the panel makes — the Deploy screen and the File Manager alike.
-- ⚠️ A path that is NOT in here has no date and must render blank. It must
-- never fall back to the repo's date: that would say "all 500 files changed
-- today" when one did.
-- v31: TAGS. His notes were already tags in practice — 21 notes across his apps
-- were only 7 distinct strings, retyped by hand every time. A tag is written
-- ONCE and then clicked onto any app.
--
-- ⚠️ `apps.note` and `apps.note_color` are NOT dropped. The migration copies
-- every existing note into a tag and links it; the old columns stay exactly as
-- they were, because nothing in this project deletes his words to make room.
CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  label      TEXT NOT NULL,
  color      TEXT,                    -- default|red|amber|green|blue|violet, a NAME
  created_at TEXT NOT NULL,
  UNIQUE (label, color)
);
CREATE TABLE IF NOT EXISTS app_tags (
  app_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (app_id, tag_id)
);
CREATE INDEX IF NOT EXISTS app_tags_tag ON app_tags (tag_id);

CREATE TABLE IF NOT EXISTS file_times (
  repo_id INTEGER NOT NULL,
  path    TEXT NOT NULL,
  at      TEXT NOT NULL,
  PRIMARY KEY (repo_id, path)
);

-- ---- combos, auto-discovery, audit log (2026-08-13) ---------------------
-- A "combo" pairs ONE GitHub account with ONE Heroku account. Several combos
-- can exist side by side, so several of each kind of account are supported.
CREATE TABLE IF NOT EXISTS combos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  label          TEXT,
  github_conn_id INTEGER NOT NULL,
  heroku_conn_id INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE (github_conn_id, heroku_conn_id)
);

-- Every action worth explaining later. Stored as ISO UTC; the panel renders IST.
--
-- The log answers three questions, not one:
--   kind='person' — somebody pressed something
--   kind='panel'  — the panel did it on its own (a build started/finished, the
--                   cron moved a batch on, a buildpack was detected, a refresh
--                   auto-linked an app, the schema was brought up to date)
--   ok=0 + error  — it failed, and this is WHY, in words that say what to do
CREATE TABLE IF NOT EXISTS audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  ok     INTEGER DEFAULT 1,
  kind   TEXT DEFAULT 'person',            -- 'person' | 'panel'
  error  TEXT,                             -- why it failed, when ok=0
  ref    TEXT                              -- batch id / heroku app / owner-repo
);
CREATE INDEX IF NOT EXISTS audit_recent ON audit_log (id DESC);
CREATE INDEX IF NOT EXISTS audit_kind   ON audit_log (kind, id DESC);
CREATE INDEX IF NOT EXISTS audit_bad    ON audit_log (ok, id DESC);

-- ---- the diary / day book (2026-08-29) ----------------------------------
-- His ask: "a Notes section maybe, some kind of daily diary that captures
-- everything and records how many sites were used, and actually we also delete
-- some apps everyday, so it will be out log file too".
--
-- The DAY'S FACTS are not stored here — audit_log already holds every create,
-- delete, build and deploy with its target, so the diary reads them back and
-- can never drift from what actually happened. This table holds only the part
-- a machine cannot write: what he says about the day.
--
-- 🛑 ref_label is TEXT, not just an id. He deletes apps every day, and a diary
-- line about an app that no longer exists is exactly the line worth keeping.
CREATE TABLE IF NOT EXISTS diary (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  day       TEXT NOT NULL,          -- YYYY-MM-DD, IST, the day he means
  actor     TEXT NOT NULL,
  ref_kind  TEXT,                   -- 'app' | 'repo' | NULL for a note on the day itself
  ref_id    INTEGER,
  ref_label TEXT,
  note      TEXT NOT NULL,
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS diary_day ON diary (day);
