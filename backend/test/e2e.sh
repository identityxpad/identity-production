#!/usr/bin/env bash
# End-to-end test of the Identity API + real worker code (with a CPU grinder stand-in).
A=http://127.0.0.1:8099
W1=7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
W2=9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM
PASS=0; FAIL=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1  -> $2"; FAIL=$((FAIL+1)); }
post() { curl -s -XPOST "$A$1" -H 'content-type: application/json' -d "$2"; }
jget() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);console.log(o$1 ?? '')}catch{console.log('')}})"; }
waitready() { for i in $(seq 1 180); do S=$(curl -s $A/api/grind/$1); [ "$(echo "$S" | jget .status)" = ready ] && { echo "$S"; return; }; sleep 1; done; echo "$S"; }

echo "== ticker checks"
[ "$(curl -s "$A/api/check?ticker=4k" | jget .ok)" = true ] && ok "valid ticker accepted" || bad "valid ticker" x
[ "$(curl -s "$A/api/check?ticker=lol" | jget .ok)" = false ] && ok "ticker with 'l' rejected" || bad "l ticker" x
[ "$(curl -s "$A/api/check?ticker=a" | jget .ok)" = false ] && ok "1-char ticker rejected" || bad "short" x

echo "== grind: request, worker grinds, address comes back"
R=$(post /api/grind "{\"ticker\":\"4k\",\"wallet\":\"$W1\"}"); JOB=$(echo "$R" | jget .jobId)
[ -n "$JOB" ] && ok "job queued (id $JOB)" || bad "queue" "$R"
S=$(waitready $JOB); PK=$(echo "$S" | jget .pubkey); KID=$(echo "$S" | jget .keypairId)
[ "$(echo "$S" | jget .status)" = ready ] && ok "worker delivered address $PK" || bad "grind never finished" "$S"
echo "$PK" | tr A-Z a-z | grep -q "^4k" && ok "address starts with 4k (case-insensitive)" || bad "prefix" "$PK"

echo "== same wallet asks again -> gets its held address, no new grind"
R=$(post /api/grind "{\"ticker\":\"4k\",\"wallet\":\"$W1\"}")
[ "$(echo "$R" | jget .pubkey)" = "$PK" ] && ok "held address returned" || bad "held" "$R"

echo "== another wallet can't see or take that address"
R=$(post /api/grind "{\"ticker\":\"4k\",\"wallet\":\"$W2\"}"); J2=$(echo "$R" | jget .jobId)
[ "$(echo "$R" | jget .pubkey)" != "$PK" ] && ok "second wallet gets its own job" || bad "leak" "$R"
S2=$(waitready $J2); PK2=$(echo "$S2" | jget .pubkey); KID2=$(echo "$S2" | jget .keypairId)
[ -n "$PK2" ] && [ "$PK2" != "$PK" ] && ok "second wallet got a different address" || bad "dup address" "$S2"

echo "== limits"
R=$(post /api/grind "{\"ticker\":\"zz\",\"wallet\":\"bad-wallet\"}")
echo "$R" | grep -q "not valid" && ok "invalid wallet rejected" || bad "invalid wallet" "$R"

echo "== pool: pre-ground addresses get handed out instantly"
sleep 8
POOLN=$(psql -h 127.0.0.1 -p 5433 -U postgres -d identity -tAc "select count(*) from keypairs where status='available'")
[ "$POOLN" -ge 1 ] && ok "pool has $POOLN ready address(es)" || bad "pool empty" "$POOLN"
PP=$(psql -h 127.0.0.1 -p 5433 -U postgres -d identity -tAc "select prefix from keypairs where status='available' limit 1")
if [ -n "$PP" ]; then
  R=$(post /api/grind "{\"ticker\":\"$PP\",\"wallet\":\"$W2\"}")
  [ "$(echo "$R" | jget .source)" = pool ] && ok "'$PP' served from pool instantly" || bad "pool serve" "$R"
