// @ts-check
// Helpers over model and animation data: the parts library, its slots and the joints they expose,
// the assembly tree (instances matching slots), channel values, arcs, names, renames. Data only; anything the game computes, the viewer computes
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
/** the kinds a joint can be (mech.JointKind): a hinge (one turn: a pin about x, a turntable about y), a linear actuator (one slide), a ball (three turns). HINGE, the default, is left out of files; a part with no joints is bolted on rigid */
export const JOINT_KINDS = ["HINGE", "LINEAR", "BALL"];

/** the axes a hinge can turn about (Joint.axis): X a pin, Y a turntable. X, the default, is left out of files */
export const HINGE_AXES = ["X", "Y"];

/** a joint's kind, HINGE when it says none (as the engine reads it) @param {any} j @returns {string} */
export const jointKind = (j) => j?.kind ?? "HINGE";

/** whether a joint is a turntable: a hinge about y, built as two discs @param {any} j */
export const isTurntable = (j) => jointKind(j) === "HINGE" && j.axis === "Y";
/** the eases a shape point is reached by (mech.Ease): mechanical; LINEAR, the default, is left out of files */
export const EASES = ["LINEAR", "IN", "OUT", "SETTLE", "STEP"];

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

/** the instances hanging from slot `slot` of library part `part` @param {any} m @param {string} part @param {string} slot */
export function slotUsers(m, part, slot) {
  return (m.assembly ?? []).filter((/** @type {any} */ x) => x.parent_slot === slot && m.assembly[instanceIndex(m, x.parent)]?.part === part);
}

/** the joints instance i moves by: its part's @param {any} m @param {number} i @returns {any[]} */
export function instanceJoints(m, i) {
  return partOf(m, i)?.joints ?? [];
}

/** @type {(j: any) => any} the engine's "dofs" query, set by the editor once its viewer runs */
let engineDofs = () => null;

/** setDofsSource makes jointAxes ask the engine (the "dofs" query) @param {(j: any) => any} ask */
export const setDofsSource = (ask) => (engineDofs = ask);

/**
 * the axes of its frame a joint moves about (along, for a LINEAR), as the engine has them
 * (mech.joint_axes; the "dofs" query): its stops are min/max on them. Before the engine runs, by kind.
 * @param {any} j @returns {string[]}
 */
export function jointAxes(j) {
  if (!j) return [];
  const kind = jointKind(j);
  return engineDofs(j)?.axes ?? (kind === "BALL" ? ["X", "Y", "Z"] : kind === "HINGE" && j.axis !== "Y" ? ["X"] : ["Y"]);
}

/** a joint's channel: one per joint, `<instance>.<joint>` (a number, or [x, y, z] for a ball) @param {string} inst @param {any} j */
export const jointChannel = (inst, j) => `${inst}.${j.name}`;

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

// ---- IK targets ------------------------------------------------------------------------------------

/** addIk adds an IK target reaching instance `tip`'s frame (the engine finds its chain, mech.ik_root, and its pole). Returns its index. @param {any} m @param {string} name @param {string} tip */
export function addIk(m, name, tip) {
  m.iks ??= [];
  name = uniqueName(name, (n) => m.iks.some((/** @type {any} */ x) => x.name === n));
  m.iks.push({ name, tip });
  return m.iks.length - 1;
}

/** renameIk renames an IK target, and its channels (`<ik>`, `<ik>.swivel`, `<ik>.weight`) through the rest pose and the open animation @param {any} m @param {any} a @param {any} ik @param {string} to */
export function renameIk(m, a, ik, to) {
  const from = ik.name;
  renameChannels(m, a, (n) => (n === from ? to : n.startsWith(`${from}.`) ? to + n.slice(from.length) : undefined));
  ik.name = to;
}

// ---- channel values: a number, or [x, y, z] (mech.ChannelKind's size); a move's `by` also names
// arcs, a string under a position --------------------------------------------------------------

/** @typedef {number | number[]} Value a channel's value(s) */

