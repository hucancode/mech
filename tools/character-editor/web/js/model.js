// @ts-check
// Helpers over model and animation data: the parts library, its slots and the joints they expose,
// the assembly tree (instances matching slots), channel values, arcs, names, renames. Data only; anything the game computes, the viewer computes
// (src/viewer/query.odin).

import { apply, euler, eulerFrom, mul, rotation, transpose } from "./math3.js";

/**
 * The names the formats use, from the engine's own types (the "schema" query, mech.Schema): each
 * enum's names (the first is the default, left out of files), the prefixes of a placed side's
 * names, the names of the root's and an IK target's channels, values per channel kind, the
 * budgets. Filled in when the viewer starts (editor.start); the page keeps no copy of its own.
 * @type {{enums: Record<string, string[]>, sides: Record<string, string>, channels: Record<string, string>, sizes: Record<string, number>, budgets: Record<string, number>}}
 */
export const schema = { enums: {}, sides: {}, channels: {}, sizes: {}, budgets: {} };

/** the names of engine enum `name` (mech.Primitive, mech.JointKind, mech.Plane, mech.Ease, ...), in order @param {string} name @returns {string[]} */
export const enumNames = (name) => schema.enums[name] ?? [];
/**
 * The quarter turns each primitive looks the same under, so a shape turned by one can show it as
 * its size instead: "any" (a box, a sphere: any axes swapped or flipped), "y" (a cylinder: any that
 * keep its y on y); the others (a wedge, a cone, half and quarter cylinders) have their own way up.
 * @type {Record<string, "any" | "y">}
 */
const PRIMITIVE_SYMMETRY = { BOX: "any", SPHERE: "any", CYLINDER: "y" };
/** setMirror mirrors shape or slot `x` across `plane` of its part (mech.Plane), NONE for not @param {any} x @param {string} plane */
export function setMirror(x, plane) {
  if (plane && plane !== "NONE") x.mirror = plane;
  else delete x.mirror;
  return x;
}

/** a joint's kind (mech.JointKind), the default (PIN) when it says none, as the engine reads it @param {any} j @returns {string} */
export const jointKind = (j) => j?.kind ?? enumNames("JointKind")[0];

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

// ---- channel values: a number, or [x, y, z] (mech.ChannelKind's size); a move's `by` also names
// arcs, a string under a position --------------------------------------------------------------

/** @typedef {number | number[]} Value a channel's value(s) */

/** a + b, value by value @param {Value | undefined} a @param {Value} b @returns {Value} */
export const addValue = (a, b) => (Array.isArray(b) ? b.map((x, k) => (/** @type {any} */ (a)?.[k] ?? 0) + x) : /** @type {number} */ (a ?? 0) + b);

/** f of each of a value's values (and of b's, alike) @param {Value} a @param {Value | undefined} b @param {(x: number, y: number) => number} f @returns {Value} */
export const zipValue = (a, b, f) => (Array.isArray(a) ? a.map((x, k) => f(x, /** @type {any} */ (b)?.[k] ?? 0)) : f(a, /** @type {number} */ (b ?? 0)));

/** a channel's value at rest: 0, or [0, 0, 0] @param {any} c a channel (the "channels" query) @returns {Value} */
export const zeroValue = (c) => (c?.size === 3 ? [0, 0, 0] : 0);

/** the names of animation `a`'s poses (mech.Pose) @param {any} a @returns {Set<string>} */
export const poseNames = (a) => new Set((a?.poses ?? []).map((/** @type {any} */ p) => p.name));

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
  const own = mv?.by ?? {};
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

// ---- references: where each name is written (the engine's "refs" query, mech.references) ------

/** @typedef {{kind: string, name: string, item: string, index: number, move: number}} Path a thing of a character (mech.Path) */
/** @typedef {{ptr: string, key: boolean, def: boolean, span: [number, number], to: Path, at: Path}} Ref one place a name is written (mech.Ref) */

/** whether paths `a` and `b` are the same thing @param {Path} a @param {Path} b */
export const samePath = (a, b) => a.kind === b.kind && a.name === b.name && a.item === b.item && a.index === b.index && a.move === b.move;

/** a path of `kind` (mech.Path), its unused fields zero as the engine writes them @param {string} kind @param {Partial<Path>} [o] @returns {Path} */
export const path = (kind, o = {}) => ({ kind, name: "", item: "", index: 0, move: 0, ...o });

