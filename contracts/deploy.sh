#!/usr/bin/env bash
#
# Deploys FeesClaims + FeesLaunchpad to Robinhood Chain MAINNET and verifies both on Blockscout.
#
#   OWNER=0x… SIGNER=0x… DEPLOYER_KEY_FILE=~/.fees-deployer/deployer.key ./deploy.sh
#
# OWNER  can pause claiming and rotate the signer. It can never take a credited balance.
# SIGNER is the address of CLAIM_SIGNER_KEY in the api's env. It can only sign vouchers.
#
# ⛔⛔ THE CHAIN ID IS NOT ENOUGH TO TELL MAINNET FROM A FORK: an anvil fork answers 4663 too. This
# probes `anvil_nodeInfo`, which only anvil implements, and refuses.
# ⛔ The key is read from a FILE into forge's env, never passed as --private-key, which shows in `ps`.
# ⛔ Forge talks to RHC through scripts/rpc-proxy.mjs: Cloudflare 403s Foundry's User-Agent.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

: "${OWNER:?set OWNER}"; : "${SIGNER:?set SIGNER}"; : "${DEPLOYER_KEY_FILE:?set DEPLOYER_KEY_FILE}"
RPC="${RPC:-http://127.0.0.1:8899}"

if ! lsof -i :8899 >/dev/null 2>&1; then
  node scripts/rpc-proxy.mjs >/tmp/fees-rpc-proxy.log 2>&1 &
  sleep 1
fi

[[ "$(cast chain-id --rpc-url "$RPC")" == "4663" ]] || { echo "FATAL: not chain 4663" >&2; exit 1; }
# ⚠ REHEARSAL=1 is the only way past this, and it also skips Blockscout: it exists so this exact
#    script is run end to end on a fork before it is ever run for real.
if cast rpc anvil_nodeInfo --rpc-url "$RPC" >/dev/null 2>&1; then
  [[ "${REHEARSAL:-}" == "1" ]] || { echo "FATAL: $RPC is an anvil FORK, not mainnet. Refusing." >&2; exit 1; }
  echo "REHEARSAL on a fork: nothing here touches mainnet"
elif [[ "${REHEARSAL:-}" == "1" ]]; then
  echo "FATAL: REHEARSAL=1 against a real node. Refusing." >&2; exit 1
fi

DEPLOYER=$(cast wallet address "$(cat "$DEPLOYER_KEY_FILE")")
echo "deployer $DEPLOYER  balance $(cast balance "$DEPLOYER" --ether --rpc-url "$RPC") ETH"
echo "owner    $OWNER"
echo "signer   $SIGNER"
if [[ "${REHEARSAL:-}" != "1" ]]; then
  read -r -p "Deploy to Robinhood Chain MAINNET? type yes: " ok
  [[ "$ok" == "yes" ]] || { echo "aborted"; exit 1; }
fi

forge build >/dev/null
DEPLOYER_KEY="$(cat "$DEPLOYER_KEY_FILE")" OWNER="$OWNER" SIGNER="$SIGNER" \
  forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast \
  2>&1 | tee /tmp/fees-deploy.log | grep -E "FEES_|Error|error" || true

CLAIMS=$(grep -oE "FEES_CLAIMS=0x[0-9a-fA-F]{40}" /tmp/fees-deploy.log | cut -d= -f2)
PAD=$(grep -oE "FEES_LAUNCHPAD=0x[0-9a-fA-F]{40}" /tmp/fees-deploy.log | cut -d= -f2)
# ⭐ "Did it deploy" is answered by code at the address, never by forge's log: forge has reported
# failure for deploys that succeeded when a receipt was slow.
for a in "$CLAIMS" "$PAD"; do
  [[ -n "$a" && "$(cast code "$a" --rpc-url "$RPC")" != "0x" ]] || { echo "FATAL: no code at '$a'" >&2; exit 1; }
done
[[ "$(cast call "$PAD" 'claims()(address)' --rpc-url "$RPC")" == "$CLAIMS" ]] || { echo "FATAL: launchpad names the wrong claims" >&2; exit 1; }
[[ "$(cast call "$CLAIMS" 'signer()(address)' --rpc-url "$RPC")" == "$SIGNER" ]] || { echo "FATAL: claims signer mismatch" >&2; exit 1; }

OUT=ADDRESSES; [[ "${REHEARSAL:-}" == "1" ]] && OUT=/tmp/fees-ADDRESSES.rehearsal
cat > "$OUT" <<ADDR
# FEES on Robinhood Chain mainnet, deployed $(date -u +%Y-%m-%dT%H:%MZ)
FEES_CLAIMS=$CLAIMS
FEES_LAUNCHPAD=$PAD
OWNER=$OWNER
SIGNER=$SIGNER
ADDR
cat "$OUT"
[[ "${REHEARSAL:-}" == "1" ]] && { echo "rehearsal done (Blockscout skipped)"; exit 0; }

echo "==> verifying on Blockscout (async; a 200 means queued)"
forge verify-contract "$CLAIMS" src/FeesClaims.sol:FeesClaims --show-standard-json-input > /tmp/fees-claims.json
node scripts/verify-blockscout.mjs "$CLAIMS" FeesClaims /tmp/fees-claims.json "$(cast abi-encode 'c(address,address)' "$OWNER" "$SIGNER")" || true
forge verify-contract "$PAD" src/FeesLaunchpad.sol:FeesLaunchpad --show-standard-json-input > /tmp/fees-pad.json
node scripts/verify-blockscout.mjs "$PAD" FeesLaunchpad /tmp/fees-pad.json "$(cast abi-encode 'c(address,address)' 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e "$CLAIMS")" || true
echo "done. Next: VITE_LAUNCHPAD/VITE_CLAIMS in web/.env.production, LAUNCHPAD/CLAIMS_ADDRESS in api.env + keeper.env."
