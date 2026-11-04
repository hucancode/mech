// @ts-check
// Helpers over model and animation data: the parts library, its slots and the joints they expose,
// the assembly tree (instances matching slots), channel values, arcs, names, renames. Data only; anything the game computes, the viewer computes
// (src/viewer/query.odin).

import { apply, euler, eulerFrom, mul, rotation, transpose } from "./math3.js";

export const PRIMITIVES = ["BOX", "WEDGE", "CYLINDER", "HALF_CYLINDER", "QUARTER_CYLINDER", "CONE", "SPHERE"];
/**
 * The quarter turns each primitive looks the same under, so a shape turned by one can show it as
 * its size instead: "any" (a box, a sphere: any axes swapped or flipped), "y" (a cylinder: any that
 * keep its y on y); the others (a wedge, a cone, half and quarter cylinders) have their own way up.
 * @type {Record<string, "any" | "y">}
 */
const PRIMITIVE_SYMMETRY = { BOX: "any", SPHERE: "any", CYLINDER: "y" };
/** the planes of a part's frame a shape or a slot can be mirrored across (mech.Plane): NONE, the default, is left out of files */
export const MIRROR_PLANES = ["NONE", "X", "Y", "Z"];

/** setMirror mirrors shape or slot `x` across `plane` of its part (mech.Plane), NONE for not @param {any} x @param {string} plane */
export function setMirror(x, plane) {
  if (plane && plane !== "NONE") x.mirror = plane;
  else delete x.mirror;
  return x;
}

/** the kinds a joint can be (mech.JointKind): a pin (one turn about x), a turntable (SPIN: one turn about y), a linear actuator (one slide), a ball (three turns). PIN, the default, is left out of files; a part with no joints is bolted on rigid */
export const JOINT_KINDS = ["PIN", "SPIN", "LINEAR", "BALL"];

/** a joint's kind, PIN when it says none (as the engine reads it) @param {any} j @returns {string} */
export const jointKind = (j) => j?.kind ?? "PIN";
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
  return (m.assembly ?? []).filter((/** @type {any} */ x) => x.parent && (x.parent_slot ?? "") === slot && m.assembly[instanceIndex(m, x.parent)]?.part === part);
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
  return engineDofs(j)?.axes ?? (kind === "BALL" ? ["X", "Y", "Z"] : kind === "PIN" ? ["X"] : ["Y"]);
}

/** a joint's channel: one per joint, `<instance>.<joint>` (a number, or [x, y, z] for a ball); `inst` as placed (`l_arm`: placedNames) @param {string} inst @param {any} j */
export const jointChannel = (inst, j) => `${inst}.${j.name}`;

/**
 * the names instance `i` is placed by (the engine's "places" query, mech.model_places): its own,
 * or on each side of the body, `l_<name>` and `r_<name>`, when it hangs from a mirrored slot or
 * from one that does. `places` is the query's answer.
 * @param {{name: string, inst: number, side: string}[]} places @param {any} m @param {number} i @returns {string[]}
 */
