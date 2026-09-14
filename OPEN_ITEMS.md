# Open items

Status as of 2026-09-14.

## Decisions made

- **Chain: BNB Chain (56).** Nimiq Pay's `window.ethereum` supports it ([nimiq.dev](https://nimiq.dev/mini-apps/)). Arbitrum One was dropped: on-chain checks found no DEX liquidity there for any Dinari, Backed or Robinhood stock token, and Dinari's `.d` tokens are KYC-gated.
- **Issuer: Ondo only.** Ondo's official list gives 450 tokens on BNB Chain, all verified on-chain.
- **Routing: Bitget via LI.FI first, KyberSwap fallback.** Bitget fills Ondo stocks near market price where DEX pools are thin (verified by on-chain simulation: $50 of MSFTon, NFLXon, PLTRon or METAon returns $49.81–49.84, versus $13.93–28.11 via KyberSwap).
- **Fair-price guard:** swaps are valued at CoinGecko market prices, never the aggregator's USD estimates (it has valued a PLTRon route at $3.9T). The guard blocks anything over a 5% loss or with an unverifiable price.
- **Fee:** KyberSwap route uses the router's built-in 50 bps fee (simulation-verified at exactly 0.500%). The Bitget route needs LI.FI portal registration to collect it (see Still to do).

## Known limits

- 88 of 450 Ondo tokens are marked tradeable (33 via KyberSwap, 55 more via Bitget). The Bitget re-check stopped at LI.FI's keyless rate limit (75 requests / ~2h per IP), so about 360 tokens are unchecked. Re-run `node scripts/build-catalog.mjs --bitget-only` later. Swaps into unchecked tokens still try Bitget live.
- KyberSwap and LI.FI are used keyless and rate-limited per IP (per user device in the app). CoinGecko's public API also rate-limits; the app retries and uses prices up to 10 minutes old.
- `@nimiq/mini-app-sdk` v0.1.0 has no Nimiq Pay handle → address lookup, so Send takes a wallet address. NIM tips need the recipient's NQ address.
- Ondo excludes US persons (disclosed on Asset Detail).

## Still to do

- [x] Treasury/test wallet created: `0xdDe751c9ECb63Ec99a1217A04B2D212AD521A239` (key kept outside the repo)
- [x] Public repo: github.com/davieslennox0/qorbit-nimiq (MIT)
- [x] Live at https://qorbitpay.xyz (Caddy, static files in /var/www/qorbitpay)
- [x] Listing PR opened: https://github.com/nimiq/awesome/pull/37
- [ ] Register Qorbit at https://portal.li.fi with the treasury as fee wallet, then set `VITE_LIFI_FEE_INTEGRATOR` and redeploy, so the Bitget route collects the 0.5% fee
- [ ] Test end to end inside Nimiq Pay with a small real swap, gift and tip. Confirm Nimiq Pay's provider accepts `wallet_switchEthereumChain` to 0x38 and the SDK NIM send works.
