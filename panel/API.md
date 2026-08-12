# Panel API contract  (backend: Cloudflare Worker, base https://deploy-bot.fleet-fefsba.workers.dev)

All endpoints under /api. JSON in, JSON out. Auth: `Authorization: Bearer <session>` except /api/login.
CORS locked to https://ail.com.de. Preflight cached 24h (Access-Control-Max-Age: 86400).
Errors: { error: "human readable" } with a 4xx/5xx status.

POST /api/login            {username, password} -> {session, role, expires}   role = "master" | "va"
POST /api/logout           {} -> {ok}
GET  /api/me               -> {username, role}

GET  /api/state            -> everything the UI needs in ONE call (speed):
                              { sites:[{id,label,url,owner,repo,branch,dir,app,app_url,deploy_mode}],
                                accounts:{github:[{id,account}],heroku:[{id,account}]},
                                users:[{username,role}],           // master only
                                recent:[{id,at,who,file,sites,status}] }

POST /api/deploy           multipart/form-data: file=<binary>, sites=<json array of site ids>,
                           mode="auto"|"replace"|"new"
                        -> {batch, targets:[{site_id, status:"queued"}]}
GET  /api/batch/{id}       -> {batch, done, targets:[{site_id,label,status,detail,build_url}]}
                           status: committing|building|live|failed|skipped|no_app
POST /api/undo/{batch}     -> {batch}   reverts every target in that batch, redeploys

POST /api/token            {kind:"github"|"heroku", token}  -> {account}   master only; verifies first
DELETE /api/token/{id}     -> {ok}

GET  /api/discover/{kind}  kind=repos|apps  -> list from the provider, minus already-registered
POST /api/site             {conn_id, owner, repo, branch, dir, label, url}   -> {id}   master only
PATCH /api/site/{id}       {label,url,dir,branch,app_id}                     -> {ok}
DELETE /api/site/{id}      -> {ok}

POST /api/repo/create      {conn_id, name, private:true}          -> {owner,repo}  master only
POST /api/app/create       {conn_id, name, region}                -> {name,web_url} master only
POST /api/link             {site_id, app_conn_id, heroku_name}    -> {ok}          master only

POST /api/user             {username, password, role}  -> {ok}   master only
DELETE /api/user/{username} -> {ok}                              master only
POST /api/password          {old, new} -> {ok}                   self
