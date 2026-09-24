# Fees

**[ponsfees.family](https://ponsfees.family)** · [@usefeesapp](https://x.com/usefeesapp)

Launch a token on [Pons](https://www.ponsfamily.com) (Robinhood Chain) and share its trading fees
with **X, Twitch and GitHub accounts** and wallets. The recipients and their shares are written into
a contract at launch and can never be changed. An account owner signs in to claim their share.

## Contracts (Robinhood Chain, chain id 4663)

| | address |
|---|---|
| `FeesLaunchpad` | [`0x9051D33D639B2aa64E3a3c4Ae20d040515ce4CF2`](https://robinhoodchain.blockscout.com/address/0x9051D33D639B2aa64E3a3c4Ae20d040515ce4CF2) |
| `FeesClaims` | [`0x09C84f7cD48BC01698D4D671C7564e871FC83E9c`](https://robinhoodchain.blockscout.com/address/0x09C84f7cD48BC01698D4D671C7564e871FC83E9c) |

Both verified on Blockscout.

## How it works

1. **`FeesLaunchpad.launch`** deploys a **`FeeSplitter`** with the shares written in, launches the
   token on Pons V2 with that splitter as its fee recipient, and records the launch in an on-chain
   registry. One transaction, so there is never a moment where a token's fees point anywhere else.
2. **`FeeSplitter`** has no owner and no setter. Anyone can call it to sweep the token's fees into
   Pons's escrow and split them: wallet shares are paid directly, and each account's share is
   credited in `FeesClaims` against `keccak256("<provider>:<numeric account id>")`. The constructor
   recomputes that hash from the declared provider and id, so a share cannot claim to be for one
   account while paying another. Accounts are recorded by their permanent id, never their handle.
3. **`FeesClaims`** holds each account's share separately per launch, account and asset. After an
   OAuth sign-in, the API signs a voucher for exactly what that account holds, and the owner
   submits the claim to a wallet of their choosing. The signing key can approve vouchers and
   nothing else; the contract owner can pause claims but can never take a credited share.
4. A **keeper** (`api/keeper.mjs`, every 15 minutes) runs those permissionless steps, and finishes a
   graduation that stalls between the curve and the Uniswap V4 pool.

## Layout

```
contracts/   Foundry: src, tests (unit + a fork test through the real Pons contracts), deploy script
api/         node: logo upload, OAuth (X, GitHub, Twitch), claim vouchers, the keeper
web/         Vite + React front end
```

## Build and test

```sh
# contracts
cd contracts
forge install foundry-rs/forge-std@v1.16.2 OpenZeppelin/openzeppelin-contracts@v5.7.0 --no-git
forge test --no-match-contract Fork
# the fork tests go through the live Pons contracts; Cloudflare refuses Foundry's user agent,
# so run the loopback proxy first:
node scripts/rpc-proxy.mjs & forge test

# api
cd api && npm ci && npm test

# web
cd web && npm ci && npm test && npm run build
```

`api/scripts/rehearse.mjs` and `web/scripts/rehearse-graduation.mjs` run the whole product on an
anvil fork: launch, trades, keeper, sign-in, claims, and a token through graduation into its pool.

## License

MIT
