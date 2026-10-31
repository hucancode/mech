// @ts-check
// Helpers over model and animation data: the part tree, names, channel groups, renames. Data
// only; anything the game computes, the viewer computes (src/viewer/query.odin).

import { partMirror, restRotations } from "./mirror.js";

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

/** The channels some part binds to a joint axis: their values are angles (shown in degrees). @param {any} m @returns {Set<string>} */
export function angularChannels(m) {
  const out = new Set();
  for (const p of m.parts ?? []) for (const b of p.binds ?? []) if (b.channel) out.add(b.channel);
  return out;
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

// ---- authoring helpers ---------------------------------------------------------------------------

/** @typedef {{position: number[], normal: number[]}} Face */
/** The faces query's order: a shape's +x, -x, +y, -y, +z, -z faces. */
export const FACE_NAMES = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"];

/** @param {number[]} a @param {number[]} b */
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** @param {number} v */
const r5 = (v) => Math.round(v * 1e5) / 1e5 || 0;
/** @param {number[]} v */
const round = (v) => v.map(r5);

/** an axis (or the vector, when none is close) at right angles to n, as near `prefer` as it gets @param {number[]} n @param {number[]} [prefer] */
export function perpendicular(n, prefer = [1, 0, 0]) {
  const tries = [prefer, [1, 0, 0], [0, 0, 1], [0, 1, 0]];
  const pick = tries.find((t) => Math.abs(dot(t, n)) < 1e-4);
  if (pick) return [...pick];
  const t = tries.reduce((best, x) => (Math.abs(dot(x, n)) < Math.abs(dot(best, n)) ? x : best));
  const d = dot(t, n);
  const v = t.map((c, k) => c - d * n[k]);
  const l = Math.hypot(...v);
  return round(v.map((c) => c / l));
}

/**
 * snapSocket puts a socket on a face of a parent shape: on the face's centre, or `inset` (0 to 1)
 * of the way in to the shape's centre, facing out of it. Forward is kept when it lies along the
 * face. Returns the new socket.
 * @param {any} socket @param {Face} face @param {number[]} centre the shape's position @param {number} [inset]
 */
export function snapSocket(socket, face, centre, inset = 0) {
  const normal = round(face.normal);
  const forward = socket?.forward && Math.abs(dot(socket.forward, normal)) < 1e-4 ? socket.forward : perpendicular(normal, socket?.forward);
  return { position: round(face.position.map((c, k) => c + (centre[k] - c) * inset)), normal, forward };
}

/** which face (index into a shape's faces) a socket sits on, or -1 @param {any} socket @param {Face[]} faces */
export function socketFace(socket, faces) {
  const p = socket?.position ?? [0, 0, 0];
  const n = socket?.normal ?? [0, 0, 0];
  return faces.findIndex((f) => f.position.every((c, k) => Math.abs(c - p[k]) < 1e-3) && dot(f.normal, n) > 0.999);
}

/** the face most along `dir` @param {Face[]} faces @param {number[]} dir */
export function faceToward(faces, dir) {
  let best = 0;
  faces.forEach((f, k) => dot(f.normal, dir) > dot(faces[best].normal, dir) && (best = k));
  return best;
}

/**
 * newPart makes a part to hang under `parent`. With the parent's first shape and its faces (the
 * engine's "faces" query), it bolts onto that shape's bottom face and is sized from it; else it is
 * a small box.
 * @param {any} m @param {any} [parent] @param {Face[]} [faces]
 */
export function newPart(m, parent, faces) {
  const ps = parent?.shapes?.[0];
  const size = ps?.size ? [Math.max(0.05, ps.size[0] * 0.6), Math.max(0.05, ps.size[1] * 0.8), Math.max(0.05, ps.size[2] * 0.6)].map(r5) : [0.2, 0.3, 0.2];
  const rest = { position: [0, -0.3, 0], normal: [0, -1, 0], forward: [1, 0, 0] };
  return {
    name: uniqueName("part", (n) => partIndex(m, n) >= 0),
    parent: parent?.name,
    socket: ps && faces?.length ? snapSocket(rest, faces[faceToward(faces, [0, -1, 0])], ps.position ?? [0, 0, 0]) : rest,
    mount: { normal: [0, 1, 0], forward: [1, 0, 0] },
    binds: [{}, {}, {}],
    shapes: [{ material: ps?.material ?? m.materials?.[0]?.name, position: [0, r5(-size[1] / 2), 0], size }],
  };
}

/**
 * scalePart scales a part about its own frame: its shapes, its mount and its children's sockets.
 * @param {any} m @param {number} i @param {number} f
 */
export function scalePart(m, i, f) {
  const part = m.parts[i];
  /** @param {number[] | undefined} v */
  const mul = (v) => v && round(v.map((c) => c * f));
  for (const s of part.shapes ?? []) {
    s.position = mul(s.position);
    s.size = mul(s.size);
  }
  if (part.mount?.position) part.mount.position = mul(part.mount.position);
  for (const c of m.parts) if (c.parent === part.name && c.socket?.position) c.socket.position = mul(c.socket.position);
}

// ---- joint presets -------------------------------------------------------------------------------

/** Joint presets, from the mech's joints (assets/characters/mech.json). @type {Record<string, any>} */
export const JOINT_PRESETS = {
  hinge: { kind: "HINGE", jaw: 0.15, lug_t: 0.07, lug_d: 0.3, shank: 0.12, flange_t: 0.16, pin_r: 0.06, clr: 0.03, tang: true, disc_f: true, disc_m: true },
  elbow: { kind: "HINGE_TWIST", jaw: 0.14, lug_t: 0.06, lug_d: 0.24, shank: 0.12, flange_t: 0.16, pin_r: 0.05, clr: 0.008, tang: true, disc_m: true },
  shoulder: { kind: "DISC_HINGE", jaw: 0.1, lug_t: 0.06, lug_d: 0.22, shank: 0.12, flange_t: 0.16, pin_r: 0.05, clr: 0.03 },
  wrist: { kind: "WRIST", jaw: 0.1, lug_t: 0.05, lug_d: 0.2, shank: 0.12, flange_t: 0.16, pin_r: 0.04, clr: 0.008, tang: true },
  knuckle: { kind: "PIN", jaw: 0.06, lug_t: 0.01, shank: 0.12, flange_t: 0.16, pin_r: 0.035, clr: 0.005, pin_out: 0.01 },
  ball: { kind: "BALL", flange_t: 0.06, ball_r: 0.17, socket_t: 0.07, stud_len: 0.05, flange_w: 0.44 },
  spin: { kind: "SPIN" },
};

const JOINT_SIZES = ["jaw", "lug_t", "lug_d", "shank", "flange_t", "pin_r", "clr", "pin_out", "ball_r", "socket_t", "stud_len", "flange_w"];

/** jointSize is the one number a joint's size slider shows: the ball's or lug's diameter, a pin's jaw. 0 for joints without hardware. @param {any} j */
export function jointSize(j) {
  if (j.kind === "BALL") return 2 * (j.ball_r ?? 0);
  if (j.kind === "PIN") return j.jaw ?? 0;
  return j.lug_d ?? 0;
}

/** scaleJoint scales every size of a joint by f. @param {any} j @param {number} f */
export function scaleJoint(j, f) {
  for (const k of JOINT_SIZES) if (typeof j[k] === "number") j[k] = r5(j[k] * f);
}

/** jointPreset is a preset's fields (no name) scaled to `size` (see jointSize), or as is without one. @param {string} preset @param {number} [size] */
export function jointPreset(preset, size) {
  const j = clone(JOINT_PRESETS[preset] ?? JOINT_PRESETS.hinge);
  const at = jointSize(j);
  if (size && at) scaleJoint(j, size / at);
  return j;
}

/** a joint size to suit a part's first shape: about its narrower width @param {any} part */
export function jointSizeFor(part) {
  const s = part?.shapes?.[0]?.size;
  return s ? r5(0.9 * Math.min(s[0], s[2])) : 0;
}

// ---- mirroring ------------------------------------------------------------------------------------

const SIDES = [
  ["l_", "r_"],
  ["L_", "R_"],
  ["left", "right"],
  ["Left", "Right"],
];

/** mirrorName swaps a name's side (l_arm: r_arm, left_eye: right_eye); undefined when it has none. @param {string} name */
export function mirrorName(name) {
  for (const [a, b] of SIDES) {
    if (name.startsWith(a)) return b + name.slice(a.length);
    if (name.startsWith(b)) return a + name.slice(b.length);
  }
  for (const [a, b] of SIDES.slice(2)) {
    if (name.includes(a)) return name.replace(a, b);
    if (name.includes(b)) return name.replace(b, a);
  }
  return undefined;
}

/** mirrorRoot is the topmost part of i's side (l_palm: l_arm): the part a mirror starts from, as its parent is on the centre line. -1 when i has no side. @param {any} m @param {number} i */
export function mirrorRoot(m, i) {
  if (i < 0 || !mirrorName(m.parts[i].name)) return -1;
  for (let p = partIndex(m, m.parts[i].parent); p >= 0 && mirrorName(m.parts[p].name); p = partIndex(m, m.parts[p].parent)) i = p;
  return i;
}

/**
 * mirrorSubtree copies part i (a mirrorRoot) and everything under it to the other side of the body,
 * replacing what is there. The geometry (sockets, mounts, shape places, which binds turn over) is
 * mirror.js's, from `joints`, the engine's answer to {"q": "joints"}. The copy gets the other
 * side's names (l_ to r_), and its binds the other side's channels, made with the same range when
 * missing. Drivers and legs on the copied channels are mirrored too. Returns the copy's index.
 * @param {any} m @param {number} i @param {import("./mirror.js").Joints} joints
 */
export function mirrorSubtree(m, i, joints) {
  const parts = m.parts;
  const end = subtreeEnd(m, i);
  const rest = restRotations(m, joints);
  /** @type {Record<string, any>} */
  const mirror = {};
  for (let k = i; k < end; k++) mirror[parts[k].name] = partMirror(m, k, joints, rest);
  const block = clone(parts.slice(i, end));
  const root = block[0];
  /** @type {Map<string, string>} */
  const names = new Map();
  for (const p of block) names.set(p.name, mirrorName(p.name) ?? `${p.name}_mirror`);

  // the copy replaces the other side
  const existing = partIndex(m, /** @type {string} */ (names.get(root.name)));
  let at = -1;
  if (existing >= 0) {
    parts.splice(existing, subtreeEnd(m, existing) - existing);
    at = existing;
  }
  for (const [from, to] of names) if (partIndex(m, to) >= 0) names.set(from, uniqueName(to, (n) => partIndex(m, n) >= 0));

  /** @type {Map<string, string>} */
  const chans = new Map();
  const channelOf = (/** @type {string} */ c) => {
    const to = mirrorName(c);
    if (!to) return c;
    chans.set(c, to);
    m.channels ??= [];
    if (!m.channels.some((/** @type {any} */ x) => x.name === to)) {
      const src = m.channels.find((/** @type {any} */ x) => x.name === c);
      m.channels.push({ ...(src ? clone(src) : {}), name: to });
    }
    return to;
  };
  for (const p of block) {
    const mir = mirror[p.name];
    p.name = names.get(p.name);
    if (p !== root) p.parent = names.get(p.parent) ?? p.parent;
    if (mir) {
      if (p.parent) p.socket = mir.socket;
      p.mount = mir.mount;
      (p.shapes ?? []).forEach((/** @type {any} */ s, /** @type {number} */ k) => (s.position = mir.shapes[k]));
    }
    (p.binds ?? []).forEach((/** @type {any} */ b, /** @type {number} */ k) => {
      if (!b.channel) return;
      b.channel = channelOf(b.channel);
      if (mir?.flip[k]) b.sign = -(b.sign ?? 1);
    });
  }
  const has = (/** @type {string | undefined} */ c) => !!c && chans.has(c);
  for (const d of [...(m.drivers ?? [])]) {
    if (!has(d.target)) continue;
    const to = chans.get(d.target);
    if (m.drivers.some((/** @type {any} */ x) => x.target === to)) continue;
    m.drivers.push({ ...clone(d), target: to, source: d.source && channelOf(d.source) });
  }
  for (const l of [...(m.legs ?? [])]) {
    if (!has(l.hip) || !has(l.knee) || !has(l.ankle)) continue;
    const mirrored = { hip: chans.get(l.hip), knee: chans.get(l.knee), ankle: chans.get(l.ankle) };
    if (!m.legs.some((/** @type {any} */ x) => x.hip === mirrored.hip)) m.legs.push(mirrored);
  }

  if (at < 0) {
    const p = partIndex(m, root.parent);
    at = p >= 0 ? subtreeEnd(m, p) : parts.length;
  }
  parts.splice(at, 0, ...block);
  return at;
}