export function placedNames(places, m, i) {
  const own = places.filter((p) => p.inst === i).map((p) => p.name);
  return own.length ? own : [m.assembly?.[i]?.name ?? ""];
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

/**
 * the amounts among a move's values: not its arcs, nor the poses it adds (named in `poses`, the
 * animation's: poseNames) @param {Record<string, any> | undefined} by @param {Set<string>} [poses] @returns {Record<string, Value>}
 */
export const amountsOf = (by, poses) => Object.fromEntries(Object.entries(by ?? {}).filter(([n, v]) => typeof v !== "string" && !poses?.has(n)));

/** the names of animation `a`'s poses (mech.Pose) @param {any} a @returns {Set<string>} */
export const poseNames = (a) => new Set((a?.poses ?? []).map((/** @type {any} */ p) => p.name));

/** the poses a move adds, by name, each how much of it @param {Record<string, any> | undefined} by @param {Set<string>} poses @returns {Record<string, number>} */
export const posesOf = (by, poses) => Object.fromEntries(Object.entries(by ?? {}).filter(([n, v]) => typeof v === "number" && poses.has(n)));

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
 * oneSide writes values (by channel) as the rest pose holds them (mech.Model.pose, symmetric): one
 * side of each pair of twins (the left kept, l_ before r_), its twin moving with it. `asymmetric`
 * says some twin differed from its side (x mirrored), which the rest pose can't hold: asymmetry is a
 * clip's. @param {Record<string, Value>} values @param {Twins} twins @returns {{by: Record<string, Value>, asymmetric: boolean}}
 */
export function oneSide(values, twins) {
  const near = (/** @type {Value} */ a, /** @type {Value} */ b) => [a].flat().every((x, k) => Math.abs(x - ([b].flat()[k] ?? 0)) < 1e-6);
  const zero = (/** @type {Value} */ v) => zipValue(v, v, () => 0);
  /** @type {Record<string, Value>} */
  const by = {};
  let asymmetric = false;
  for (const [n, v] of Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const t = twins[n];
    if (t && t.twin in by) {
      asymmetric ||= !near(v, zipValue(by[t.twin], t.flip, (x, f) => x * f));
      continue;
    }
    if (t && !(t.twin in values)) asymmetric ||= !near(zero(v), zipValue(v, t.flip, (x, f) => x * f));
    by[n] = v;
  }
  return { by, asymmetric };
}

/** a deep copy of plain data @template T @param {T} v @returns {T} */
export const clone = (v) => JSON.parse(JSON.stringify(v));

// ---- renames, carried through everything that names the thing --------------------------------

/** an instance's rename, carried to its children, the IK targets on it, and its joints' channels on either side of the body (`l_<name>.<joint>`, in the rest pose and the open animation `a`) @param {any} m @param {any} a @param {string} from @param {string} to */
export function renameInstance(m, a, from, to) {
  renameChannels(m, a, (n) => {
    for (const side of ["", "l_", "r_"]) if (n.startsWith(`${side}${from}.`)) return side + to + n.slice(side.length + from.length);
    return undefined;
  });
  for (const p of m.assembly ?? []) if (p.parent === from) p.parent = to;
  for (const ik of m.iks ?? []) if (ik.tip === from) ik.tip = to;
}

/** a library part's rename, carried to the instances placing it @param {any} m @param {string} from @param {string} to */
export function renamePart(m, from, to) {
  for (const p of m.assembly ?? []) if (p.part === from) p.part = to;
}

/** slot `from` of library part `part` renamed, carried to the instances matched on it @param {any} m @param {string} part @param {string} from @param {string} to */
export function renameSlot(m, part, from, to) {
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

/** dropPartJoint forgets how the instances placing `part` mount its joint `name` (it is gone) @param {any} m @param {string} part @param {string} name */
export function dropPartJoint(m, part, name) {
  for (const x of m.assembly ?? []) if (x.part === part) setInstanceTwist(x, name, 0);
}

/** how instance `inst` turns its part's joint `name` on its socket (mech.InstanceJoint): radians, 0 when it doesn't say @param {any} inst @param {string} name @returns {number} */
export function instanceTwist(inst, name) {
  return inst.joints?.find((/** @type {any} */ x) => x.name === name)?.twist ?? 0;
}

/**
 * setInstanceTwist sets how `inst` turns its part's joint `name` on its socket, `v` radians. An
 * entry left 0 goes, and the list with it. (How a joint stands at rest is the rest pose's.)
 * @param {any} inst @param {string} name @param {number} v
 */
export function setInstanceTwist(inst, name, v) {
  let r = inst.joints?.find((/** @type {any} */ x) => x.name === name);
  if (!r) {
    if (!v) return;
    (inst.joints ??= []).push((r = { name }));
  }
  if (v) r.twist = r5(v);
  else inst.joints.splice(inst.joints.indexOf(r), 1);
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
  if (m?.pose) m.pose = renamed(m.pose);
  for (const p of a?.poses ?? []) p.by = renamed(p.by);
  for (const c of a?.clips ?? []) for (const mo of c.motions ?? []) for (const mv of mo.moves ?? []) mv.by = renamed(mv.by);
}

/** how many segments arc `arc` runs over (mech.arc_at): one per point when closed (the last back to the first), else one fewer @param {any} arc @param {number} [n] its points */
export const arcSpan = (arc, n = arc.points.length) => (arc.closed && n > 2 ? n : n - 1);

/**
 * arcRetime keeps the moves on arc `arc` where they were along it as its points change: each
 * motion moving a position on it has its shape's values (k / segments for point k, mech.arc_at)
 * carried to its new points by `to` (a value in old point units, k for point k, to new ones), from
 * `was` segments to `span`. A motion whose shape something else also follows (an amount, another
 * arc) is left as it is, since moving its shape would move those too; returns how many were.
 * @param {any} a the animation @param {any} arc @param {number} was @param {number} span @param {(k: number) => number} to
 */
function arcRetime(a, arc, was, span, to) {
  /** @type {Set<any>} */
  const done = new Set();
  let shared = 0;
  for (const u of arcUsers(a, arc.name)) {
    const mo = a.clips[u.clip].motions[u.motion];
    if (done.has(mo)) continue;
    done.add(mo);
    // amounts and the poses a move adds are numbers alike
    const alone = (mo.moves ?? []).every((/** @type {any} */ mv) => Object.keys(amountsOf(mv.by)).length === 0 && Object.values(arcsOf(mv.by)).every((x) => x === arc.name));
    if (!alone) {
      shared += 1;
      continue;
    }
    for (const p of mo.shape ?? []) {
      const v = Math.round((to((p.v ?? 0) * was) / span) * 1e4) / 1e4;
      if (v) p.v = v;
      else delete p.v;
    }
  }
  return shared;
}

/**
 * insertArcPoint adds a point to arc `arc` of animation `a` after point `i`: `at`, else halfway to
 * the next (on past the last, along its last segment). The moves on it keep their timing along it
 * (arcRetime: the segment split in two halves), and its corners stay on their points. Returns how
 * many motions' shapes it could not retime.
 * @param {any} a @param {any} arc @param {number} i @param {number[]} [at]
 */
export function insertArcPoint(a, arc, i, at) {
  const points = arc.points;
  const p = points[i];
  const back = points[i - 1] ?? p.map((/** @type {number} */ x, /** @type {number} */ c) => (c === 2 ? x - 0.5 : x));
  const q = points[i + 1] ?? (arc.closed && points.length > 2 ? points[0] : undefined) ?? p.map((/** @type {number} */ x, /** @type {number} */ c) => 2 * x - back[c]);
  const shared = arcRetime(a, arc, arcSpan(arc), arcSpan(arc, points.length + 1), (k) => (k <= i ? k : k >= i + 1 ? k + 1 : i + 2 * (k - i)));
  points.splice(i + 1, 0, at ?? p.map((/** @type {number} */ x, /** @type {number} */ c) => Math.round(((x + q[c]) / 2) * 1e4) / 1e4));
  if (arc.corners) arc.corners = arc.corners.map((/** @type {number} */ k) => (k > i ? k + 1 : k));
  return shared;
}

/**
 * removeArcPoint removes point `i` of arc `arc` of animation `a` (never below two). The moves on it
 * keep their timing along it (arcRetime: the two segments either side of it joined into one), and
 * its corners stay on their points, its own dropped. Returns whether it removed it.
 * @param {any} a @param {any} arc @param {number} i
 */
export function removeArcPoint(a, arc, i) {
  const n = arc.points.length;
  if (n <= 2) return false;
  // the point's two segments, [lo, hi] (one at an end), become one
  const lo = Math.max(i - 1, 0);
  const hi = Math.min(i + 1, n - 1);
  arcRetime(a, arc, arcSpan(arc), arcSpan(arc, n - 1), (k) => (k <= lo ? k : k >= hi ? k - 1 : lo + ((k - lo) / (hi - lo)) * (hi - 1 - lo)));
  arc.points.splice(i, 1);
  if (arc.corners) {
    arc.corners = arc.corners.filter((/** @type {number} */ k) => k !== i).map((/** @type {number} */ k) => (k > i ? k - 1 : k));
    if (!arc.corners.length) delete arc.corners;
  }
  return true;
}

/** setArcClosed makes arc `arc` closed (on from its last point back to its first) or open; the moves on it keep their place along it as far as they can (point k stays point k) @param {any} a the animation @param {any} arc @param {boolean} on */
export function setArcClosed(a, arc, on) {
  const was = arcSpan(arc);
  if (on) arc.closed = true;
  else delete arc.closed;
  arcRetime(a, arc, was, arcSpan(arc), (k) => k);
}

/** arc `arc` with point `i` a corner or not (mech.Arc.corners) @param {any} arc @param {number} i @param {boolean} on */
export function setArcCorner(arc, i, on) {
  const rest = (arc.corners ?? []).filter((/** @type {number} */ k) => k !== i);
  arc.corners = on ? [...rest, i].sort((x, y) => x - y) : rest;
  if (!arc.corners.length) delete arc.corners;
}

// ---- poses: named sets of amounts a move adds by name (mech.Pose) ---------------------------------

/** the moves adding pose `name`: {clip, motion, move, mv} @param {any} a @param {string} name */
export function poseUsers(a, name) {
  const out = [];
  for (const [c, clip] of (a?.clips ?? []).entries())
    for (const [k, mo] of (clip.motions ?? []).entries()) for (const [n, mv] of (mo.moves ?? []).entries()) if (typeof mv.by?.[name] === "number") out.push({ clip: c, motion: k, move: n, mv });
  return out;
}

/** pose `from` renamed, carried to the moves adding it @param {any} a @param {string} from @param {string} to */
export function renamePose(a, from, to) {
  for (const u of poseUsers(a, from)) u.mv.by = Object.fromEntries(Object.entries(u.mv.by).map(([n, v]) => [n === from ? to : n, v]));
  const p = a.poses?.find((/** @type {any} */ x) => x.name === from);
  if (p) p.name = to;
}

/** pose `name` deleted, and the moves' values adding it @param {any} a @param {string} name */
export function deletePose(a, name) {
  for (const u of poseUsers(a, name)) delete u.mv.by[name];
  a.poses = (a.poses ?? []).filter((/** @type {any} */ x) => x.name !== name);
  if (!a.poses.length) delete a.poses;
}

/**
 * poseFromMove makes move `mv`'s amounts a new pose of animation `a`, `name`, and has the move add
 * it instead (its arcs and the poses it adds stay). @param {any} a @param {any} mv @param {string} name
 */
export function poseFromMove(a, mv, name) {
  const poses = poseNames(a);
  const amounts = amountsOf(mv.by, poses);
  (a.poses ??= []).push({ name, by: amounts });
  mv.by = { ...Object.fromEntries(Object.entries(mv.by ?? {}).filter(([n]) => !(n in amounts))), [name]: 1 };
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

/** a shape's centre, from its faces (the "faces" query, stretch resolved): between its +x and -x faces @param {Face[]} faces */
export const faceCentre = (faces) => faces[0].position.map((c, k) => (c + faces[1].position[k]) / 2);

/**
 * @typedef {{position: number[], rotation: number[], length: number}} SpanFrame
 * the frame a shape sits in, in its part's frame (mech.shape_place): a stretched one's halfway up
 * the part's length, which it adds to the shape's size.y; else the part's own
 */

/** shapeFrame is the frame shape `s` of part `part` sits in @param {any} part @param {any} s @returns {SpanFrame} */
export function shapeFrame(part, s) {
  const length = s?.stretch ? part?.length ?? 0 : 0;
  return { position: [0, length / 2, 0], rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], length };
}

/**
 * restretch makes shape `s`, now placed in frame `from`, stretch (`on`) or not, in frame `to`,
 * without moving: its position, rotation and size.y are given again in the new frame.
 * @param {any} s @param {boolean} on @param {SpanFrame} from @param {SpanFrame} to
 */
export function restretch(s, on, from, to) {
  const at = from.position.map((c, k) => c + apply(from.rotation, s.position ?? [0, 0, 0])[k]);
  const back = transpose(to.rotation);
  s.position = round(apply(back, at.map((c, k) => c - to.position[k])));
  s.rotation = eulerFrom(mul(back, mul(from.rotation, euler(s.rotation)))).map(r5);
  s.size = [...(s.size ?? [0, 0, 0])];
  s.size[1] = r5(s.size[1] + from.length - to.length);
  if (on) s.stretch = true;
  else delete s.stretch;
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
    ...(on.stretch ? { stretch: true } : {}),
    position: round(apply(transpose(span.rotation), centre.map((c, k) => c - span.position[k]))),
    ...(on.rotation ? { rotation: [...on.rotation] } : {}),
    size,
  };
}

/**
 * tidyShape: a shape turned by quarter turns (its rotation a signed permutation of the axes) shows
 * the turn as its size instead, its rotation cleared, where its primitive looks the same
 * (PRIMITIVE_SYMMETRY). A stretched shape keeps its y on y (the part's length adds there). Other
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
  if (sym === "any" && (keepsY || !s.stretch) || (sym === "y" && keepsY)) {
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
 * newInstance hangs a new part, in a new instance, from instance `parent` (-1: a root): matched
 * on the parent part's origin when that is a link's far end (it has a length) with nothing on it,
 * else on its first free slot, else on a new slot on its first shape's
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
    // the parent's origin when it is a link's far end with nothing on it yet, else a free slot
    const kids = m.assembly.filter((/** @type {any} */ x) => x.parent === m.assembly[parent].name);
    const free = on?.length && !kids.some((/** @type {any} */ x) => !x.parent_slot);
    const slot = free ? "" : freeSlot(m, parent) || (on ? addSlot(on, name, bottomFace(on, faces)) : "");
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
  if (part.length) part.length = r5(part.length * f);
}