/**
 * locate is where JSON pointer `ptr` (from a character file's top: /model/..., /animation/...)
 * points in `doc`: the object holding it, and its key there
 * @param {{model: any, animation: any}} doc @param {string} ptr @returns {[any, string]}
 */
function locate(doc, ptr) {
  const steps = ptr.split("/").slice(1).map((x) => x.replace(/~1/g, "/").replace(/~0/g, "~"));
  /** @type {any} */
  let o = doc;
  for (const x of steps.slice(0, -1)) o = o?.[x];
  return [o, /** @type {string} */ (steps.at(-1))];
}

/** renameKey renames key `from` of object `o` to `to` in place, keeping the keys' order @param {any} o @param {string} from @param {string} to */
function renameKey(o, from, to) {
  const entries = Object.entries(o).map(([k, v]) => /** @type {[string, any]} */ ([k === from ? to : k, v]));
  for (const k of Object.keys(o)) delete o[k];
  for (const [k, v] of entries) o[k] = v;
}

/**
 * renameRefs renames thing `to` to `name` wherever it is written (`refs`, the data's as it is
 * now): its own name, and its part of every name that holds it (`l_arm.elbow`: the instance's, the
 * joint's), on either side of the body. @param {{model: any, animation: any}} doc @param {Ref[]} refs @param {Path} to @param {string} name
 */
export function renameRefs(doc, refs, to, name) {
  for (const r of refs) {
    if (!samePath(r.to, to)) continue;
    const [o, k] = locate(doc, r.ptr);
    if (!o) continue;
    const was = r.key ? k : o[k];
    if (typeof was !== "string") continue;
    const now = was.slice(0, r.span[0]) + name + was.slice(r.span[1]);
    if (r.key) renameKey(o, k, now);
    else o[k] = now;
  }
}

/**
 * deleteThing takes thing `to` out of its list (an arc, a pose, a clip...), and what names it
 * (dropRefs); an emptied list goes too. @param {{model: any, animation: any}} doc @param {Ref[]} refs @param {Path} to
 */
export function deleteThing(doc, refs, to) {
  dropRefs(doc, refs, to);
  const def = refs.find((r) => r.def && samePath(r.to, to));
  if (!def) return;
  const steps = def.ptr.split("/");
  const listPtr = steps.slice(0, -2).join("/");
  const [holder, key] = locate(doc, listPtr);
  const list = holder?.[key];
  if (!Array.isArray(list)) return;
  list.splice(Number(steps.at(-2)), 1);
  if (!list.length) delete holder[key];
}

/**
 * dropRefs takes out what names thing `to`, which is going (`refs`, the data's as it is now): an
 * amount, a pose added or an arc followed (a move's `by`, `poses`, `arcs`) goes; an entry of a list (an instance's mount
 * of a joint) goes; another field naming it is left out. Its own name stays: the caller takes the
 * thing itself out. @param {{model: any, animation: any}} doc @param {Ref[]} refs @param {Path} to
 */
