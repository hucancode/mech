// @ts-check
// Helpers over model and animation data: the part tree, names, channel groups, renames. Data
// only; anything the game computes, the viewer computes (src/viewer/query.odin).

export const PRIMITIVES = ["BOX", "WEDGE", "CYLINDER", "HALF_CYLINDER", "QUARTER_CYLINDER", "CONE", "SPHERE"];
export const JOINT_KINDS = ["FIXED", "SPIN", "HINGE", "HINGE_TWIST", "PIN", "DISC_HINGE", "WRIST", "BALL"];
export const EASES = ["SMOOTH", "LINEAR", "IN", "OUT"];
export const BLENDS = ["REPLACE", "ADDITIVE"];

// the degrees of freedom of each joint kind, in bind order (docs/modeling.md)
/** @type {Record<string, string[]>} */
export const DOFS = {
  FIXED: [],
  SPIN: ["spin (y)"],
  HINGE: ["hinge (x)"],
  HINGE_TWIST: ["hinge (x)", "twist (y)"],
  PIN: ["pin (x)"],
  DISC_HINGE: ["disc (y)", "hinge (x)", "twist (y)"],
  WRIST: ["bend (x)", "tilt (x')", "twist (y)"],
  BALL: ["pitch (x)", "yaw (y)", "roll (z)"],
};

/** @param {any} m @param {string | undefined} name */
export function partIndex(m, name) {
  if (!name) return -1;
  return (m.parts ?? []).findIndex((/** @type {any} */ p) => p.name === name);
}

/** @param {any} m @param {number} i */
export function depth(m, i) {
  let d = 0;
  for (let p = partIndex(m, m.parts[i].parent); p >= 0 && d < 64; p = partIndex(m, m.parts[p].parent)) d++;
  return d;
}

/** subtreeEnd is one past the last part below part i (parts are listed parents first). @param {any} m @param {number} i */
export function subtreeEnd(m, i) {
  const parts = m.parts ?? [];
  const inside = new Set([i]);
  let end = i + 1;
  for (let k = i + 1; k < parts.length; k++) {
    const p = partIndex(m, parts[k].parent);
    if (p >= 0 && inside.has(p)) {
      inside.add(k);
      end = k + 1;
    }
  }
  return end;
}

/**
 * reparent moves part i, with everything below it, under part `parent` (-1 for a root), keeping
 * parents first. Returns the part's new index (i when the move would put it under itself).
 * @param {any} m @param {number} i @param {number} parent
 */
export function reparent(m, i, parent) {
  const parts = m.parts;
  const end = subtreeEnd(m, i);
  if (parent >= i && parent < end) return i;
  const block = parts.splice(i, end - i);
  const p = parent >= i ? parent - block.length : parent;
  if (p >= 0) block[0].parent = parts[p].name;
  else delete block[0].parent;
  const at = p >= 0 ? subtreeEnd(m, p) : parts.length;
  parts.splice(at, 0, ...block);
  return at;
}