// ---- joint hardware --------------------------------------------------------------------------------

/** jointSize is a joint's size: what its hardware is scaled by (a hinge's width across its lugs, a ball's, a disc's or a barrel's diameter, at the defaults). 0: no hardware. @param {any} j */
export const jointSize = (j) => j.size ?? 0;

/** scaleJoint scales a joint's hardware by f. @param {any} j @param {number} f */
export function scaleJoint(j, f) {
  if (j.size) j.size = r5(j.size * f);
}


/** sets one end (0: min, 1: max) of joint j's range on axis k (every joint has stops but a turntable, which may spin free: mech.character_check) @param {any} j @param {number} k @param {number} end @param {number} v */
export function setJointRange(j, k, end, v) {
  const key = end ? "max" : "min";
  j[key] = [...(j[key] ?? [0, 0, 0])];
  j[key][k] = r5(v);
  for (const x of ["min", "max"]) if (j[x]?.every((/** @type {number} */ c) => c === 0)) delete j[x];
}

/** a new joint's stops on an axis it moves on, by kind: a turn half a radian each way, a slide half a unit out; a turntable spins free */
const DEFAULT_STOPS = { PIN: [-0.5, 0.5], BALL: [-0.5, 0.5], LINEAR: [0, 0.5], SPIN: [0, 0] };

