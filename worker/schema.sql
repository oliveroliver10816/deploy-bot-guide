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
  finished_at   TEXT,
  PRIMARY KEY (batch_id, repo_id)
);

CREATE INDEX IF NOT EXISTS bt_pending ON batch_targets (status);

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
CREATE TABLE IF NOT EXISTS audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  ok     INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS audit_recent ON audit_log (id DESC);