/** a + b, value by value @param {Value | undefined} a @param {Value} b @returns {Value} */
export const addValue = (a, b) => (Array.isArray(b) ? b.map((x, k) => (/** @type {any} */ (a)?.[k] ?? 0) + x) : /** @type {number} */ (a ?? 0) + b);

/** f of each of a value's values (and of b's, alike) @param {Value} a @param {Value | undefined} b @param {(x: number, y: number) => number} f @returns {Value} */
export const zipValue = (a, b, f) => (Array.isArray(a) ? a.map((x, k) => f(x, /** @type {any} */ (b)?.[k] ?? 0)) : f(a, /** @type {number} */ (b ?? 0)));

/** a channel's value at rest: 0, or [0, 0, 0] @param {any} c a channel (the "channels" query) @returns {Value} */
export const zeroValue = (c) => (c?.size === 3 ? [0, 0, 0] : 0);

/** the amounts among a move's values (not its arcs) @param {Record<string, any> | undefined} by @returns {Record<string, Value>} */
export const amountsOf = (by) => Object.fromEntries(Object.entries(by ?? {}).filter(([, v]) => typeof v !== "string"));

/** the arcs a move's values name, by the position they move @param {Record<string, any> | undefined} by @returns {Record<string, string>} */
export const arcsOf = (by) => Object.fromEntries(Object.entries(by ?? {}).filter(([, v]) => typeof v === "string"));

/**
 * A channel's slider range per value (the "channels" query's min and max). Equal ends (a free
 * joint) give a half turn each way. @param {any} c @param {number} k @returns {[number, number]}
 */
export function channelRange(c, k = 0) {
  const lo = c.min?.[k] ?? 0;
  const hi = c.max?.[k] ?? 0;
  if (lo === hi) return [-Math.PI, Math.PI];
  return lo < hi ? [lo, hi] : [lo, lo + 1];
}

// ---- twins: the other side of the body (mech.channel_twin, the "twins" query) --------------------

/** @typedef {Record<string, {twin: string, flip: Value}>} Twins each channel's twin and what its values are times there */

/**
 * moveValues is a move's amounts as the engine moves them, by channel: with a twin (`twin`: WITH
 * or OPPOSITE), its channels' twins' too, by the same amounts (x mirrored for an IK target). For
 * a pose, which runs at once. @param {any} mv @param {Twins} twins @returns {Record<string, Value>}
 */
export function moveValues(mv, twins) {
  const own = amountsOf(mv?.by);
  if (!mv?.twin || mv.twin === "NONE") return own;
  const out = { ...own };
  for (const [n, v] of Object.entries(own)) {
    const t = twins[n];
    if (t) out[t.twin] = addValue(out[t.twin], zipValue(v, t.flip, (x, f) => x * f));
  }
  return out;
}

/**
 * foldTwins writes values (by channel) as a move: when every channel with a twin has its twin at
 * the same value (x mirrored), one side of each pair and `twin: "WITH"` (the left side kept, l_
 * before r_); else every value, with no twin. @param {Record<string, Value>} values @param {Twins} twins @returns {{twin?: string, by: any}}
 */
export function foldTwins(values, twins) {
  const near = (/** @type {Value} */ a, /** @type {Value} */ b) => [a].flat().every((x, k) => Math.abs(x - ([b].flat()[k] ?? 0)) < 1e-6);
  const pairs = Object.entries(values).filter(([n]) => twins[n]);
  const all = pairs.every(([n, v]) => near(values[twins[n].twin] ?? zipValue(v, v, () => 0), zipValue(v, twins[n].flip, (x, f) => x * f)));
  if (!pairs.length || !all) return { by: { ...values } };
  /** @type {Record<string, Value>} */
  const kept = {};
  for (const [n, v] of Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1))) if (!(twins[n] && twins[n].twin in kept)) kept[n] = v;
  return { twin: "WITH", by: kept };
}

/** a deep copy of plain data @template T @param {T} v @returns {T} */
export const clone = (v) => JSON.parse(JSON.stringify(v));

// ---- renames, carried through everything that names the thing --------------------------------

