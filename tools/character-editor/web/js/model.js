// @ts-check
// Helpers over model and animation data: the parts library, its slots and the joints they expose,
// the assembly tree (instances matching slots), drivers, names, renames. Data only; anything the game computes, the viewer computes
// (src/viewer/query.odin).

import { apply, euler, eulerFrom, mul, rotation, transpose } from "./math3.js";
import { reflectSlot } from "./mirror.js";

export const PRIMITIVES = ["BOX", "WEDGE", "CYLINDER", "HALF_CYLINDER", "QUARTER_CYLINDER", "CONE", "SPHERE"];
/**
 * The quarter turns each primitive looks the same under, so a shape turned by one can show it as
 * its size instead: "any" (a box, a sphere: any axes swapped or flipped), "y" (a cylinder: any that
 * keep its y on y); the others (a wedge, a cone, half and quarter cylinders) have their own way up.
 * @type {Record<string, "any" | "y">}
 */
const PRIMITIVE_SYMMETRY = { BOX: "any", SPHERE: "any", CYLINDER: "y" };
/** the kinds a joint can be; FIXED is no joint at all: an empty stack bolts the part on rigid */
export const JOINT_KINDS = ["SPIN", "HINGE", "BALL"];
export const EASES = ["SMOOTH", "LINEAR", "IN", "OUT"];

// an unnamed slot on the parent's side: its origin facing -y (mech.SLOT_FACE), where a root hangs
export const SLOT_FACE = { position: [0, 0, 0], normal: [0, -1, 0], forward: [1, 0, 0] };

/** a part of the library, by name @param {any} m @param {string | undefined} name */
export function partIndex(m, name) {
  if (!name) return -1;
  return (m.parts ?? []).findIndex((/** @type {any} */ p) => p.name === name);
}

/** an instance of the assembly, by name @param {any} m @param {string | undefined} name */
export function instanceIndex(m, name) {
  if (!name) return -1;
  return (m.assembly ?? []).findIndex((/** @type {any} */ p) => p.name === name);
}

/** the library part instance i places (undefined for a link) @param {any} m @param {number} i */
export function partOf(m, i) {
  return m.parts?.[partIndex(m, m.assembly?.[i]?.part)];
}

/** the instances placing library part `name` @param {any} m @param {string} name */
export function partUsers(m, name) {
  return (m.assembly ?? []).filter((/** @type {any} */ x) => x.part === name);
}

/** the instances matched on slot `slot` of library part `part`: those hanging from it, and those of the part hanging by it @param {any} m @param {string} part @param {string} slot */
export function slotUsers(m, part, slot) {
  return (m.assembly ?? []).filter((/** @type {any} */ x) => (x.parent_slot === slot && m.assembly[instanceIndex(m, x.parent)]?.part === part) || (x.part === part && x.slot === slot));
}

/** the slot instance i hangs by, on its own part @param {any} m @param {number} i */
export function hangSlot(m, i) {
  const x = m.assembly?.[i];
  return partOf(m, i)?.slots?.find((/** @type {any} */ s) => s.name === x?.slot);
}

/** the joints instance i exposes: those of the slot it hangs by, the part's own for its default slot (the origin) @param {any} m @param {number} i @returns {any[]} */
export function exposedJoints(m, i) {
  return (m.assembly?.[i]?.slot ? hangSlot(m, i) : partOf(m, i))?.joints ?? [];
}

/** the axes a joint turns about @param {any} j @returns {string[]} */
export function jointAxes(j) {
  const kind = j?.kind ?? "FIXED";
  return { FIXED: [], SPIN: ["Y"], HINGE: ["X"], BALL: ["X", "Y", "Z"] }[/** @type {"FIXED"} */ (kind)] ?? [];
}

/**
 * treeOrder lists the instances depth first, each under its parent (siblings in list order), with
 * its depth: the order a tree shows them in. The list itself is only parents first.
 * @param {any} m @returns {{i: number, depth: number}[]}
 */
