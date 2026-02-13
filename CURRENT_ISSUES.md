# Toast-Triggered Stuck Movement (WASD)

## Problem Statement

- If a toast appears while moving with `WASD`, movement can get stuck in the current direction.
- Scope is only the toast-triggered case.
- This doc intentionally avoids pointer-lock transition analysis.

## Toast-Related File Map (Primary)

1. `src/client/components/CoreUI.js`
- Toast renderer (`Toast` / `ToastMsg`).
- Global toast UI shown during gameplay.
- First place to check whether toast UI steals/changes focus.

2. `src/client/components/sidebar/utils/ScriptAIController.js`
- Emits toast messages on AI outcomes:
  - success path: `world.emit('toast', successMessage)`
  - error path: `world.emit('toast', message)`
- Most common trigger during script edit/apply flow.

3. `src/client/components/ScriptFilesEditor.js`
- Emits additional toasts (apply/save/revert/etc.) that can trigger the same symptom.

4. `src/core/systems/ClientControls.js`
- Holds key/button state (`buttonsDown`) and keyup/key clearing logic.
- Stuck movement exists here as stale pressed-state.

5. `src/core/entities/PlayerLocal.js`
- Reads `keyW/keyA/keyS/keyD.down` and applies movement direction.
- Visible symptom: continued motion after key should be released.

## Repro (Toast-Only)

1. Hold `W` (or any movement key).
2. Trigger any toast while key is still down (AI apply is easiest).
3. Observe movement remains active/stuck after toast appears.

## Investigation Focus

- Verify whether toast appearance interrupts keyup capture or key-state clearing.
- Track event timing between `world.emit('toast', ...)` and `ClientControls` state updates.
- Confirm this across all toast entry points (AI controller + script editor).
