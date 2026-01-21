 - Goal: Replace the global deploy lock with scoped locks (scope = appName or blueprint id) so concurrent ops across different apps
    work, while same‑app script changes remain serialized.

  ———

  1) Define Lock Semantics + Scope Derivation

  - Scope definition
      - For app‑server deploys: scope = appName.
      - For blueprint ops on the server: derive from blueprint id:
          - $scene → scope $scene
          - appName__Blueprint → scope appName
          - appName (no __) → scope appName
      - For .hyp import (admin client or admin player):
          - When importing a new app, scope = new blueprint id (UUID created in ClientBuilder.addApp).
          - When importing a scene, scope = $scene.
  - Fail fast: if scope is locked, return 409 and client shows “Deploy locked”.
  - Backward compatibility (important):
      - Treat missing scope as global.
      - global lock should block all scopes.
      - Scoped lock should block acquisition of global.
      - This prevents older clients from being bypassed by scoped clients.

  ———

  2) Server: Deploy Lock Storage + Endpoints (Scoped)
  File: src/server/admin.js

  - Replace single deployLock with deployLocks: Map<string, Lock>.
  - Add helper:
      - normalizeLockScope(scope) → 'global' if missing/invalid.
      - getDeployLockStatus(scope) → returns status for scope.
      - ensureDeployLock(token, scope) → verifies lock exists for scope OR global lock; returns deploy_locked if held by others.
  - Update HTTP endpoints:
      - GET /admin/deploy-lock?scope=...
      - POST /admin/deploy-lock { scope, owner, ttl }
      - PUT /admin/deploy-lock { scope, token, ttl }
      - DELETE /admin/deploy-lock { scope, token }
      - If scope omitted, behave as global. For DELETE/PUT, if scope omitted, search token across all scopes (fallback).
  - Update script‑gated admin commands:
      - blueprint_add (if script present) → compute scope from blueprint id; ensureDeployLock(lockToken, scope).
      - blueprint_modify (if script changed) → compute scope from change.id; ensureDeployLock(lockToken, scope).
  - Update deploy snapshots:
      - POST /admin/deploy-snapshots and /rollback accept { scope, lockToken }.
      - Use ensureDeployLock(lockToken, scope).
      - Optional validation: if ids span multiple scopes, return error multi_scope_not_supported.

  ———

  3) Client & App‑Server Callers
  Files: src/core/systems/AdminClient.js, src/core/systems/ClientBuilder.js, app-server/direct.js

  - AdminClient
      - Add deployLockScope property.
      - acquireDeployLock({ owner, ttl, scope }) → include scope in body; store token + scope.
      - releaseDeployLock(token, scope) → include scope if provided (fallback to stored scope).
  - ClientBuilder (.hyp import)
      - When script is present, acquire lock with scope:
          - Scene import: scope $scene.
          - New app import: scope = newly generated blueprint id.
      - Pass lockToken into blueprintAdd/blueprintModify as now.
      - Fail fast with existing toasts on lock errors.
  - Admin HTML (/admin.html) & in‑world admin player
      - No special handling beyond above; both share ClientBuilder.
  - App‑server
      - _acquireDeployLock({ owner, scope: appName }).
      - createDeploySnapshot({ scope: appName }).
      - Release lock with same scope.
      - Ensure per‑app deploys do not block each other.

  ———

  4) Validation / Tests / Docs

  - Tests (ideal integration tests):
      - Acquire lock for appA, ensure appB script change succeeds.
      - Ensure appA script change fails without lock or with wrong scope token.
      - Ensure global lock blocks all scoped actions.
  - Docs:
      - Add a short note in admin/deploy docs about scoped locks.
      - Mention that .hyp imports lock by blueprint id (or $scene).

  ———

  Notes on question 4

  - .hyp imports do not reuse app‑server app names; the blueprint id is new UUID, so lock scope won’t conflict with app‑server unless
    you’re replacing $scene.

  ———