export function treeOrder(m) {
  const parts = m.assembly ?? [];
  /** @type {number[][]} */
  const children = parts.map(() => []);
  /** @type {number[]} */
  const roots = [];
  parts.forEach((/** @type {any} */ p, /** @type {number} */ i) => {
    const parent = instanceIndex(m, p.parent);
    (parent >= 0 && parent < i ? children[parent] : roots).push(i);
  });
  /** @type {{i: number, depth: number}[]} */
  const out = [];
  /** @param {number} i @param {number} d */
  const walk = (i, d) => {
    out.push({ i, depth: d });
    for (const c of children[i]) walk(c, d + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

/** subtreeEnd is one past the last instance below instance i (listed parents first). @param {any} m @param {number} i */
export function subtreeEnd(m, i) {
  const parts = m.assembly ?? [];
  const inside = new Set([i]);
  let end = i + 1;
  for (let k = i + 1; k < parts.length; k++) {
    const p = instanceIndex(m, parts[k].parent);
    if (p >= 0 && inside.has(p)) {
      inside.add(k);
      end = k + 1;
    }
  }
  return end;
}

/**
 * reparent moves instance i, with everything below it, under instance `parent` (-1 for a root),
 * keeping parents first. Its slot is matched with the slot of the same name on the new parent's
 * part, else its first free slot, else the parent's origin. Returns the instance's new index (i
 * when the move would put it under itself).
 * @param {any} m @param {number} i @param {number} parent
 */
export function reparent(m, i, parent) {
  const parts = m.assembly;
  const end = subtreeEnd(m, i);
  if (parent >= i && parent < end) return i;
  const block = parts.splice(i, end - i);
  const p = parent >= i ? parent - block.length : parent;
  if (p >= 0) {
    block[0].parent = parts[p].name;
    const on = partOf(m, p);
    const slot = on?.slots?.some((/** @type {any} */ x) => x.name === block[0].parent_slot) ? block[0].parent_slot : freeSlot(m, p);
    if (slot) block[0].parent_slot = slot;
    else delete block[0].parent_slot;
  } else {
    delete block[0].parent;
    delete block[0].parent_slot; // a root matches the model origin
  }
  const at = p >= 0 ? subtreeEnd(m, p) : parts.length;
  parts.splice(at, 0, ...block);
  return at;
}

/** @param {string} base @param {(name: string) => boolean} taken */
export function uniqueName(base, taken) {
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base}_${i}`)) return `${base}_${i}`;
}

/** The axes of a joint's frame a drive turns about. */
export const AXES = ["X", "Y", "Z"];

/** The drivers that turn some joint: their values are angles (shown in degrees). @param {any} m @returns {Set<string>} */
export function angularDrivers(m) {
  const out = new Set();
  for (const d of m.drivers ?? []) if ((d.drives ?? []).length) out.add(d.name);
  return out;
}

/** a new driver named from `base`, ranged over `range` (a joint's, jointRange), else a quarter turn each way @param {any} m @param {string} base @param {number[]} [range] */
export function newDriver(m, base, range) {
  m.drivers ??= [];
  const [min, max] = range ?? [-1.5708, 1.5708];
  const d = { name: uniqueName(base, (n) => m.drivers.some((/** @type {any} */ x) => x.name === n)), min, max };
  m.drivers.push(d);
  return d;
}

// ---- IK targets ------------------------------------------------------------------------------------

/** an IK target's drivers, by its name: the target's x, y, z (model units) and the weight */
export const IK_SUFFIXES = ["_x", "_y", "_z", "_weight"];
/** an IK target's pole, when it has one: x, y, z (model units), the point its chain bends toward */
export const POLE_SUFFIXES = ["_pole_x", "_pole_y", "_pole_z"];
const ALL_IK_SUFFIXES = [...IK_SUFFIXES, ...POLE_SUFFIXES];

/** the IK target driver `name` belongs to (its pole's too), or undefined @param {any} m @param {string} name */
export function ikOf(m, name) {
  return (m.iks ?? []).find((/** @type {any} */ ik) => ALL_IK_SUFFIXES.some((x) => ik.name + x === name));
}

/** whether IK target `ik` has a pole (all three of its drivers) @param {any} m @param {any} ik */
export const hasPole = (m, ik) => POLE_SUFFIXES.every((x) => (m.drivers ?? []).some((/** @type {any} */ c) => c.name === ik.name + x));

/**
 * addPole gives IK target `ik` a pole: its three drivers, ranged `reach` either side of `at`. The
 * chain then bends toward it (the knee, the elbow).
 * @param {any} m @param {any} ik @param {number[]} at @param {number} reach
 */
export function addPole(m, ik, at, reach) {
  m.drivers ??= [];
  POLE_SUFFIXES.forEach((x, i) => m.drivers.some((/** @type {any} */ c) => c.name === ik.name + x) || m.drivers.push({ name: ik.name + x, min: r5(at[i] - reach), max: r5(at[i] + reach) }));
}

/** removePole takes IK target `ik`'s pole away: its drivers @param {any} m @param {any} ik */
export function removePole(m, ik) {
  m.drivers = (m.drivers ?? []).filter((/** @type {any} */ c) => !POLE_SUFFIXES.some((x) => c.name === ik.name + x));
}

/**
 * addIk adds an IK target reaching instance `tip`'s frame by turning the chain from `root`, with
 * its four drivers: x, y, z ranged `reach` either side of `at` (where the tip is now), and the
 * weight 0 to 1. Returns its index.
 * @param {any} m @param {string} name @param {string} root @param {string} tip @param {number[]} at @param {number} reach
 */
export function addIk(m, name, root, tip, at, reach) {
  m.iks ??= [];
  m.drivers ??= [];
  name = uniqueName(name, (n) => m.iks.some((/** @type {any} */ x) => x.name === n) || IK_SUFFIXES.some((x) => m.drivers.some((/** @type {any} */ c) => c.name === n + x)));
  m.iks.push({ name, root, tip });
  ["x", "y", "z"].forEach((k, i) => m.drivers.push({ name: `${name}_${k}`, min: r5(at[i] - reach), max: r5(at[i] + reach) }));
  m.drivers.push({ name: `${name}_weight`, max: 1 });
  return m.iks.length - 1;
}

/** renameIk renames an IK target and its drivers (its pole's too), through the open animation too @param {any} m @param {any} a @param {any} ik @param {string} to */
export function renameIk(m, a, ik, to) {
  for (const x of ALL_IK_SUFFIXES) {
    const c = (m.drivers ?? []).find((/** @type {any} */ c) => c.name === ik.name + x);
    if (c) (renameDriver(a, c.name, to + x), (c.name = to + x));
  }
  ik.name = to;
}

/** removeIk deletes an IK target and its drivers (its pole's too) @param {any} m @param {number} i */
export function removeIk(m, i) {
  const ik = m.iks[i];
  m.drivers = (m.drivers ?? []).filter((/** @type {any} */ c) => !ALL_IK_SUFFIXES.some((x) => c.name === ik.name + x));
  m.iks.splice(i, 1);
}

const LIMBS = [
  ["hand", ["curl", "wrist", "finger", "thumb"]],
  ["arm", ["shoulder", "arm", "elbow", "fore"]],
  ["leg", ["hip", "knee", "ankle", "leg", "thigh", "shin", "foot"]],
];

/**
 * groupOf sorts a driver into a group: side and limb from its name (l_elbow: "Left arm"), a
 * numbered chain by its stem (segment_3_yaw: "Segment"), else "Body".
 * @param {string} name
 */
export function groupOf(name) {
  if (name === "root" || name.startsWith("root_")) return "Root";
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
 * @param {any[]} drivers
 * @returns {[string, any[]][]}
 */
export function groupDrivers(drivers) {
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const c of drivers) {
    const g = groupOf(c.name);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)?.push(c);
  }
  return [...groups];
}

/**
 * @typedef {{name: string, names: string[]}} Entry
 * vectors puts channel names into entries: `<stem>_x`, `_y`, `_z` together (an IK target's, the
 * root's), each other name alone, in the order the names come.
 * @param {string[]} names @returns {Entry[]}
 */
export function vectors(names) {
  const has = new Set(names);
  /** @type {Entry[]} */
  const out = [];
  const done = new Set();
  for (const n of names) {
    if (done.has(n)) continue;
    const stem = /^(.*)_[xyz]$/.exec(n)?.[1];
    const three = stem !== undefined ? ["x", "y", "z"].map((a) => `${stem}_${a}`) : [];
    if (three.length && three.every((x) => has.has(x))) {
      three.forEach((x) => done.add(x));
      out.push({ name: /** @type {string} */ (stem), names: three });
    } else out.push({ name: n, names: [n] });
  }
  return out;
}

/**
 * A driver's slider range. Files leave out zero fields, so a missing bound is 0; with no range at
 * all it is a half turn each way.
 * @param {any} c @returns {[number, number]}
 */
export function driverRange(c) {
  const lo = c.min ?? 0;
  const hi = c.max ?? 0;
  if (lo === 0 && hi === 0) return [-Math.PI, Math.PI];
  return lo < hi ? [lo, hi] : [lo, lo + 1];
}

/** a deep copy of plain data @template T @param {T} v @returns {T} */
export const clone = (v) => JSON.parse(JSON.stringify(v));

// ---- renames, carried through everything that names the thing --------------------------------

/** an instance's rename, carried to its children, the drives moving it and the IK targets on it @param {any} m @param {string} from @param {string} to */
export function renameInstance(m, from, to) {
  for (const p of m.assembly ?? []) if (p.parent === from) p.parent = to;
  for (const d of m.drivers ?? []) for (const x of d.drives ?? []) if (x.part === from) x.part = to;
  for (const ik of m.iks ?? []) {
    if (ik.root === from) ik.root = to;
    if (ik.tip === from) ik.tip = to;
  }
}

/** a library part's rename, carried to the instances placing it @param {any} m @param {string} from @param {string} to */
export function renamePart(m, from, to) {
  for (const p of m.assembly ?? []) if (p.part === from) p.part = to;
}

/** slot `from` of library part `part` renamed, carried to the instances matched on it and the part's shapes spanning it @param {any} m @param {string} part @param {string} from @param {string} to */
export function renameSlot(m, part, from, to) {
  for (const s of m.parts?.[partIndex(m, part)]?.shapes ?? []) if (s.span) s.span = s.span.map((/** @type {string} */ x) => (x === from ? to : x));
  for (const x of slotUsers(m, part, from)) {
    if (x.part === part && x.slot === from) x.slot = to;
    if (x.parent_slot === from && m.assembly[instanceIndex(m, x.parent)]?.part === part) x.parent_slot = to;
  }
}

/** joint `from` of library part `part` (on any of its slots) renamed, carried to the drives moving it @param {any} m @param {string} part @param {string} from @param {string} to */
export function renamePartJoint(m, part, from, to) {
  for (const d of m.drivers ?? []) for (const x of d.drives ?? []) if (x.joint === from && m.assembly?.[instanceIndex(m, x.part)]?.part === part) x.joint = to;
}

/** @param {any} m @param {string} from @param {string} to */
export function renameMaterial(m, from, to) {
  for (const p of m.parts ?? []) for (const s of p.shapes ?? []) if (s.material === from) s.material = to;
  for (const k of ["female", "male", "metal"]) if (m.hardware?.[k] === from) m.hardware[k] = to;
}

/** A driver rename moves the open animation's values (the driver itself is renamed by the caller). @param {any} a @param {string} from @param {string} to */
export function renameDriver(a, from, to) {
  /** @param {Record<string, number> | undefined} values */
  const move = (values) => {
    if (values && from in values) {
      values[to] = values[from];
      delete values[from];
    }
  };
  for (const c of a.clips ?? []) for (const k of c.keys ?? []) move(k.values);
}

/**
 * upgradeAnim brings an animation saved before clips were plain key lists up to date: each key's
 * pose is copied into its values, and keys are put in time order (within a time, in the order
 * their priorities applied them), which samples the same. Poses, priorities and blends go.
 * @param {any} a
 */
export function upgradeAnim(a) {
  const poses = Object.fromEntries((a.poses ?? []).map((/** @type {any} */ p) => [p.name, p.values ?? {}]));
  for (const c of a.clips ?? []) {
    const keys = (c.keys ?? []).map((/** @type {any} */ k, /** @type {number} */ i) => ({ k, i }));
    keys.sort((/** @type {any} */ x, /** @type {any} */ y) => (x.k.priority ?? 0) - (y.k.priority ?? 0) || x.i - y.i);
    c.keys = keys.map((/** @type {any} */ { k }) => {
      const { pose, priority, blend, ...rest } = k;
      return { ...rest, values: { ...(poses[pose] ?? {}), ...(k.values ?? {}) } };
    });
    c.keys.sort((/** @type {any} */ x, /** @type {any} */ y) => (x.at ?? 0) - (y.at ?? 0));
    mergeKeys(c);
  }
  delete a.poses;
  return a;
}

/**
 * mergeKeys folds a clip's keys that land together (same at, duration and ease) into the first
 * of them, wherever the clip samples the same after: so one key holds what a moment sets, and
 * editing it is not hidden by another key setting the same driver at that moment. A key moves into
 * an earlier one when no key between them sets its drivers, and either they snap (no duration) or
 * they set different drivers. Keys must be in time order. @param {any} c
 */
export function mergeKeys(c) {
  /** @type {any[]} */
  const out = [];
  for (const k of c.keys ?? []) {
    const names = Object.keys(k.values ?? {});
    let into = null;
    for (let i = out.length - 1; i >= 0; i--) {
      const o = out[i];
      if ((o.at ?? 0) !== (k.at ?? 0)) break;
      const shares = names.some((n) => n in (o.values ?? {}));
      if ((o.duration ?? 0) === (k.duration ?? 0) && (o.ease ?? "") === (k.ease ?? "") && (!(k.duration > 0) || !shares)) {
        into = o;
        break;
      }
      // a key between them setting these drivers: moving k before it would change the clip
      if (shares) break;
    }
    if (into) into.values = { ...(into.values ?? {}), ...(k.values ?? {}) };
    else out.push(k);
  }
  c.keys = out;
}

// ---- authoring helpers ---------------------------------------------------------------------------

/** @typedef {{position: number[], normal: number[], extent?: number[]}} Face */
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

/** a shape's centre, from its faces (the "faces" query, spans resolved): between its +x and -x faces @param {Face[]} faces */
export const faceCentre = (faces) => faces[0].position.map((c, k) => (c + faces[1].position[k]) / 2);

/** the shapes of a part spanning slot `slot` @param {any} part @param {string} slot */
export const slotSpanners = (part, slot) => (part?.shapes ?? []).filter((/** @type {any} */ s) => s.span?.includes(slot));

/**
 * @typedef {{position: number[], rotation: number[], length: number}} SpanFrame
 * the frame a shape spanning two slots sits in, in its part's frame (mech.span_frame, the "span"
 * query): its rotation a matrix, and the length the span adds to the shape's size.y
 */

/**
 * respan makes shape `s`, now placed in span frame `from`, span the slots `span` (frame `to`)
 * without moving: its position, rotation and size.y are given again in the new frame. A span of
 * the origin to the origin is none.
 * @param {any} s @param {string[]} span @param {SpanFrame} from @param {SpanFrame} to
 */
export function respan(s, span, from, to) {
  const at = from.position.map((c, k) => c + apply(from.rotation, s.position ?? [0, 0, 0])[k]);
  const back = transpose(to.rotation);
  s.position = round(apply(back, at.map((c, k) => c - to.position[k])));
  s.rotation = eulerFrom(mul(back, mul(from.rotation, euler(s.rotation)))).map(r5);
  s.size = [...(s.size ?? [0, 0, 0])];
  s.size[1] = r5(s.size[1] + from.length - to.length);
  if (span[0] || span[1]) s.span = [...span];
  else delete s.span;
  if (s.position.every((/** @type {number} */ c) => c === 0)) delete s.position;
  if (s.rotation.every((/** @type {number} */ c) => c === 0)) delete s.rotation;
}

/**
 * stackOn moves shape `s` (in span frame `span`) so it sits on face `target` of another shape:
 * its own face most opposite it (`own`: its faces, the "faces" query) centred on it, touching.
 * `alongOnly` moves it only along the target's normal, keeping it where it is across the face.
 * @param {any} s @param {Face[]} own @param {Face} target @param {SpanFrame} span @param {boolean} [alongOnly]
 */
export function stackOn(s, own, target, span, alongOnly = false) {
  const mine = own[faceToward(own, target.normal.map((c) => -c))];
  let d = target.position.map((c, k) => c - mine.position[k]);
  if (alongOnly) {
    const t = dot(d, target.normal);
    d = target.normal.map((c) => c * t);
  }
  const by = apply(transpose(span.rotation), d);
  s.position = round((s.position ?? [0, 0, 0]).map((/** @type {number} */ c, /** @type {number} */ k) => c + by[k]));
}

/**
 * shapeOnFace is a new box on face `n` (its index, FACE_NAMES) of shape `on` (in span frame
 * `span`; `face` the face itself), as wide as the face and `thick` deep: turned and spanned as
 * `on` is, so it lines up with it.
 * @param {any} on @param {number} n @param {Face} face @param {SpanFrame} span @param {number} [thick]
 */
export function shapeOnFace(on, n, face, span, thick = 0.1) {
  const a = n >> 1;
  const size = [...(on.size ?? [0.2, 0.2, 0.2])];
  // along y a span's length adds to the size
  size[a] = r5(thick - (a === 1 ? span.length : 0));
  const centre = face.position.map((c, k) => c + face.normal[k] * (thick / 2));
  return {
    material: on.material,
    ...(on.span ? { span: [...on.span] } : {}),
    position: round(apply(transpose(span.rotation), centre.map((c, k) => c - span.position[k]))),
    ...(on.rotation ? { rotation: [...on.rotation] } : {}),
    size,
  };
}

/**
 * tidyShape: a shape turned by quarter turns (its rotation a signed permutation of the axes) shows
 * the turn as its size instead, its rotation cleared, where its primitive looks the same
 * (PRIMITIVE_SYMMETRY). A spanned shape keeps its y on y (the span's length adds there). Other
 * quarter turns snap to exact ones; any other rotation stays.
 * @param {any} s
 */
export function tidyShape(s) {
  if (!s.rotation) return;
  const m = euler(s.rotation);
  // the column of each row's ±1, when every row has one
  const from = [0, 1, 2].map((r) => [0, 1, 2].find((c) => Math.abs(Math.abs(m[r * 3 + c]) - 1) < 1e-4));
  if (from.some((c) => c === undefined) || new Set(from).size < 3) return;
  const sym = PRIMITIVE_SYMMETRY[s.primitive ?? "BOX"];
  const keepsY = from[1] === 1;
  if (sym === "any" && (keepsY || !s.span?.some(Boolean)) || (sym === "y" && keepsY)) {
    const size = s.size ?? [0, 0, 0];
    s.size = from.map((c) => size[/** @type {number} */ (c)]);
    delete s.rotation;
    return;
  }
  const exact = m.map((x) => Math.round(x));
  s.rotation = eulerFrom(exact).map(r5);
  if (s.rotation.every((/** @type {number} */ x) => x === 0)) delete s.rotation;
}

/**
 * turn90 turns shape `s` (in span frame `span`) a quarter turn about the part's axis `axis` (0, 1,
 * 2), about its centre, then tidies it (tidyShape).
 * @param {any} s @param {number} axis @param {SpanFrame} span
 */
export function turn90(s, axis, span) {
  const q = mul(transpose(span.rotation), mul(rotation(axis, Math.PI / 2), mul(span.rotation, euler(s.rotation))));
  s.rotation = eulerFrom(q).map(r5);
  tidyShape(s);
}

/** tidyPart tidies every shape of a part (tidyShape) and rounds its shapes' and slots' numbers to 0.001 @param {any} part */
export function tidyPart(part) {
  /** @param {number[] | undefined} v */
  const milli = (v) => v && v.map((c) => Math.round(c * 1000) / 1000 || 0);
  for (const s of part.shapes ?? []) {
    tidyShape(s);
    s.position = milli(s.position);
    s.size = milli(s.size);
    if (s.position?.every((/** @type {number} */ c) => c === 0)) delete s.position;
  }
  for (const s of part.slots ?? []) s.position = milli(s.position);
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

/** a new library part: a small box under its origin, its default slot @param {any} m @param {string} [base] */
export function newPart(m, base = "part") {
  return { name: uniqueName(base, (n) => partIndex(m, n) >= 0), shapes: [{ material: m.materials?.[0]?.name, position: [0, -0.15, 0], size: [0.2, 0.3, 0.2] }] };
}

/** the first slot of instance i's part nothing is matched on (neither a child nor i itself), or "" @param {any} m @param {number} i */
export function freeSlot(m, i) {
  const part = partOf(m, i);
  const kids = (m.assembly ?? []).filter((/** @type {any} */ x) => x.parent === m.assembly[i].name);
  return part?.slots?.find((/** @type {any} */ s) => s.name !== m.assembly[i].slot && !kids.some((/** @type {any} */ x) => x.parent_slot === s.name))?.name ?? "";
}

/**
 * addSlot gives library part `part` a slot named from `base` at face `at` (its origin facing -y
 * when undefined). Returns the slot's name.
 * @param {any} part @param {string} base @param {any} [at]
 */
export function addSlot(part, base, at) {
  const name = uniqueName(base, (n) => (part.slots ?? []).some((/** @type {any} */ x) => x.name === n));
  (part.slots ??= []).push({ name, ...clone(at ?? SLOT_FACE) });
  return name;
}

/** the face in the middle of a part's first shape's bottom (`faces`: the "faces" query of that shape) @param {any} part @param {Face[] | undefined} faces */
export function bottomFace(part, faces) {
  const s = part?.shapes?.[0];
  return s && faces?.length ? snapSocket(undefined, faces[faceToward(faces, [0, -1, 0])], faceCentre(faces)) : undefined;
}

/**
 * newInstance hangs a new part, in a new instance, from instance `parent` (-1: a root): its
 * default slot (its origin) matched with the parent part's first free slot, else with a new slot on its first shape's
 * bottom face (`faces`, the engine's "faces" query of that shape). Returns the instance's index.
 * @param {any} m @param {number} parent @param {Face[]} [faces]
 */
export function newInstance(m, parent, faces) {
  m.parts ??= [];
  m.assembly ??= [];
  const part = newPart(m);
  m.parts.push(part);
  const name = uniqueName(part.name, (n) => instanceIndex(m, n) >= 0);
  const inst = { name, part: part.name };
  if (parent >= 0) {
    const on = partOf(m, parent);
    const slot = freeSlot(m, parent) || (on ? addSlot(on, name, bottomFace(on, faces)) : "");
    Object.assign(inst, { parent: m.assembly[parent].name, ...(slot ? { parent_slot: slot } : {}) });
  }
  const at = parent >= 0 ? subtreeEnd(m, parent) : m.assembly.length;
  m.assembly.splice(at, 0, inst);
  return at;
}

/**
 * scalePart scales a library part about its own frame: its shapes and its slots, and with
 * `joints` the hardware of the joints it hangs by (its own and its slots').
 * @param {any} part @param {number} f @param {boolean} [joints]
 */
export function scalePart(part, f, joints = false) {
  if (joints) for (const s of [part, ...(part.slots ?? [])]) for (const j of s.joints ?? []) scaleJoint(j, f);
  /** @param {number[] | undefined} v */
  const mul = (v) => v && round(v.map((c) => c * f));
  for (const s of part.shapes ?? []) {
    s.position = mul(s.position);
    s.size = mul(s.size);
  }
  for (const s of part.slots ?? []) s.position = mul(s.position);
}

// ---- joint defaults ------------------------------------------------------------------------------

/**
 * Default proportions per joint kind, at size 1 (the engine scales them by the joint's `size`,
 * mech.joint_scaled): after the mech's knee and waist (assets/characters/mech.json).
 * @type {Record<string, any>}
 */
const JOINT_DEFAULTS = {
  HINGE: { jaw: 0.5, lug_t: 0.25, lug_d: 1, shank: 0.4, flange_t: 0.55, pin_r: 0.2, clr: 0.1, tang: true, disc_f: true, disc_m: true },
  BALL: { flange_t: 0.18, ball_r: 0.5, socket_t: 0.2, stud_len: 0.15, flange_w: 1.3 },
  SPIN: { flange_w: 1, flange_t: 0.25 },
};

/** The parameters each kind uses; a joint keeps only its kind's (and name, size, twist, bend). @type {Record<string, string[]>} */
const JOINT_PARAMS = {
  HINGE: ["jaw", "lug_t", "lug_d", "shank", "flange_t", "pin_r", "clr", "pin_out", "tang", "disc_f", "disc_m"],
  BALL: ["ball_r", "socket_t", "stud_len", "flange_w", "flange_t"],
  SPIN: ["flange_w", "flange_t"],
};

/** the parameters `size` scales (mech.joint_scaled) */
const JOINT_LENGTHS = ["jaw", "lug_t", "lug_d", "shank", "flange_t", "pin_r", "clr", "pin_out", "ball_r", "socket_t", "stud_len", "flange_w"];

/** jointSize is a joint's size: what its hardware is scaled by (a hinge's width across its lugs, a ball's diameter, at the defaults). 0: no hardware. @param {any} j */
export const jointSize = (j) => j.size ?? 0;

/** scaleJoint scales a joint's hardware by f. @param {any} j @param {number} f */
export function scaleJoint(j, f) {
  if (j.size) j.size = r5(j.size * f);
}

/** the driver the model tab tries joint `joint`'s axis with (editor.tries) @param {string} joint @param {string} axis */
export const tryDriver = (joint, axis) => `try:${joint}:${axis}`;

/** joint j's range on axis "X", "Y" or "Z" (its stops, radians), undefined when free @param {any} j @param {string} axis */
export function jointRange(j, axis) {
  const k = "XYZ".indexOf(axis);
  const lo = j.min?.[k] ?? 0;
  const hi = j.max?.[k] ?? 0;
  return lo === hi ? undefined : [lo, hi];
}

/** sets one end (0: min, 1: max) of joint j's range on axis k; a range left all zero goes @param {any} j @param {number} k @param {number} end @param {number} v */
export function setJointRange(j, k, end, v) {
  const key = end ? "max" : "min";
  j[key] = [...(j[key] ?? [0, 0, 0])];
  j[key][k] = r5(v);
  for (const x of ["min", "max"]) if (j[x]?.every((/** @type {number} */ c) => c === 0)) delete j[x];
}

/** whether a kind builds hardware, so has a size @param {string | undefined} kind */
export const jointHasHardware = (kind) => !!JOINT_DEFAULTS[kind ?? ""];

/**
 * setJointKind makes `j` a `kind` joint: it drops the parameters `kind` does not use, and gives
 * it that kind's default proportions where it has none, and `size` when it has hardware and no
 * size yet. Parameters it already has are kept.
 * @param {any} j @param {string} kind @param {number} [size]
 */
export function setJointKind(j, kind, size) {
  if (kind === "FIXED") delete j.kind;
  else j.kind = kind;
  const own = JOINT_PARAMS[kind] ?? [];
  for (const k of Object.values(JOINT_PARAMS).flat()) if (!own.includes(k)) delete j[k];
  for (const [k, v] of Object.entries(JOINT_DEFAULTS[kind] ?? {})) j[k] ??= v;
  if (!jointHasHardware(kind)) delete j.size;
  else if (!j.size && size) j.size = size;
  return j;
}

/** a joint size to suit a part's first shape: about its narrower width @param {any} part */
export function jointSizeFor(part) {
  const s = part?.shapes?.[0]?.size;
  return s ? r5(0.9 * Math.min(s[0], s[2])) : 0;
}

/** how much of the face it sits on a joint's size fills, per kind: a hinge's lugs nearly its width, a ball's flange (1.3 × its size) a little less */
const JOINT_FILL = { HINGE: 0.9, BALL: 0.65, SPIN: 0.9 };

/**
 * fitJoint is a size for a `kind` joint that suits the face of the part's shapes where slot
 * `slot` sits (the part itself: its origin, facing +y toward its joints): the face nearest it
 * that faces the same way, its narrower width times the kind's fill. Joints are sized by the
 * members they join, as a clevis is by its link. 0 when no face faces that way.
 * @param {any} part @param {any} slot @param {string} kind @param {Face[][]} faces the part's ("faces" query)
 */
export function fitJoint(part, slot, kind, faces) {
  const at = slot === part ? [0, 0, 0] : (slot.position ?? [0, 0, 0]);
  const normal = slot === part ? [0, 1, 0] : (slot.normal ?? [0, -1, 0]);
  let best = null;
  let near = Infinity;
  for (const f of faces.flat()) {
    if (dot(f.normal, normal) < 0.9 || !f.extent) continue;
    const d = Math.hypot(...f.position.map((c, k) => c - at[k]));
    if (d < near) (near = d), (best = f);
  }
  return best ? r5((JOINT_FILL[/** @type {keyof typeof JOINT_FILL} */ (kind)] ?? 0.9) * Math.min(...best.extent)) : 0;
}

/**
 * sizeJoints upgrades a model written before joints had a size: each joint with hardware
 * parameters and no `size` gets one (a hinge's width across its lugs, a ball's diameter), and its
 * parameters become proportions of it, so it builds the same. Returns the model.
 * @param {any} m
 */
export function sizeJoints(m) {
  for (const p of m?.parts ?? [])
    for (const s of [p, ...(p.slots ?? [])])
      for (const j of s.joints ?? []) {
        if (j.size || !JOINT_LENGTHS.some((k) => j[k])) continue;
        const width = j.kind === "BALL" ? 2 * (j.ball_r ?? 0) : (j.jaw ?? 0) + 2 * (j.lug_t ?? 0);
        const size = r5(width || Math.max(...JOINT_LENGTHS.map((k) => j[k] ?? 0)));
        j.size = size;
        for (const k of JOINT_LENGTHS) if (j[k]) j[k] = r5(j[k] / size);
      }
  return m;
}

/**
 * inlineJoints upgrades a model written before joints lived on their parts: each joint naming a
 * spec of the model's `joints` library (`{name, joint, twist}`) gets that spec's kind and
 * parameters inline, and the library goes. A `bare` hinge (the pin alone, on the socket) becomes
 * a hinge without lugs, shank or base plate, its jaw widened so the pin keeps its length. An
 * unnamed instance is named after its part, and joints written without a size get one
 * (sizeJoints). Returns the model.
 * @param {any} m
 */
export function inlineJoints(m) {
  const specs = new Map((Array.isArray(m?.joints) ? m.joints : []).map((/** @type {any} */ j) => [j.name, j]));
  for (const p of m?.parts ?? [])
    for (const s of [p, ...(p.slots ?? [])])
      for (const [k, j] of (s.joints ?? []).entries()) {
        const { name: _, ...spec } = clone(specs.get(j.joint) ?? {});
        const { joint: __, ...own } = j;
        const x = (s.joints[k] = "joint" in j ? { ...spec, ...own } : j);
        if (!x.bare) continue;
        x.jaw = r5((x.jaw ?? 0) + 4 * (x.lug_t ?? 0));
        for (const f of ["bare", "lug_t", "lug_d", "shank", "flange_t"]) delete x[f];
      }
  if (m) delete m.joints;
  // an instance left unnamed goes by its part's name, as the engine reads it
  for (const p of m?.assembly ?? []) if (!p.name) p.name = p.part;
  return sizeJoints(m);
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

/** mirrorRoot is the topmost instance of i's side (l_palm: l_arm): the one a mirror starts from, as its parent is on the centre line. -1 when i has no side. @param {any} m @param {number} i */
export function mirrorRoot(m, i) {
  const parts = m.assembly ?? [];
  if (i < 0 || !mirrorName(parts[i].name)) return -1;
  for (let p = instanceIndex(m, parts[i].parent); p >= 0 && mirrorName(parts[p].name); p = instanceIndex(m, parts[p].parent)) i = p;
  return i;
}

/**
 * mirrorSubtree copies instance i (a mirrorRoot) and everything under it to the other side of
 * the body, replacing what is there. The copies place the same parts with `mirror` turned over,
 * so the engine reflects them and the way drivers move them (docs/modeling.md). The copy is
 * matched with the other side's slot of the parent's part (l_ to r_), made by reflecting this
 * one's across the parent when the part has none. `lateral` is the model's x in the parent's frame
 * at rest. The copies get the other side's names; drives on the copied instances are copied to
 * the other side's drivers (made with the same range when missing; a driver with no side moves
 * both), and IK targets on the copied instances too (their targets' x ranges reflected). Returns
 * the copy's index.
 * @param {any} m @param {number} i @param {number[]} lateral
 */
export function mirrorSubtree(m, i, lateral) {
  const parts = m.assembly;
  const end = subtreeEnd(m, i);
  const block = clone(parts.slice(i, end));
  const root = block[0];
  /** @type {Map<string, string>} */
  const names = new Map();
  for (const p of block) names.set(p.name, mirrorName(p.name) ?? `${p.name}_mirror`);

  // the copy replaces the other side
  const existing = instanceIndex(m, /** @type {string} */ (names.get(root.name)));
  let at = -1;
  if (existing >= 0) {
    parts.splice(existing, subtreeEnd(m, existing) - existing);
    at = existing;
  }
  for (const [from, to] of names) if (instanceIndex(m, to) >= 0) names.set(from, uniqueName(to, (n) => instanceIndex(m, n) >= 0));

  // the drives on what was replaced go with it
  for (const d of m.drivers ?? []) if (d.drives) d.drives = d.drives.filter((/** @type {any} */ x) => instanceIndex(m, x.part) >= 0);

  // the root's slot on the parent's part: the other side's, reflected from this one's when missing
  const on = partOf(m, instanceIndex(m, root.parent));
  if (on) {
    const from = on.slots?.find((/** @type {any} */ x) => x.name === root.parent_slot) ?? { ...SLOT_FACE, name: "" };
    const face = reflectSlot(from, lateral);
    const name = (from.name && mirrorName(from.name)) || (from.name ? `${from.name}_mirror` : /** @type {string} */ (names.get(root.name)));
    const unturned = ["position", "normal", "forward"].every((k) => face[k].every((/** @type {number} */ c, /** @type {number} */ n) => Math.abs(c - SLOT_FACE[k][n]) < 1e-5));
    if (on.slots?.some((/** @type {any} */ x) => x.name === name)) root.parent_slot = name;
    else if (unturned) delete root.parent_slot;
    else {
      (on.slots ??= []).push({ name, ...face });
      root.parent_slot = name;
    }
  }

  /** the other side's driver of `d`, made with d's range when missing; d itself when it has no side @param {any} d */
  const driverOf = (d) => {
    const to = mirrorName(d.name);
    if (!to) return d;
    let x = m.drivers.find((/** @type {any} */ y) => y.name === to);
    if (!x) m.drivers.push((x = { ...clone(d), name: to, drives: [] }));
    return x;
  };
  for (const p of block) {
    p.name = names.get(p.name);
    if (p !== root) p.parent = names.get(p.parent) ?? p.parent;
    if (p.mirror) delete p.mirror;
    else p.mirror = true;
  }
  for (const d of [...(m.drivers ?? [])]) {
    const copies = (d.drives ?? []).filter((/** @type {any} */ x) => names.has(x.part)).map((/** @type {any} */ x) => ({ ...clone(x), part: names.get(x.part) }));
    if (!copies.length) continue;
    const to = driverOf(d);
    (to.drives ??= []).push(...copies);
  }
  for (const ik of [...(m.iks ?? [])]) {
    if (!names.has(ik.root) || !names.has(ik.tip)) continue;
    const name = mirrorName(ik.name) ?? `${ik.name}_mirror`;
    const at = m.iks.findIndex((/** @type {any} */ x) => x.name === name);
    if (at >= 0) removeIk(m, at);
    const range = (/** @type {string} */ x) => m.drivers.find((/** @type {any} */ c) => c.name === ik.name + x) ?? {};
    const x = range("_x");
    const reach = ((x.max ?? 0) - (x.min ?? 0)) / 2;
    const mid = ["_x", "_y", "_z"].map((k) => ((range(k).max ?? 0) + (range(k).min ?? 0)) / 2);
    addIk(m, name, /** @type {string} */ (names.get(ik.root)), /** @type {string} */ (names.get(ik.tip)), [-mid[0], mid[1], mid[2]], reach);
  }

  if (at < 0) {
    const p = instanceIndex(m, root.parent);
    at = p >= 0 ? subtreeEnd(m, p) : parts.length;
  }
  parts.splice(at, 0, ...block);
  return at;
}
