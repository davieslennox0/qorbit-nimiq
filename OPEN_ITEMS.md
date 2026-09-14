# Open items

Status as of 2026-09-14.

## Decisions made

- **Chain: BNB Chain (56).** Nimiq Pay's `window.ethereum` supports it ([nimiq.dev](https://nimiq.dev/mini-apps/)). Arbitrum One was dropped: on-chain checks found no DEX liquidity there for any Dinari, Backed or Robinhood stock token, and Dinari's `.d` tokens are KYC-gated.
- **Issuers: Ondo + xStocks.** Official lists give 450 Ondo and 828 xStocks tokens on BNB Chain, all verified on-chain (1,278 total).
- **Routing: KyberSwap aggregator** instead of a single DEX. It reaches market-maker quotes, Uniswap v4 and PancakeSwap Infinity liquidity that direct V3 pools don't have. Measured 2026-09-14, $1,000 buys: TSLAon, NVDAon, SPYon and FXIon under 0.4% loss. NVDAx and TSLAx about 75% loss, so xStocks depth on BNB Chain is only good for small trades.
- **Fee:** KyberSwap's built-in router fee (50 bps on output). Verified with an on-chain simulation: the fee recipient got exactly 0.500% and the user got exactly the quoted amount. No custom contract, nothing to deploy.

## Known limits

- Only ~170 of the 1,278 listings route a $50 buy today (156 Ondo, 14 xStocks). The Market defaults to "Tradeable now". Other listings can be held and sent, and swaps show an honest "no route" message.
- 158 xStocks tokens have no CoinGecko id, and xStocks' own price API blocks browser (CORS) requests, so those show "—" for price. None of them is currently tradeable.
- The KyberSwap keyless endpoint is rate-limited. The API gateway needs a key, which a no-backend app can't hold safely.
- `@nimiq/mini-app-sdk` v0.1.0 has no Nimiq Pay handle → address lookup, so Send takes a wallet address. NIM tips need the recipient's NQ address.
- Both issuers exclude US persons (disclosed on Asset Detail).

## Still to do

- [x] Treasury/test wallet created: `0xdDe751c9ECb63Ec99a1217A04B2D212AD521A239` (key kept outside the repo)
- [x] Public repo: github.com/davieslennox0/qorbit-nimiq (MIT)
- [x] Live at https://qorbitpay.xyz (Caddy, static files in /var/www/qorbitpay)
- [ ] Register the Mini App in Nimiq Pay with https://qorbitpay.xyz
- [ ] Test end to end inside Nimiq Pay with a small real swap, gift and tip. Confirm Nimiq Pay's provider accepts `wallet_switchEthereumChain` to 0x38 and the SDK NIM send works.
