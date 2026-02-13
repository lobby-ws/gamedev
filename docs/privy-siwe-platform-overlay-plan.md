# Privy-Backed SIWE on `worlds/:slug` (Platform Mode)

Status: Draft  
Last Updated: 2026-02-13  
Scope: `world-service` + `runtime` (and existing `privy` integration primitives)

## Goal

Enable social login for platform worlds by wiring Privy embedded wallets into the existing SIWE `/auth/nonce` + `/auth/verify` path, then reuse runtime platform join logic on `/worlds/:slug`.

Target behavior:

- Public platform worlds: guests can still enter.
- Private platform worlds: unauthenticated users can see world page, then login from loading overlay.
- Privy is used for wallet acquisition and signature, not for a new identity token format.
- World-service remains the identity authority for runtime handoff.

## Current baseline (important)

- `world-service` currently serves world pages at `/worlds/:slug` and injects `window.env` (slug + API URL + asset base).
- Existing SIWE endpoints in world-service:
  - `POST /auth/nonce`
  - `POST /auth/verify`
  - `POST /auth/exchange`
- Runtime platform flow currently does:
  - `POST /worlds/:slug/join` → uses `world_connection` token for WS.
- Runtime currently has a standalone SIWE client flow, not wired into platform.

## Plan strategy

Use Privy only as a wallet/signer provider:

1. On world page load, inject Privy web client context.
2. On platform join failure, open runtime overlay login action.
3. Acquire/create Privy embedded wallet and sign the SIWE message.
4. Submit nonce/signature to existing world-service SIWE verifier.
5. Retry `/worlds/:slug/join`.

No new runtime-session or world-connection token types are introduced for this path.

---

## PR-01: Inject Privy auth surface into `world/:slug` HTML

- [ ] Add Privy enablement env contract to world-service config (docs + runtime env read)
- [ ] Update `world-service` `GET /worlds/:slug` HTML response to inject:
  - `PUBLIC_AUTH_PROVIDER='privy'` in `window.env`
  - `PUBLIC_PRIVY_APP_ID`
  - any needed chain config needed by the client-side Privy signer
- [ ] Mount a small client bridge script on the world page that exposes a browser-safe API (for example `window.__lobbyPrivyAuth`) with:
  - `isAvailable()`
  - `getWalletAddress()`
  - `ensureWallet()`
  - `signMessage(message)`
  - `signOut()`
- [ ] Ensure script is loaded before the world runtime bundle.
- [ ] Add explicit flags for UX:
  - page-level auth capability
  - whether private-world overlay login should be enabled.

Dependencies:
- No hard dependency on runtime changes for shipping this unit.
- Blocks PR-02 and PR-03.

Acceptance:
- `/worlds/:slug` HTML includes Privy bootstrap fields and a callable signing API object when enabled.

---

## PR-02: Extend runtime SIWE helper to support external signer adapters

- [ ] Extract SIWE nonce/sign flow into reusable utility module in runtime client code.
- [ ] Add signer abstraction with:
  - built-in `window.ethereum` path (existing behavior)
  - `window.__lobbyPrivyAuth` path (new platform path)
- [ ] Normalize wallet address to EIP-55 before SIWE message generation and verify payload submission.
- [ ] Keep existing error model with retry-friendly signaling:
  - user canceled signer
  - signer unavailable
  - invalid signature

Dependencies:
- Can be done independently, but PR-03 depends on this API shape.
- Requires no changes in world-service once PR-01 lands.

Acceptance:
- Same SIWE inputs and outputs as today, with pluggable signing provider and stable function signature.

---

## PR-03: Add platform-join login fallback in runtime loading flow

- [ ] Update platform flow in `runtime/src/client/index.js`:
  - in legacy platform/join-token mode, detect `PUBLIC_AUTH_PROVIDER=privy` + auth-required status from join.
  - on 401/403 from `/worlds/:slug/join`, surface a retryable auth-required state instead of hard-fail.
- [ ] Wire `LoadingOverlay` to show “Login with Privy” action when auth-required.
- [ ] Add callback to trigger:
  1. Privy auth + embedded wallet creation (if missing)
  2. SIWE nonce/sign flow via new signer adapter
  3. `/auth/verify` call
  4. re-run world join and connection bootstrap
- [ ] Preserve guest fallback semantics:
  - Public world: allow continue as guest when user dismisses/aborts login.
  - Private world: continue as guest only if runtime currently allows it; otherwise remain auth-blocked.

Dependencies:
- PR-01 and PR-02 should be in place.
- PR-05 may be required for private-world overlay behavior.

Acceptance:
- On private/public world load, user can authenticate from the overlay and then join without leaving the page.

---

## PR-04: Ensure platform private-world UX actually reaches the overlay

- [ ] Adjust `GET /worlds/:slug` behavior for unauthenticated private-world requests:
  - instead of returning bare “Authentication required” HTML,
  - serve the standard world page and pass a `requiresAuth` flag so runtime can show overlay flow.
- [ ] Keep join endpoint as enforcement point so existing access checks remain authoritative.
- [ ] Preserve a safe fallback for non-browser API consumers.

Dependencies:
- Depends on PR-01 (Privy/env flags + page contract).
- Required for overlay login to work on private worlds.

Acceptance:
- Browser hit to private world slug renders world page shell and lets runtime attempt join/auth.

---

## PR-05: Harden SIWE handling in world-service verifier for mobile wallets

- [ ] Keep SIWE verifier error-safe:
  - malformed SIWE message -> clean 401 payload, no stack leak.
- [ ] Add validation path for checksummed wallet addresses before/after verification if needed.
- [ ] Add traceable logs for failed SIWE verification by reason (invalid message / bad signature / nonce mismatch).

Dependencies:
- No strict dependency on others; safe to land independently.

Acceptance:
- Privy-backed signing failures return `401` with stable error payload and no generic exception responses.

---

## PR-06: Observability + environment/docs lock-in

- [ ] Add runtime/world-service docs for:
  - `PUBLIC_AUTH_PROVIDER`
  - `PUBLIC_PRIVY_APP_ID`
  - `PUBLIC_WORLD_REQUIRES_AUTH` (if emitted)
- [ ] Update smoke/integration matrix notes for:
  - mobile/social login path
  - overlay-triggered rejoin behavior
- [ ] Add operational troubleshooting notes for:
  - wallet creation timing
  - nonce loops
  - signature/case/corruption errors

Dependencies:
- Can run once PR-01 through PR-04 establish contract.

Acceptance:
- New vars and behavior documented in one canonical doc set.

---

## Dependency summary

- Blocking chain:
  - PR-01 -> PR-02 -> PR-03
  - PR-01 -> PR-04
- Independent:
  - PR-05, PR-06 can be done early or late.

## Completion criteria

- [ ] Privy embedded wallets can be used to produce SIWE signatures from `/worlds/:slug`.
- [ ] Platform join can recover from auth-required state via in-overlay login.
- [ ] Existing SIWE `/auth/verify` contract remains the token exchange boundary.
- [ ] Session semantics remain unchanged for existing non-Privy users when feature is disabled.
