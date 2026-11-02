// @ts-check
// Procedural clips: presets that make a walk, a run or a slither from the model as it stands, for
// the engine's Gait (src/mech/animation.odin: legs on IK targets, a root that crouches and bobs,
// swings, waves down chains). Authoring only: the engine samples the clip, the editor picks
// sensible numbers. Lengths are model units, measured on the rest pose (the "parts" query).
import { editor } from "./editor.js";
import { instanceIndex, uniqueName } from "./model.js";

/** @typedef {{name: string, label: string, kind: "biped" | "quadruped" | "snake"}} Preset */

/** @type {Preset[]} */
export const PRESETS = [
  { name: "walk", label: "Biped walk (human, bird, a dog on two legs)", kind: "biped" },
  { name: "run", label: "Biped run", kind: "biped" },
  { name: "walk", label: "Quadruped walk (cat, dog)", kind: "quadruped" },
  { name: "trot", label: "Quadruped trot", kind: "quadruped" },
  { name: "gallop", label: "Quadruped gallop", kind: "quadruped" },
  { name: "slither", label: "Snake slither", kind: "snake" },
];

/**
 * The numbers each preset starts from: a cycle `duration` (seconds), `duty` (share of a cycle a
 * foot is down), and lengths as multiples of the legs' length: `stride`, `lift`, `crouch`, `bob`;
 * `phases` places each leg's touch-down in the cycle by where it is: [left, right] for bipeds,
 * [left hind, left fore, right hind, right fore] for quadrupeds.
 * @type {Record<string, {duration: number, duty: number, stride: number, lift: number, crouch: number, bob: number, phases: number[]}>}
 */
const GAITS = {
  "Biped walk (human, bird, a dog on two legs)": { duration: 1.1, duty: 0.6, stride: 0.9, lift: 0.25, crouch: 0.06, bob: 0.04, phases: [0, 0.5] },
  "Biped run": { duration: 0.65, duty: 0.35, stride: 1.4, lift: 0.35, crouch: 0.12, bob: 0.08, phases: [0, 0.5] },
  // a lateral-sequence walk: each hind foot, then the fore foot on its side
  "Quadruped walk (cat, dog)": { duration: 1.2, duty: 0.7, stride: 0.8, lift: 0.2, crouch: 0.04, bob: 0.03, phases: [0, 0.25, 0.5, 0.75] },
  // diagonal pairs together
  "Quadruped trot": { duration: 0.7, duty: 0.45, stride: 1.1, lift: 0.3, crouch: 0.06, bob: 0.05, phases: [0, 0.5, 0.5, 0] },
  // hind pair, then fore pair, each a little apart
  "Quadruped gallop": { duration: 0.55, duty: 0.3, stride: 1.8, lift: 0.4, crouch: 0.08, bob: 0.1, phases: [0, 0.55, 0.1, 0.65] },
};

/** the rest pose's instance frames, in model units ("parts" query) @returns {Record<string, number[]>} */
function restFrames() {
  const s = editor.model.scale ?? 1;
  const parts = editor.ask({ q: "parts", rest: true }) ?? {};
  return Object.fromEntries(Object.entries(parts).map(([n, f]) => [n, /** @type {any} */ (f).position.map((/** @type {number} */ c) => c / s)]));
}

/**
 * legs are the model's planted feet: its IK targets that `hold` their tip's facing; when it has
 * none, IK targets are made on the lowest leaf instances (feet), each reaching from two instances
 * above (a thigh), holding. Each with its rest tip and length (thigh to foot).
 * @param {any} m @param {Record<string, number[]>} at
 * @returns {{ik: string, tip: number[], length: number}[]}
 */