/**
 * setJointKind makes `j` a `kind` joint: a pin keeps its reach (a new one pivots its own size out:
 * room for lugs), the other kinds drop it; `size` when it has none yet. Its stops stay on the axes
 * the kind moves on, and an axis without them gets the kind's (DEFAULT_STOPS), so it is never free
 * by accident. Every kind builds hardware, measured from its few values (mech.joint_dims).
 * @param {any} j @param {string} kind @param {number} [size]
 */
export function setJointKind(j, kind, size) {
  if (kind === "PIN") delete j.kind;
  else j.kind = kind;
  if (kind === "PIN") j.reach ??= 1;
  else delete j.reach;
  if (!j.size && size) j.size = size;
  const axes = (kind === "BALL" ? ["X", "Y", "Z"] : kind === "PIN" ? ["X"] : ["Y"]).map((a) => "XYZ".indexOf(a));
  const min = [0, 0, 0];
  const max = [0, 0, 0];
  for (const k of axes) {
    const [lo, hi] = j.min?.[k] !== j.max?.[k] ? [j.min?.[k] ?? 0, j.max?.[k] ?? 0] : DEFAULT_STOPS[/** @type {keyof typeof DEFAULT_STOPS} */ (kind)];
    (min[k] = lo), (max[k] = hi);
  }
  for (const [key, v] of /** @type {const} */ ([["min", min], ["max", max]])) {
    if (v.every((c) => c === 0)) delete j[key];
    else j[key] = v;
  }
  return j;
}

/** a joint size to suit a part's first shape: about its narrower width @param {any} part */
export function jointSizeFor(part) {
  const s = part?.shapes?.[0]?.size;
  return s ? r5(0.9 * Math.min(s[0], s[2])) : 0;
}

/** how much of the face it sits on a joint's size fills, per kind: a hinge's lugs nearly its width, a ball's flange (1.3 × its size) a little less */
const JOINT_FILL = { PIN: 0.9, BALL: 0.65 };

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