export function dropRefs(doc, refs, to) {
  /** @type {[any[], number][]} entries of lists to take out, after the rest */
  const entries = [];
  for (const r of refs) {
    if (r.def || !samePath(r.to, to)) continue;
    const steps = r.ptr.split("/");
    const [o, k] = locate(doc, r.ptr);
    if (!o) continue;
    // a name in one of the maps by name: a move's or a pose's amounts, the poses a move adds, the
    // arcs its positions follow, the rest pose
    const inMap = ["by", "poses", "arcs"].includes(/** @type {string} */ (steps.at(-2))) || r.ptr.startsWith("/model/pose/");
    if (inMap) delete o[k];
    else if (k === "name" && /^\d+$/.test(/** @type {string} */ (steps.at(-2)))) {
      const [list] = locate(doc, steps.slice(0, -1).join("/"));
      if (Array.isArray(list)) entries.push([list, Number(steps.at(-2))]);
    } else delete o[k];
  }
  // from the last, so the indices hold
  entries.sort((x, y) => y[1] - x[1]);
  for (const [list, i] of entries) list.splice(i, 1);
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

/**
 * where along arc `arc` each of its points is, 0 the first, 1 the end (mech.arc_knots): its `at`
 * when it has one per point, else evenly, k / segments (one per point when closed: the last back to
 * the first) @param {any} arc @returns {number[]}
 */
export function arcKnots(arc) {
  const n = arc.points.length;
  if (arc.at?.length === n) return arc.at;
  const segments = arc.closed && n > 2 ? n : n - 1;
  return arc.points.map((/** @type {any} */ _, /** @type {number} */ k) => r4(k / Math.max(segments, 1)));
}

const r4 = (/** @type {number} */ v) => Math.round(v * 1e4) / 1e4;

/**
 * insertArcPoint adds a point to arc `arc` after point `i`: `at`, else halfway to the next (on past
 * the last, along its last segment). Every point says where along the arc it is (`at`), so the
 * others stay where they were and the moves on the arc as timed: the new one halfway between its
 * neighbours' places. Past an open arc's end, the new point is the end (1) and the old last point
 * halfway to it. Its corners stay on their points. @param {any} arc @param {number} i @param {number[]} [at]
 */
export function insertArcPoint(arc, i, at) {
  const points = arc.points;
  const knots = [...arcKnots(arc)];
  const p = points[i];
  const back = points[i - 1] ?? p.map((/** @type {number} */ x, /** @type {number} */ c) => (c === 2 ? x - 0.5 : x));
  const q = points[i + 1] ?? (arc.closed && points.length > 2 ? points[0] : undefined) ?? p.map((/** @type {number} */ x, /** @type {number} */ c) => 2 * x - back[c]);
  points.splice(i + 1, 0, at ?? p.map((/** @type {number} */ x, /** @type {number} */ c) => r4((x + q[c]) / 2)));
  const last = i === knots.length - 1;
  if (last && !(arc.closed && points.length > 3)) {
    // past an open arc's end: the new point is the end
    knots[i] = r4((knots[i - 1] + knots[i]) / 2);
    knots.push(1);
  } else {
    const next = last ? knots[0] + 1 : knots[i + 1];
    knots.splice(i + 1, 0, r4((knots[i] + next) / 2));
  }
  arc.at = knots;
  if (arc.corners) arc.corners = arc.corners.map((/** @type {number} */ k) => (k > i ? k + 1 : k));
}

/**
 * removeArcPoint removes point `i` of arc `arc` (never below two); the others stay where they were
 * along it (`at`), and the moves on it as timed. An open arc's end taken out, the point next to it
 * becomes the end (0 or 1). Its corners stay on their points, its own dropped. Returns whether it
 * removed it. @param {any} arc @param {number} i
 */
export function removeArcPoint(arc, i) {
  const n = arc.points.length;
  if (n <= 2) return false;
  const knots = [...arcKnots(arc)];
  const end = !arc.closed && (i === 0 || i === n - 1) ? knots[i] : null;
  arc.points.splice(i, 1);
  knots.splice(i, 1);
  if (end !== null) knots[i === 0 ? 0 : knots.length - 1] = end;
  arc.at = knots;
  if (arc.corners) {
    arc.corners = arc.corners.filter((/** @type {number} */ k) => k !== i).map((/** @type {number} */ k) => (k > i ? k - 1 : k));
    if (!arc.corners.length) delete arc.corners;
  }
  return true;
}

/**
 * setArcClosed makes arc `arc` closed (on from its last point back to its first) or open. Its
 * points are spread evenly again (no `at`): a closed arc needs room for the way back, so the moves
 * on it run its points at new times (the editor says so) @param {any} arc @param {boolean} on
 */
export function setArcClosed(arc, on) {
  if (on) arc.closed = true;
  else delete arc.closed;
  delete arc.at;
}

/** arc `arc` with point `i` a corner or not (mech.Arc.corners) @param {any} arc @param {number} i @param {boolean} on */
export function setArcCorner(arc, i, on) {
  const rest = (arc.corners ?? []).filter((/** @type {number} */ k) => k !== i);
  arc.corners = on ? [...rest, i].sort((x, y) => x - y) : rest;
  if (!arc.corners.length) delete arc.corners;
}

// ---- poses: named sets of amounts a move adds by name (mech.Pose) ---------------------------------

/**
 * poseFromMove makes move `mv`'s amounts a new pose of animation `a`, `name`, and has the move add
 * it instead (the poses it adds and its arcs stay). @param {any} a @param {any} mv @param {string} name
 */
export function poseFromMove(a, mv, name) {
  (a.poses ??= []).push({ name, by: mv.by ?? {} });
  delete mv.by;
  mv.poses = { ...(mv.poses ?? {}), [name]: 1 };
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

