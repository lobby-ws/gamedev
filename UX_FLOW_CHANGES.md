# UX Flow Changes (current branch vs main)

This summary focuses on user-facing changes under `src/` that alter the in-world UX and UI flow.

- Hyperliquid trading pane
  - New `HyperliquidPane` with resizable side panel for account summary, trading, positions, orders, history.
  - Open/close via Sidebar button (dollar icon) or keyboard shortcut Shift+P.
  - Shows total account value with perps and spot breakdown and a “Syncing…” indicator during background refresh.
  - First-time state: prompts to connect an EVM wallet.

- Wallet connect flow (EVM)
  - New client `EVM` system integrates Wagmi; `CoreUI` mounts the provider and binds wallet state to `world.evm`.
  - In the pane, “Connect Wallet” triggers `world.evm.connect()`; the player’s EVM address is saved on the player entity and synced to other clients.
  - Apps can access EVM via `world.apps.context().evm()`; player proxy exposes `player.evm`, `player.connect()`, and `player.disconnect()`.

- Trading and orders
  - Market selection: Perp or Spot, with symbol pickers fed by live metadata; mid prices shown per market.
  - Order entry: limit/market, time-in-force (default GTC), side toggle, size and price inputs, optional reduce-only.
  - Manage: cancel/modify open orders; view positions and fills; TWAP placement (size, minutes, randomize, reduce-only) with cancel support.

- Deposits
  - Deposit form inside the pane with amount entry and status feedback; submits via `world.evm.deposit(...)`.
  - Server snapshot includes `hl.isTestnet`; `/hl status` chat command (admin) reports network and destination address.

- Navigation and menus
  - Sidebar now includes the Hyperliquid toggle button; listens for live status and hyperliquid visibility events.
  - Permissions in main menu switch to `useRank(...)` for admin/builder gating, affecting which controls are visible.

- UI system updates
  - `ClientUI` tracks `hyperliquid` visibility and emits updates; `world.ui.toggleHyperliquid()` wired to open/close the pane.
  - Network layer adds EVM/HL packet handlers to drive wallet status, config, deposits, and data refreshes.

Overall, users can now connect an EVM wallet in-world, open a dedicated trading pane from the sidebar or via Shift+P, view balances and mid-prices, place/cancel/modify orders (including TWAP), and deposit funds, with state synced across clients and governed by server-provided HL config.

