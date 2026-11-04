// @ts-check
// Motion shapes: the points a motion's shape starts from, over one cycle (u 0 to 1), each reached
// from the point before by its ease, LINEAR when it has none (the engine's Point, shape_value in
// src/mech/animation.odin; the engine draws them, the "motion" query). The curve editor's buttons
// start from these; after, a shape is whatever the artist drags it into. A shape repeats every
// cycle; a one-shot (a pulse, a hit) is one that ends where it starts, so repeating changes nothing.

/** @typedef {{u?: number, v?: number, ease?: string}} Point */

/** a sine: up to 1 a quarter in, down to -1 three quarters in @returns {Point[]} */
export const sine = () => [{ u: 0.25, v: 1 }, { u: 0.75, v: -1 }];

/** a foot sliding: from half ahead, back to half behind while down (`duty` of the cycle), then swinging back ahead @returns {Point[]} */
export const slide = (duty = 0.6) => [{ u: 0, v: 0.5 }, { u: duty, v: -0.5 }, { u: 1, v: 0.5 }];

/** a foot lifting: down while it slides back, then up to 1 and back down as it swings @returns {Point[]} */
export const lift = (duty = 0.6) => [{ u: duty, v: 0 }, { u: (1 + duty) / 2, v: 1, ease: "OUT" }, { u: 1, v: 0, ease: "IN" }];

/** a strike's pulse: rising to 1 by `ease` over `rise` of it, settling back @returns {Point[]} */
export const pulse = (rise = 0.4, ease = "IN") => [{ u: 0, v: 0 }, { u: rise, v: 1, ease }, { u: 1, v: 0 }];

// Mechanical shapes: moves that stop hard (SETTLE bounces on the stop, STEP snaps) and hold,
// rather than ease to and fro.

/**
 * a servo swinging between its stops: at 1 around a quarter in, -1 around three quarters (as a
 * sine is), each move taking `move` of the cycle and arriving by `ease` @returns {Point[]}
 */
export const square = (move = 0.3, ease = "SETTLE") => [
  { u: move / 2, v: 1, ease },
  { u: 0.5 - move / 2, v: 1 },
  { u: 0.5 + move / 2, v: -1, ease },
  { u: 1 - move / 2, v: -1 },
];

/** a bounce: 1 at 0, a hard landing (falling faster and faster into it), rising out of it to 0 halfway, slowing: a body coming down on each step, lowest as the foot lands @returns {Point[]} */
export const bounce = () => [{ u: 0, v: 1, ease: "IN" }, { u: 0.5, v: 0, ease: "OUT" }];

/** a hit: still until `start`, into 1 by `ease` over `rise`, held for `hold`, settling back by the end @returns {Point[]} */
export const hit = (start = 0.2, rise = 0.15, hold = 0.2, ease = "SETTLE") =>
  [{ u: 0, v: 0 }, { u: start, v: 0 }, { u: start + rise, v: 1, ease }, { u: start + rise + hold, v: 1 }, { u: 1, v: 0 }].filter((p, i) => i !== 1 || start > 0);

/** a ratchet: from -1 up to 1 in `n` steps, then back down, each step arriving by `ease` and held (STEP: snapping) @returns {Point[]} */
export const steps = (n = 4, ease = "SETTLE") =>
  Array.from({ length: 2 * n }, (_, i) => ({ u: r4(i / (2 * n)), v: r4(i <= n ? -1 + (2 * i) / n : 1 - (2 * (i - n)) / n), ease }));

const r4 = (/** @type {number} */ v) => Math.round(v * 1e4) / 1e4;

/** the curve editor's starting shapes @type {{name: string, title: string, points: () => Point[]}[]} */
export const SHAPES = [
  { name: "Hold", title: "No shape: its amounts held throughout (a pose, a crouch)", points: () => [] },
  { name: "Sine", title: "To and fro: a sway, a swing, a bob, a wave", points: sine },
  { name: "Slide", title: "A foot sliding back while down, swinging ahead", points: slide },
  { name: "Lift", title: "A foot lifting as it swings", points: lift },
  { name: "Pulse", title: "Rising into its amounts, settling back (a strike)", points: pulse },
  { name: "Square", title: "A servo swinging between stops, bouncing on each: an arm, a hull, a hip", points: square },
  { name: "Bounce", title: "Landing hard, rising out of it: a body coming down on each step", points: bounce },
  { name: "Hit", title: "Still, driven into its amounts, bouncing on the stop, held, settling back (a strike)", points: hit },
  { name: "Steps", title: "A ratchet stepping up and back, each step settling: a scan, a salvo", points: steps },
];

/** the starting shape a motion's points are, or "" @param {any} mo */
export function shapeName(mo) {
  const same = (/** @type {Point[]} */ a, /** @type {Point[]} */ b) =>
    a.length === b.length && a.every((p, i) => Math.abs((p.u ?? 0) - (b[i].u ?? 0)) < 1e-3 && Math.abs((p.v ?? 0) - (b[i].v ?? 0)) < 1e-3 && (p.ease ?? "LINEAR") === (b[i].ease ?? "LINEAR"));
  return SHAPES.find((s) => same(mo.shape ?? [], s.points()))?.name ?? (mo.shape?.length ? "Shape" : "Hold");
}

/** a motion's name in lists: its own (Motion.name), else its shape and what it moves @param {any} mo */
export function motionLabel(mo) {
  if (mo.name) return mo.name;
  const names = [...new Set((mo.moves ?? []).flatMap((/** @type {any} */ mv) => [mv.by, mv.poses, mv.arcs].flatMap((x) => Object.keys(x ?? {}))))];
  const what = names.length ? names.slice(0, 2).join(", ") + (names.length > 2 ? ` +${names.length - 2}` : "") : "nothing yet";
  return `${shapeName(mo)}: ${what}`;
}