/** an instance's rename, carried to its children, the IK targets on it, and its joints' channels (in the rest pose and the open animation `a`) @param {any} m @param {any} a @param {string} from @param {string} to */
export function renameInstance(m, a, from, to) {
  renameChannels(m, a, (n) => (n.startsWith(`${from}.`) ? to + n.slice(from.length) : undefined));
  for (const p of m.assembly ?? []) {
    if (p.parent === from) p.parent = to;
    if (p.mirror === from) p.mirror = to;
  }
  for (const ik of m.iks ?? []) if (ik.tip === from) ik.tip = to;
}

/** a library part's rename, carried to the instances placing it @param {any} m @param {string} from @param {string} to */
export function renamePart(m, from, to) {
  for (const p of m.assembly ?? []) if (p.part === from) p.part = to;
}

/** slot `from` of library part `part` renamed, carried to the instances matched on it and the part's shapes spanning it @param {any} m @param {string} part @param {string} from @param {string} to */
export function renameSlot(m, part, from, to) {
  for (const s of m.parts?.[partIndex(m, part)]?.shapes ?? []) if (s.span) s.span = s.span.map((/** @type {string} */ x) => (x === from ? to : x));
  for (const x of slotUsers(m, part, from)) x.parent_slot = to;
}

/** joint `from` of library part `part` renamed, carried to its channels (in the rest pose and the open animation `a`) @param {any} m @param {any} a @param {string} part @param {string} from @param {string} to */
export function renamePartJoint(m, a, part, from, to) {
  for (const x of m.assembly ?? []) {
    if (x.part !== part) continue;
    for (const r of x.joints ?? []) if (r.name === from) r.name = to;
    const was = `${x.name}.${from}`;
    renameChannels(m, a, (n) => (n === was ? `${x.name}.${to}` : undefined));
  }
}

/** dropPartJoint forgets how the instances placing `part` set its joint `name` at rest (it is gone) @param {any} m @param {string} part @param {string} name */
export function dropPartJoint(m, part, name) {
  for (const x of m.assembly ?? []) if (x.part === part) setInstanceRest(x, name, "twist", 0), setInstanceRest(x, name, "bend", 0);
}

/** how instance `inst` sets its part's joint `name` at rest: {twist, bend}, radians, 0 when it doesn't say @param {any} inst @param {string} name */
export function instanceRest(inst, name) {
  const r = inst.joints?.find((/** @type {any} */ x) => x.name === name);
  return { twist: r?.twist ?? 0, bend: r?.bend ?? 0 };
}

/**
 * setInstanceRest sets how `inst` sets its part's joint `name` at rest: `key` (twist or bend) to
 * `v` radians. An entry left all 0 goes, and the list with it.
 * @param {any} inst @param {string} name @param {"twist" | "bend"} key @param {number} v
 */
export function setInstanceRest(inst, name, key, v) {
  let r = inst.joints?.find((/** @type {any} */ x) => x.name === name);
  if (!r) {
    if (!v) return;
    (inst.joints ??= []).push((r = { name }));
  }
  if (v) r[key] = r5(v);
  else delete r[key];
  if (!r.twist && !r.bend) inst.joints.splice(inst.joints.indexOf(r), 1);
  if (!inst.joints.length) delete inst.joints;
}

/** @param {any} m @param {string} from @param {string} to */
export function renameMaterial(m, from, to) {
  for (const p of m.parts ?? []) for (const s of p.shapes ?? []) if (s.material === from) s.material = to;
  for (const k of ["female", "male", "metal"]) if (m.hardware?.[k] === from) m.hardware[k] = to;
}

/**
 * renameChannels renames channels wherever they are named: the model's rest pose and the open
 * animation's motions' moves. `rename` gives a name's new one, or undefined to keep it.
 * @param {any} m @param {any} a @param {(name: string) => string | undefined} rename
 */
export function renameChannels(m, a, rename) {
  const renamed = (/** @type {any} */ by) => Object.fromEntries(Object.entries(by ?? {}).map(([n, v]) => [rename(n) ?? n, v]));
  if (m?.pose?.by) m.pose.by = renamed(m.pose.by);
  for (const c of a?.clips ?? []) for (const mo of c.motions ?? []) for (const mv of mo.moves ?? []) mv.by = renamed(mv.by);
}

