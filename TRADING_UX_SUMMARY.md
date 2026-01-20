# Trading UX Summary (Client-Only)

This summarizes the client-side trading experience. All server-side Hyperliquid logic has been removed; the UI and trading actions run entirely on the client using the user’s wallet.

## Overview
- Resizable trading panel with tabs: `Trade`, `Positions`, `Orders`, `History`.
- Client uses Hyperliquid HTTP/WebSocket transports for live mids, account states, open orders, fills, TWAPs, and funding.
- Manual and periodic background refresh with a “Syncing…” indicator.
- Wallet connect/disconnect handled on the client; no server involvement in trading or funds movement.

## Entry Points
- Toggle: sidebar Hyperliquid button or `Shift+P` hotkey.
- Panel header: title, manual refresh, and close.
- If wallet is not connected, an inline “Connect Wallet” action appears.

## Trade Tab Flow
1. Market selection
   - Market Type: `Perp` or `Spot`.
   - Symbol: populated from client-fetched meta (`perp` symbols or `/USDC` spot pairs).
2. Order ticket
   - Side: `Buy`/`Sell`.
   - Type: `Limit`, `Market`, `Post Only`, `Trigger (TP/SL)`.
   - Adaptive inputs:
     - Limit: `Price`, `Size`, `Time in Force` (`Gtc` default).
     - Market: `Size`; price auto-uses mid, `FrontendMarket` TIF.
     - Post Only: limit behavior with `Alo` enforced.
     - Trigger: `Trigger Px`, `Trigger as Market|Limit`, optional `Price` (for non-market), `TP|SL`.
   - Reduce Only: Yes/No.
   - Submit shows inline status; fields clear on success.
3. TWAP (perps only)
   - `Size`, `Duration (minutes)`, `Randomize`, `Reduce Only`; submit with inline status.

## Positions Tab
- Perp positions: `coin`, `size`, `entry`, `unrealized PnL`, `leverage (value x type)`.
- Controls: update leverage (value + cross/isolated) and adjust isolated margin (USDC amount, direction).

## Orders Tab
- Open orders per instrument with side and `size @ price`.
- Inline `New Price`/`New Size` edits with `Modify`/`Cancel`.
- TWAP history with status; active entries expose `Cancel`.

## History Tab
- Fills: recent items showing `coin`, side, and `size @ price`.
- Funding: recent funding deltas per coin (USDC amounts).

## Realtime + Refresh
- Client subscribes to mids and states; updates the UI in real time.
- Manual refresh via header; auto-refresh about every 45 seconds with a syncing indicator.

## Notes and Constraints
- TWAP is exposed for perps only.
- Spot symbols are filtered to `/USDC` pairs.
- All trading actions are client-signed and submitted directly; no server custodial actions or deposits.
