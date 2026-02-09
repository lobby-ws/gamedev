# Head/Neck Gaze Flicker Investigation

## Summary
The head/neck gaze flicker during emote playback was caused by the aim blending logic pulling from the emote pose each frame. When an emote looped, the pose snapped back to frame 0, which briefly yanked the aim target and produced a visible pop.

## Cause
`aimBone` blended the target rotation toward the current bone rotation when `weight < 1.0`:

```js
// previous behavior
if (weight < 1.0) {
  targetRotation.slerp(bone.quaternion, 1.0 - weight)
}
```

Because the emote animation writes to head/neck every frame, `bone.quaternion` reflected the emote pose. On loop reset, the pose snapped, and the aim target was pulled toward that snapped pose for a frame or two.

## Fix
Blend toward the previous aim result instead of the live emote pose:

```js
// current behavior
if (weight < 1.0) {
  targetRotation.slerp(smoothState.current, 1.0 - weight)
}
```

This preserves partial aim while removing the emote loop reset from the blend source.

## Files
- `src/core/extras/createVRMFactory.js` (aim blending change)

## Notes
Debug logging was added to trace update order and emote loop timing, then removed after confirming the fix.
