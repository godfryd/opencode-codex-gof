import { RGBA } from '@opentui/core';

export function mix(a: RGBA, b: RGBA, t: number): RGBA {
  return RGBA.fromValues(
    a.r * (1 - t) + b.r * t,
    a.g * (1 - t) + b.g * t,
    a.b * (1 - t) + b.b * t,
    1,
  );
}
