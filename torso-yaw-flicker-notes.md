# Torso Yaw Flicker Notes

## Context
We needed a `torsoYaw` arg on `applyEffect` to offset upper‑body emotes (e.g. "idle aim pistol") so the torso can be rotated independently of locomotion emotes.

## Baseline (before torsoYaw)
- Head/neck gaze flicker was traced to emote loop resets pulling aim toward the emote pose.
- Fix: in `aimBone`, blend toward `smoothState.current` instead of `bone.quaternion` when `weight < 1.0`.
- Result: flicker resolved for gaze.

## TorsoYaw implementation (current goal)
- Added `torsoYaw` support and applied a yaw offset across `spine`, `chest`, and `upperChest` during upper‑body emotes.
- This reintroduced a small but noticeable flicker tied to emote loop resets.

## What We Tried
1. **Per‑bone smoothing for torso yaw**
- Applied yaw by smoothing a per‑bone state (`state.current`) so the yaw doesn’t snap each frame.
- Result: huge improvement (about 98% → 2% visible flicker).

2. **Smooth the base animation pose before yaw**
- Added `state.anim` to smooth the emote‑driven bone pose, then apply yaw on top.
- Result: even better (about 2% → 0.5% visible flicker).

3. **Loop‑fade yaw strength (abandoned)**
- Detected emote loop and faded yaw strength back in during a short window.
- Result: caused the torso to briefly rotate the opposite way; visually worse.

4. **Loop‑freeze yaw (abandoned)**
- On emote loop, disabled yaw briefly (0.08s).
- Result: also worse; visible snap due to yaw dropping to zero.

## Current State
- The last two loop‑handling attempts were reverted and committed by the user.
- Best result so far is the "smooth anim pose then apply yaw" version, but a small flicker remains on emote loop.

## Remaining Issues
- The last 0.5% flicker appears tied to emote loop reset interacting with torso yaw.

## Next Ideas (not implemented)
- Apply torso yaw to a single bone only (e.g., `chest`) to reduce instability.
- Detect loop and temporarily increase the smoothing amount without changing yaw direction or strength.
- Optionally apply a low‑pass filter to the yaw angle itself rather than bone transforms.