/**
 * insertArcPoint adds a point to arc `points` after point `i`: `at`, else halfway to the next (on
 * past the last, along its last segment). Every later point moves one on along the shape.
 * @param {number[][]} points @param {number} i @param {number[]} [at]
 */
export function insertArcPoint(points, i, at) {
  const p = points[i];
  const back = points[i - 1] ?? p.map((x, c) => (c === 2 ? x - 0.5 : x));
  const q = points[i + 1] ?? p.map((x, c) => 2 * x - back[c]);
  points.splice(i + 1, 0, at ?? p.map((x, c) => Math.round(((x + q[c]) / 2) * 1e4) / 1e4));
}

/**
 * removeArcPoint removes point `i` of arc `arc` (never below two). Returns whether it did.
 * @param {any} arc @param {number} i
 */
export function removeArcPoint(arc, i) {
  if (arc.points.length <= 2) return false;
  arc.points.splice(i, 1);
  return true;
}

/** the moves naming arc `name`, where: {clip, motion, move, mv, on (the position it moves)} @param {any} a @param {string} name */
export function arcUsers(a, name) {
  const out = [];
  for (const [c, clip] of (a?.clips ?? []).entries())
    for (const [k, mo] of (clip.motions ?? []).entries())
      for (const [n, mv] of (mo.moves ?? []).entries()) for (const [on, v] of Object.entries(mv.by ?? {})) if (v === name) out.push({ clip: c, motion: k, move: n, mv, on });
  return out;
}

/** arc `from` renamed, carried to the moves naming it @param {any} a @param {string} from @param {string} to */
export function renameArc(a, from, to) {
  for (const u of arcUsers(a, from)) u.mv.by[u.on] = to;
  const arc = a.arcs?.find((/** @type {any} */ x) => x.name === from);
  if (arc) arc.name = to;
}