/** @param {string} base @param {(name: string) => boolean} taken */
export function uniqueName(base, taken) {
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base}_${i}`)) return `${base}_${i}`;
}

/** The channels drivers set: a pose or key cannot move them. @param {any} m @returns {Set<string>} */
export function drivenChannels(m) {
  return new Set((m.drivers ?? []).map((/** @type {any} */ d) => d.target).filter(Boolean));
}

const LIMBS = [
  ["hand", ["curl", "wrist", "finger", "thumb"]],
  ["arm", ["shoulder", "arm", "elbow", "fore"]],
  ["leg", ["hip", "knee", "ankle", "leg", "thigh", "shin", "foot"]],
];

/**
 * groupOf sorts a channel into a group: side and limb from its name (l_elbow: "Left arm"), a
 * numbered chain by its stem (segment_3_yaw: "Segment"), else "Body".
 * @param {string} name
 */
export function groupOf(name) {
  let side = "";
  let rest = name;
  if (name.startsWith("l_")) [side, rest] = ["Left ", name.slice(2)];
  else if (name.startsWith("r_")) [side, rest] = ["Right ", name.slice(2)];
  // limbs come in sides; an unsided name (hip_level) belongs to the body
  if (side) for (const [limb, words] of LIMBS) if (/** @type {string[]} */ (words).some((w) => rest.startsWith(w))) return cap(`${side}${limb}`);
  const chain = /^([a-z]+)_\d+_/.exec(rest);
  if (chain) return cap(chain[1]);
  return side ? `${side.trim()} side` : "Body";
}

/** @param {string} s */
const cap = (s) => s[0].toUpperCase() + s.slice(1);

/**
 * @param {any[]} channels
 * @param {Set<string>} [skip]
 * @returns {[string, any[]][]}
 */
export function groupChannels(channels, skip) {
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const c of channels) {
    if (skip?.has(c.name)) continue;
    const g = groupOf(c.name);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)?.push(c);
  }
  return [...groups];
}

/**
 * A channel's slider range. Files leave out zero fields, so a missing bound is 0; with no range at
 * all it is a half turn each way.
 * @param {any} c @returns {[number, number]}
 */
export function channelRange(c) {
  const lo = c.min ?? 0;
  const hi = c.max ?? 0;
  if (lo === 0 && hi === 0) return [-Math.PI, Math.PI];
  return lo < hi ? [lo, hi] : [lo, lo + 1];
}

/** a deep copy of plain data @template T @param {T} v @returns {T} */
export const clone = (v) => JSON.parse(JSON.stringify(v));

// ---- renames, carried through everything that names the thing --------------------------------

/** @param {any} m @param {string} from @param {string} to */
export function renamePart(m, from, to) {
  for (const p of m.parts ?? []) if (p.parent === from) p.parent = to;
}

/** @param {any} m @param {string} from @param {string} to */
export function renameMaterial(m, from, to) {
  for (const p of m.parts ?? []) for (const s of p.shapes ?? []) if (s.material === from) s.material = to;
  for (const k of ["female", "male", "metal"]) if (m.hardware?.[k] === from) m.hardware[k] = to;
}

/** @param {any} m @param {string} from @param {string} to */
export function renameJoint(m, from, to) {
  for (const p of m.parts ?? []) if (p.joint === from) p.joint = to;
}

/** A channel rename also moves the open animation's values. @param {any} m @param {any} a @param {string} from @param {string} to */
export function renameChannel(m, a, from, to) {
  for (const p of m.parts ?? []) for (const b of p.binds ?? []) if (b.channel === from) b.channel = to;
  for (const d of m.drivers ?? []) {
    if (d.target === from) d.target = to;
    if (d.source === from) d.source = to;
  }
  for (const l of m.legs ?? []) for (const k of ["hip", "knee", "ankle"]) if (l[k] === from) l[k] = to;
  if (m.level === from) m.level = to;
  /** @param {Record<string, number> | undefined} values */
  const move = (values) => {
    if (values && from in values) {
      values[to] = values[from];
      delete values[from];
    }
  };
  for (const p of a.poses ?? []) move(p.values);
  for (const c of a.clips ?? []) for (const k of c.keys ?? []) move(k.values);
}

/** @param {any} a @param {string} from @param {string} to */
export function renamePose(a, from, to) {
  for (const c of a.clips ?? []) for (const k of c.keys ?? []) if (k.pose === from) k.pose = to;
}

/** @param {any} m @param {any} [parent] */
export function newPart(m, parent) {
  return {
    name: uniqueName("part", (n) => partIndex(m, n) >= 0),
    parent: parent?.name,
    socket: { position: [0, -0.3, 0], normal: [0, -1, 0], forward: [1, 0, 0] },
    mount: { normal: [0, 1, 0], forward: [1, 0, 0] },
    binds: [{}, {}, {}],
    shapes: [{ material: m.materials?.[0]?.name, position: [0, -0.15, 0], size: [0.2, 0.3, 0.2] }],
  };
}
