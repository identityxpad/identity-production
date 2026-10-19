#!/usr/bin/env bash
# End-to-end test of the launch watcher. Needs test/fake-chain.js running and the API started with:
#   PUMPPORTAL_WS=ws://127.0.0.1:8790  SOLANA_RPC_URL=http://127.0.0.1:8791
#   SOL_PRICE_URL=http://127.0.0.1:8791/price  WATCH_POLL_SECONDS=2  ADMIN_TOKEN=admintest
#   WATCH_MINTS=$IDN  FEATURED_MINTS=$IDN
A=${A:-http://127.0.0.1:8099}
F=http://127.0.0.1:8791
IDN=iDeNTityx2VQ461hS7C7Zs4FhNGhTP1WkfxFEWJ36ub
OTHER=GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG
FALLBACK=4ZxpJoZtkL1hz2aq3VrTyY4MbPFdQ2E6R3uNkPHvj7Bn
LATE=8Qe3rRTxhFp5rLxNtjv1oNZXUoxmLiHWUY4n3NvmZ3Gd
BADMETA=7nYB3iAUsTjDygWcdRXHbFbCZt7ec9ruuzh6MLiHVKY6
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1  -> $2"; FAIL=$((FAIL+1)); }
j()   { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);const v=($1);console.log(v===undefined||v===null?'':typeof v==='object'?JSON.stringify(v):v)}catch(e){console.log('')}})"; }
fpost() { curl -s -XPOST "$F$1" -H 'content-type: application/json' -d "$2" >/dev/null; }
admin() { curl -s -X"$1" "$A$2" -H 'authorization: Bearer admintest' -H 'content-type: application/json' ${3:+-d "$3"}; }
coin()  { curl -s "$A/api/coins" | j "o.coins.find(c=>c.address==='$1')$2"; }

echo "== setup"
[ "$(curl -s $F/ctl/subs | j "o.some(s=>s.method==='subscribeNewToken')")" = true ] && ok "API subscribed to PumpPortal's new-coin stream" || bad "no newToken subscription" "$(curl -s $F/ctl/subs)"
[ "$(admin GET /admin/watch | j "o.watching.some(w=>w.mint==='$IDN'&&!w.liveAt)")" = true ] && ok "identity address preloaded from WATCH_MINTS, hidden until live" || bad "watchlist" "$(admin GET /admin/watch)"
[ -z "$(coin $IDN .name)" ] && ok "identity not on the site yet" || bad "shown too early" x

echo "== someone else's coin launches -> ignored"
fpost /ctl/emit "{\"msg\":{\"txType\":\"create\",\"mint\":\"$OTHER\",\"name\":\"Random\",\"symbol\":\"RND\",\"uri\":\"$F/meta/x.json\",\"traderPublicKey\":\"$OTHER\",\"marketCapSol\":28}}"
sleep 1; [ -z "$(coin $OTHER .name)" ] && ok "unwatched coin ignored" || bad "unwatched coin added" x

echo "== identity launches (instant, via the stream)"
fpost /ctl/meta "{\"id\":\"idn\",\"json\":{\"name\":\"Identity\",\"symbol\":\"IDENTITY\",\"description\":\"Every coin deserves its own identity.\",\"image\":\"https://ipfs.io/ipfs/QmIdentityImage\",\"twitter\":\"https://x.com/identity\",\"telegram\":\"t.me/identity\",\"website\":\"javascript:alert(1)\"}}"
fpost /ctl/emit "{\"msg\":{\"txType\":\"create\",\"signature\":\"sigIDN\",\"mint\":\"$IDN\",\"name\":\"Identity\",\"symbol\":\"IDENTITY\",\"uri\":\"$F/meta/idn.json\",\"traderPublicKey\":\"7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU\",\"marketCapSol\":31.5}}"
sleep 2
[ "$(coin $IDN .name)" = Identity ] && ok "identity appeared on the site within 2s" || bad "not added" "$(curl -s $A/api/coins)"
[ "$(coin $IDN .imageUri)" = "https://ipfs.io/ipfs/QmIdentityImage" ] && ok "image pulled from metadata" || bad image "$(coin $IDN .imageUri)"
[ "$(coin $IDN .twitter)" = "https://x.com/identity" ] && ok "X link pulled" || bad twitter "$(coin $IDN .twitter)"
[ "$(coin $IDN .telegram)" = "https://t.me/identity" ] && ok "Telegram link pulled (bare link fixed to https)" || bad telegram "$(coin $IDN .telegram)"
[ -z "$(coin $IDN .website)" ] && ok "javascript: link blocked" || bad "unsafe link kept" "$(coin $IDN .website)"
[ "$(coin $IDN .description)" = "Every coin deserves its own identity." ] && ok "description pulled" || bad desc x
[ "$(coin $IDN .ticker)" = identity ] && ok "ticker matched to address: identity" || bad prefix "$(coin $IDN .ticker)"
[ "$(coin $IDN .featured)" = true ] && ok "featured (from FEATURED_MINTS)" || bad featured x
[ "$(coin $IDN .marketCapSol)" = 31.5 ] && ok "starting market cap 31.5 SOL" || bad mc "$(coin $IDN .marketCapSol)"
[ "$(curl -s $A/api/feed | j "o.events.some(e=>e.type==='launch'&&e.mint==='$IDN'&&e.name==='Identity')")" = true ] && ok "launch posted to the live feed" || bad feed "$(curl -s $A/api/feed)"
[ "$(curl -s $F/ctl/subs | j "o.some(s=>s.method==='subscribeTokenTrade'&&s.keys.includes('$IDN'))")" = true ] && ok "now following identity's trades" || bad "no trade sub" x