function legs(m, at) {
  let iks = (m.iks ?? []).filter((/** @type {any} */ ik) => ik.hold);
  if (!iks.length) {
    const ys = Object.values(at).map((p) => p[1]);
    const low = Math.min(...ys);
    const height = Math.max(...ys) - low || 1;
    const leaves = (m.assembly ?? []).filter((/** @type {any} */ x) => !(m.assembly ?? []).some((/** @type {any} */ y) => y.parent === x.name));
    for (const foot of leaves) {
      if ((at[foot.name]?.[1] ?? Infinity) > low + 0.15 * height) continue;
      let root = foot;
      for (let k = 0; k < 2 && root.parent; k++) root = m.assembly[instanceIndex(m, root.parent)];
      if (root === foot) continue;
      m.iks ??= [];
      const name = uniqueName(`${foot.name}_leg`, (n) => m.iks.some((/** @type {any} */ x) => x.name === n));
      m.iks.push({ name, root: root.name, tip: foot.name, hold: true });
    }
    iks = (m.iks ?? []).filter((/** @type {any} */ ik) => ik.hold);
  }
  return iks.map((/** @type {any} */ ik) => {
    const tip = at[ik.tip] ?? [0, 0, 0];
    const top = at[ik.root] ?? tip;
    return { ik: ik.name, tip, length: Math.hypot(...top.map((c, i) => c - tip[i])) || 1 };
  });
}

/**
 * the longest chain of instances whose joints turn about y, from the root down: a snake's spine
 * @param {any} m @returns {{from: string, to: string} | null}
 */
function spine(m) {
  const turnsY = (/** @type {any} */ x) => (m.parts ?? []).find((/** @type {any} */ p) => p.name === x.part)?.joints?.some((/** @type {any} */ j) => j.kind === "BALL" || j.kind === "SPIN");
  /** @type {{from: string, to: string, n: number} | null} */
  let best = null;
  for (const leaf of (m.assembly ?? []).filter((/** @type {any} */ x) => !(m.assembly ?? []).some((/** @type {any} */ y) => y.parent === x.name))) {
    let n = 0;
    let from = leaf.name;
    for (let x = leaf; x; x = m.assembly[instanceIndex(m, x.parent)]) if (turnsY(x)) (n++, (from = x.name));
    if (!best || n > best.n) best = { from, to: leaf.name, n };
  }
  return best && best.n > 1 ? best : null;
}

/**
 * makeClip adds the procedural clip a preset makes for the model (making leg IK targets when it
 * needs them, see legs). Returns its index, or an error to show.
 * @param {any} m @param {any} a @param {Preset} preset @returns {number | string}
 */
export function makeClip(m, a, preset) {
  a.clips ??= [];
  const name = uniqueName(preset.name, (n) => a.clips.some((/** @type {any} */ x) => x.name === n));
  if (preset.kind === "snake") {
    const s = spine(m);
    if (!s) return "No chain of turning joints to slither with";
    a.clips.push({ name, duration: 1.5, gait: { waves: [{ from: s.from, to: s.to, axis: "Y", amount: 0.3, length: 1, taper: 0.5 }] } });
    return a.clips.length - 1;
  }
  const at = restFrames();
  const found = legs(m, at);
  const want = preset.kind === "biped" ? 2 : 4;
  if (found.length < want) return `A ${preset.kind} needs ${want} legs: found ${found.length} feet (IK targets that hold, or low leaf instances)`;
  const g = GAITS[preset.label];
  // order the legs by the presets' places: biped left, right; quadruped by side, hind first
  const side = (/** @type {{tip: number[]}} */ l) => (l.tip[0] >= 0 ? 0 : 1);
  const sorted = [...found].sort((p, q) => side(p) - side(q) || p.tip[2] - q.tip[2]).slice(0, want);
  const length = sorted.reduce((t, l) => t + l.length, 0) / sorted.length;
  const r = (/** @type {number} */ v) => Math.round(v * 1000) / 1000;
  a.clips.push({
    name,
    duration: g.duration,
    gait: {
      stride: r(g.stride * length),
      lift: r(g.lift * length),
      duty: g.duty,
      crouch: r(g.crouch * length),
      bob: r(g.bob * length),
      legs: sorted.map((l, k) => ({ ik: l.ik, phase: g.phases[k] })),
    },
  });
  return a.clips.length - 1;
}

/** whether a clip is procedural: it has a gait @param {any} c */
export const isProcedural = (c) => !!(c?.gait && (c.gait.legs?.length || c.gait.waves?.length || c.gait.swings?.length));