/** arc `name` deleted, and the moves' values naming it @param {any} a @param {string} name */
export function deleteArc(a, name) {
  for (const u of arcUsers(a, name)) delete u.mv.by[u.on];
  a.arcs = (a.arcs ?? []).filter((/** @type {any} */ x) => x.name !== name);
  if (!a.arcs.length) delete a.arcs;
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

/** the first slot of instance i's part no child is matched on, or "" @param {any} m @param {number} i */
export function freeSlot(m, i) {
  const part = partOf(m, i);
  const kids = (m.assembly ?? []).filter((/** @type {any} */ x) => x.parent === m.assembly[i].name);
  return part?.slots?.find((/** @type {any} */ s) => !kids.some((/** @type {any} */ x) => x.parent_slot === s.name))?.name ?? "";
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
 * `joints` the hardware of the joints it hangs by.
 * @param {any} part @param {number} f @param {boolean} [joints]
 */
export function scalePart(part, f, joints = false) {
  if (joints) for (const j of part.joints ?? []) scaleJoint(j, f);
  /** @param {number[] | undefined} v */
  const mul = (v) => v && round(v.map((c) => c * f));
  for (const s of part.shapes ?? []) {
    s.position = mul(s.position);
    s.size = mul(s.size);
  }
  for (const s of part.slots ?? []) s.position = mul(s.position);
}

// ---- joint hardware --------------------------------------------------------------------------------

/** jointSize is a joint's size: what its hardware is scaled by (a hinge's width across its lugs, a ball's, a disc's or a barrel's diameter, at the defaults). 0: no hardware. @param {any} j */
export const jointSize = (j) => j.size ?? 0;

/** scaleJoint scales a joint's hardware by f. @param {any} j @param {number} f */
export function scaleJoint(j, f) {
  if (j.size) j.size = r5(j.size * f);
}


/** sets one end (0: min, 1: max) of joint j's range on axis k; a range left all zero goes @param {any} j @param {number} k @param {number} end @param {number} v */
export function setJointRange(j, k, end, v) {
  const key = end ? "max" : "min";
  j[key] = [...(j[key] ?? [0, 0, 0])];
  j[key][k] = r5(v);
  for (const x of ["min", "max"]) if (j[x]?.every((/** @type {number} */ c) => c === 0)) delete j[x];
}

/**
 * setJointKind makes `j` a `kind` joint: a hinge keeps its axis and a pin its reach (a new one
 * pivots its own size out: room for lugs), the other kinds drop them; `size` when it has none yet.
 * Every kind builds hardware, measured from its few values (mech.joint_dims).
 * @param {any} j @param {string} kind @param {number} [size]
 */
export function setJointKind(j, kind, size) {
  if (kind === "HINGE") delete j.kind;
  else j.kind = kind;
  if (kind !== "HINGE") delete j.axis;
  if (kind === "HINGE" && !isTurntable(j)) j.reach ??= 1;
  else delete j.reach;
  if (!j.size && size) j.size = size;
  return j;
}

/**
 * setJointAxis turns a hinge about `axis`: X a pin (its reach, a new one its own size out), Y a
 * turntable (two discs, no reach). @param {any} j @param {string} axis
 */
export function setJointAxis(j, axis) {
  if (axis === "Y") (j.axis = "Y"), delete j.reach;
  else delete j.axis, (j.reach ??= 1);
  return j;
}

/** a joint size to suit a part's first shape: about its narrower width @param {any} part */
export function jointSizeFor(part) {
  const s = part?.shapes?.[0]?.size;
  return s ? r5(0.9 * Math.min(s[0], s[2])) : 0;
}

/** how much of the face it sits on a joint's size fills, per kind: a hinge's lugs nearly its width, a ball's flange (1.3 × its size) a little less */
const JOINT_FILL = { HINGE: 0.9, BALL: 0.65 };

/**
 * fitJoint is a size for a `kind` joint that suits the face of the part's shapes at its origin
 * (facing +y toward its joints): the face nearest it that faces the same way, its narrower width
 * times the kind's fill. Joints are sized by the members they join, as a clevis is by its link.
 * 0 when no face faces that way.
 * @param {any} part @param {string} kind @param {Face[][]} faces the part's ("faces" query)
 */
export function fitJoint(part, kind, faces) {
  const at = [0, 0, 0];
  const normal = [0, 1, 0];
  let best = null;
  let near = Infinity;
  for (const f of faces.flat()) {
    if (dot(f.normal, normal) < 0.9 || !f.extent) continue;
    const d = Math.hypot(...f.position.map((c, k) => c - at[k]));
    if (d < near) (near = d), (best = f);
  }
  return best ? r5((JOINT_FILL[/** @type {keyof typeof JOINT_FILL} */ (kind)] ?? 0.9) * Math.min(...best.extent)) : 0;
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
 * the body, replacing what is there. The copies place the same parts, each the twin of the one it
 * copies (`mirror` names the left one), so the engine reflects them and the way their channels move
 * them, and twin moves move both (docs/modeling.md). The copy is
 * matched with the other side's slot of the parent's part (l_ to r_), made by reflecting this
 * one's across the parent when the part has none. `lateral` is the model's x in the parent's frame
 * at rest. The copies get the other side's names, and IK targets on the copied instances are copied
 * too. Returns the copy's index.
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

  // each copy is its source's twin: a copy of a left instance mirrors it; a copy of a mirrored one
  // is the side it mirrors, named so (its source keeps naming it)
  for (const p of block) {
    const from = p.name;
    p.name = names.get(p.name);
    if (p !== root) p.parent = names.get(p.parent) ?? p.parent;
    if (p.mirror) delete p.mirror;
    else p.mirror = from;
  }
  for (const ik of [...(m.iks ?? [])]) {
    if (!names.has(ik.tip)) continue;
    const name = mirrorName(ik.name) ?? `${ik.name}_mirror`;
    const at = m.iks.findIndex((/** @type {any} */ x) => x.name === name);
    if (at >= 0) m.iks.splice(at, 1);
    const k = addIk(m, name, /** @type {string} */ (names.get(ik.tip)));
    if (ik.aim) m.iks[k].aim = true;
  }

  if (at < 0) {
    const p = instanceIndex(m, root.parent);
    at = p >= 0 ? subtreeEnd(m, p) : parts.length;
  }
  parts.splice(at, 0, ...block);
  return at;
}