echo "== a trade comes in -> market cap and feed update"
fpost /ctl/emit "{\"msg\":{\"txType\":\"buy\",\"signature\":\"sigBuy1\",\"mint\":\"$IDN\",\"traderPublicKey\":\"9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM\",\"solAmount\":2.5,\"marketCapSol\":44}}"
sleep 1
[ "$(coin $IDN .marketCapSol)" = 44 ] && ok "market cap updated to 44 SOL" || bad mc "$(coin $IDN .marketCapSol)"
[ "$(curl -s $A/api/coins | j o.solUsd)" = 150 ] && ok "SOL price available for USD market cap" || bad price x
[ "$(curl -s $A/api/feed | j "o.events.some(e=>e.type==='buy'&&e.mint==='$IDN')")" = true ] && ok "buy shows in the feed" || bad feed x

echo "== same launch seen twice -> no duplicate"
fpost /ctl/emit "{\"msg\":{\"txType\":\"create\",\"signature\":\"sigIDN\",\"mint\":\"$IDN\",\"uri\":\"$F/meta/idn.json\",\"marketCapSol\":31.5}}"
sleep 1
[ "$(curl -s $A/api/feed | j "o.events.filter(e=>e.type==='launch'&&e.mint==='$IDN').length")" = 1 ] && ok "only one launch event" || bad dup x

echo "== fallback: a coin the stream never mentions"
admin POST /admin/watch "{\"mint\":\"$FALLBACK\"}" | grep -q watching && ok "added second pre-ground address via admin" || bad admin x
fpost /ctl/meta "{\"id\":\"fb\",\"json\":{\"name\":\"Fire\",\"symbol\":\"FIRE\",\"image\":\"https://ipfs.io/ipfs/QmFire\"}}"
fpost /ctl/live "{\"mint\":\"$FALLBACK\",\"asset\":{\"content\":{\"json_uri\":\"$F/meta/fb.json\",\"metadata\":{\"name\":\"Fire\",\"symbol\":\"FIRE\"}}}}"
for i in $(seq 1 10); do [ -n "$(coin $FALLBACK .name)" ] && break; sleep 1; done
[ "$(coin $FALLBACK .name)" = Fire ] && ok "picked up by the poller with name + image" || bad fallback "$(coin $FALLBACK)"

echo "== adding an address that's already live -> shown immediately"
fpost /ctl/meta "{\"id\":\"late\",\"json\":{\"name\":\"Late\",\"symbol\":\"LT\",\"image\":\"https://ipfs.io/ipfs/QmLate\"}}"
fpost /ctl/live "{\"mint\":\"$LATE\",\"asset\":{\"content\":{\"json_uri\":\"$F/meta/late.json\"}}}"
[ "$(admin POST /admin/watch "{\"mint\":\"$LATE\"}" | j o.status)" = live ] && ok "status live" || bad late x
[ "$(coin $LATE .name)" = Late ] && ok "on the site right away" || bad late2 x

echo "== image missing at launch -> retried, fixed by refresh"
fpost /ctl/meta "{\"id\":\"bad\",\"json\":{\"name\":\"Slow\",\"symbol\":\"SLW\"}}"
admin POST /admin/watch "{\"mint\":\"$BADMETA\"}" >/dev/null
fpost /ctl/emit "{\"msg\":{\"txType\":\"create\",\"signature\":\"sigBad\",\"mint\":\"$BADMETA\",\"uri\":\"$F/meta/bad.json\",\"marketCapSol\":30}}"
sleep 1
[ "$(coin $BADMETA .name)" = Slow ] && [ -z "$(coin $BADMETA .imageUri)" ] && ok "added without image, marked for retry" || bad "badmeta" "$(coin $BADMETA)"
fpost /ctl/meta "{\"id\":\"bad\",\"json\":{\"name\":\"Slow\",\"symbol\":\"SLW\",\"image\":\"https://ipfs.io/ipfs/QmSlow\"}}"
fpost /ctl/live "{\"mint\":\"$BADMETA\",\"asset\":{\"content\":{\"json_uri\":\"$F/meta/bad.json\"}}}"
admin POST /admin/coins/$BADMETA/refresh >/dev/null
[ "$(coin $BADMETA .imageUri)" = "https://ipfs.io/ipfs/QmSlow" ] && ok "image filled in after refresh" || bad refresh "$(coin $BADMETA .imageUri)"

echo "== admin protection"
C=$(curl -s -o /dev/null -w '%{http_code}' -XPOST $A/admin/watch -H 'authorization: Bearer nope' -H 'content-type: application/json' -d "{\"mint\":\"$OTHER\"}")
[ "$C" = 401 ] && ok "wrong admin token rejected" || bad "admin auth" "$C"
admin POST /admin/watch '{"mint":"not-an-address"}' | grep -q "not a valid" && ok "invalid address rejected" || bad invalid x

echo "== ordering and removal"
[ "$(curl -s $A/api/coins | j o.coins[0].address)" = "$IDN" ] && ok "featured identity pinned first" || bad order "$(curl -s $A/api/coins | j 'o.coins.map(c=>c.symbol)')"
admin DELETE /admin/coins/$LATE >/dev/null
[ -z "$(coin $LATE .name)" ] && ok "coin removed from the site" || bad delete x

echo; echo "RESULT: $PASS passed, $FAIL failed"
