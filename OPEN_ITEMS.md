# Open items

Status as of 2026-09-14.

## Decisions made

- **Chain: BNB Chain (56).** Nimiq Pay's `window.ethereum` supports it ([nimiq.dev](https://nimiq.dev/mini-apps/)). Arbitrum One was dropped: on-chain checks found no DEX liquidity there for any Dinari, Backed or Robinhood stock token, and Dinari's `.d` tokens are KYC-gated.
- **Issuer: Ondo only.** Ondo's official list gives 450 tokens on BNB Chain, all verified on-chain.
- **Routing: KyberSwap aggregator** instead of a single DEX. It reaches market-maker quotes, Uniswap v4 and PancakeSwap Infinity liquidity that direct V3 pools don't have.
- **Fair-price guard:** swaps are valued at CoinGecko market prices, never the aggregator's USD estimates (it has valued a PLTRon route at $3.9T). The guard blocks anything over a 5% loss or with an unverifiable price.
- **Fee:** KyberSwap's built-in router fee (50 bps on output). Verified with an on-chain simulation: the fee recipient got exactly 0.500% and the user got exactly the quoted amount. No custom contract, nothing to deploy.

## Known limits

- Only 33 of 450 Ondo tokens pass the $50 fair-price probe today (e.g. SPY, NVDA, TSLA, AAPL, AMZN, GOOGL, QQQ, COIN, AMD). MSFTon, METAon, NFLXon and PLTRon lose 44–72% on a $50 buy, so their swaps are blocked. The Market defaults to "Tradeable now".
- The KyberSwap keyless endpoint is rate-limited. The API gateway needs a key, which a no-backend app can't hold safely.
- `@nimiq/mini-app-sdk` v0.1.0 has no Nimiq Pay handle → address lookup, so Send takes a wallet address. NIM tips need the recipient's NQ address.
- Ondo excludes US persons (disclosed on Asset Detail).

## Still to do

- [x] Treasury/test wallet created: `0xdDe751c9ECb63Ec99a1217A04B2D212AD521A239` (key kept outside the repo)
- [x] Public repo: github.com/davieslennox0/qorbit-nimiq (MIT)
- [x] Live at https://qorbitpay.xyz (Caddy, static files in /var/www/qorbitpay)
- [x] Listing PR opened: https://github.com/nimiq/awesome/pull/37
- [ ] Test end to end inside Nimiq Pay with a small real swap, gift and tip. Confirm Nimiq Pay's provider accepts `wallet_switchEthereumChain` to 0x38 and the SDK NIM send works.
