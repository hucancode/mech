// @ts-check
import { apply, normalize, reflection } from "./math3.js";
// Mirroring to the other side of the body (x to -x). The engine reflects a `mirror` instance's
// part, slots and drives itself (mech.joint_mirror); the editor only makes the other side's slot on
// a part on the centre line: this side's, reflected across the model's x as the part holds it.

/** @typedef {{position?: number[], normal?: number[], forward?: number[]}} Face */

/** @param {number[]} v */
const clean = (v) => v.map((c) => Math.round(c * 1e5) / 1e5 || 0);

/**
 * reflectSlot is a slot reflected across `lateral` (the model's x in its part's frame), its
 * forward turned over to stay right-handed.
 * @param {Face} s @param {number[]} lateral
 * @returns {{position: number[], normal: number[], forward: number[]}}
 */
export function reflectSlot(s, lateral) {
  const t = reflection(normalize(lateral));
  return {
    position: clean(apply(t, s.position ?? [0, 0, 0])),
    normal: clean(apply(t, s.normal ?? [0, -1, 0])),
    forward: clean(apply(t, s.forward ?? [1, 0, 0]).map((c) => -c)),
  };
}