fi

echo "== expired reservation goes back to the pool"
psql -h 127.0.0.1 -p 5433 -U postgres -d identity -qc "update keypairs set reserved_until=now()-interval '1 minute' where pubkey='$PK'"
sleep 17
ST=$(psql -h 127.0.0.1 -p 5433 -U postgres -d identity -tAc "select status from keypairs where pubkey='$PK'")
[ "$ST" = available ] && ok "expired reservation released" || bad "release" "$ST"

echo "== worker security"
C=$(curl -s -o /dev/null -w '%{http_code}' -XPOST $A/worker/claim -H 'authorization: Bearer wrong' -H 'content-type: application/json' -d '{"worker":"x","maxLen":8}')
[ "$C" = 401 ] && ok "wrong worker token rejected" || bad "auth" "$C"
psql -h 127.0.0.1 -p 5433 -U postgres -d identity -qc "insert into grind_jobs (prefix, wallet, status, worker, lease_until) values ('ff','$W1','running','evil', now()+interval '1 hour')"
FJ=$(psql -h 127.0.0.1 -p 5433 -U postgres -d identity -tAc "select id from grind_jobs where worker='evil'")
R=$(curl -s -XPOST $A/worker/complete -H 'authorization: Bearer testtoken123' -H 'content-type: application/json' -d "{\"jobId\":$FJ,\"worker\":\"evil\",\"pubkey\":\"ffakeKeyfffffffffffffffffffffffffffffffffff\",\"sealedSecret\":\"AAAA\"}")
echo "$R" | grep -qi error && ok "forged key rejected" || bad "forged key accepted" "$R"

echo "== failing job stops after 3 tries"
for i in 1 2 3; do
  psql -h 127.0.0.1 -p 5433 -U postgres -d identity -qc "update grind_jobs set status='running', worker='evil' where id=$FJ"
  curl -s -XPOST $A/worker/fail -H 'authorization: Bearer testtoken123' -H 'content-type: application/json' -d "{\"jobId\":$FJ,\"worker\":\"evil\",\"error\":\"boom\"}" >/dev/null
done
ST=$(psql -h 127.0.0.1 -p 5433 -U postgres -d identity -tAc "select status from grind_jobs where id=$FJ")
[ "$ST" = failed ] && ok "job marked failed after 3 tries" || bad "retry cap" "$ST"

echo "== key safety in the database"
PLAIN=$(psql -h 127.0.0.1 -p 5433 -U postgres -d identity -tAc "select count(*) from keypairs where sealed_secret like '[%'")
[ "$PLAIN" = 0 ] && ok "no plain-text keys stored (all sealed)" || bad "plain keys" "$PLAIN"

echo "== site endpoints"
[ -n "$(curl -s $A/api/stats | jget .addressesGround)" ] && ok "/api/stats" || bad stats x
curl -s "$A/api/coins" | grep -q '"coins"' && ok "/api/coins" || bad coins x
curl -s "$A/api/feed" | grep -q '"events"' && ok "/api/feed" || bad feed x

echo "== launch endpoints fail cleanly (PumpPortal is unreachable from this sandbox)"
R=$(post /api/launch/prepare "{\"keypairId\":$KID2,\"wallet\":\"$W2\",\"name\":\"Test\",\"symbol\":\"4k\",\"metadataUri\":\"https://example.com/m.json\"}")
echo "$R" | grep -q error && ok "prepare returns a clear error, server stays up: $(echo "$R" | jget .error | cut -c1-70)" || bad prepare "$R"
R=$(post /api/launch/submit '{"launchId":"00000000-0000-0000-0000-000000000000","signedTransaction":"AA=="}')
echo "$R" | grep -q error && ok "submit with unknown launch rejected" || bad submit "$R"
[ "$(curl -s $A/api/health | jget .ok)" = true ] && ok "API still healthy after everything" || bad health x

echo; echo "RESULT: $PASS passed, $FAIL failed"
