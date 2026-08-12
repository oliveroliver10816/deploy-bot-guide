#!/usr/bin/env bash
# Wire a Telegram bot token into the deployed Worker and register the webhook.
#
#   ./setup.sh 8123456789:AAH...
#
# Idempotent: safe to re-run to rotate the token or repair the webhook.
set -euo pipefail

TOKEN="${1:-}"
if [ -z "$TOKEN" ]; then
  echo "usage: $0 <telegram-bot-token>" >&2
  echo "Create the bot in Telegram with @BotFather -> /newbot, then paste the token here." >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
CFG=/root/.config/deploy-bot/config.json
WORKER_URL="https://deploy-bot.fleet-fefsba.workers.dev"

CLOUDFLARE_API_KEY=$(python3 -c "import json;print(json.load(open('/root/.config/cloudflare/osanix-fleetview.json'))['api_key'])")
CLOUDFLARE_EMAIL=$(python3 -c "import json;print(json.load(open('/root/.config/cloudflare/osanix-fleetview.json'))['email'])")
export CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL
SECRET=$(python3 -c "import json;print(json.load(open('$CFG'))['webhook_secret'])")

echo "1/4  Checking the bot token…"
ME=$(curl -sf "https://api.telegram.org/bot${TOKEN}/getMe")
echo "$ME" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if not d.get('ok'): sys.exit('Telegram rejected that token: %s' % d.get('description'))
u=d['result']; print('     bot is @%s (%s)' % (u['username'], u.get('first_name','')))
"

echo "2/4  Storing the token in the Worker…"
printf '%s' "$TOKEN" | wrangler secret put TELEGRAM_BOT_TOKEN --config "$HERE/worker/wrangler.json" >/dev/null
echo "     stored as a Worker secret (not in git, not in this file)"

echo "3/4  Pointing Telegram at the Worker…"
curl -sf -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "{\"url\":\"${WORKER_URL}/webhook\",\"secret_token\":\"${SECRET}\",\"allowed_updates\":[\"message\",\"callback_query\"],\"drop_pending_updates\":true}" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
if not d.get('ok'): sys.exit('setWebhook failed: %s' % d.get('description'))
print('     webhook set')
"

echo "4/4  Verifying…"
curl -sf "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" | python3 -c "
import json,sys
d=json.load(sys.stdin)['result']
print('     url                 :', d.get('url'))
print('     custom certificate  :', d.get('has_custom_certificate'))
print('     pending updates     :', d.get('pending_update_count'))
if d.get('last_error_message'): print('     LAST ERROR          :', d['last_error_message'])
"

python3 - "$TOKEN" <<'PY'
import json, sys
p = "/root/.config/deploy-bot/config.json"
d = json.load(open(p))
d["bot_token"] = sys.argv[1]
json.dump(d, open(p, "w"), indent=2)
PY
chmod 600 "$CFG"

echo
echo "Done. Open Telegram, message the bot, and send /start."
