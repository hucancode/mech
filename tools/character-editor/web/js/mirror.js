// @ts-check
import { apply, cross, fromQuat, IDENTITY, mul, normalize, reflection, transpose } from "./math3.js";
// Mirroring parts to the other side of the body (x to -x), worked out here from the joints'
// geometry the engine reports ({"q": "joints"}: each joint's bolting faces and bones).
//
// A mirrored part keeps its rest orientation and moves to the mirrored place, so a left foot
// pointing ahead gives a right foot pointing ahead. In the part's own frame that is a reflection
// across e, its axis along the model's x at rest. So:
// - its shapes move across e and keep their rotation (each is reflected across one of its own
//   axes, which all but wedges, cones and part cylinders are symmetric about)
// - its socket is reflected across the parent's e, its forward turned over to stay right-handed
// - the joint is unchanged, so the joint's frame is reflected across the forward of the face it
//   bolts on with; carried through its bones, a bone turning about that axis keeps its sign and
//   the others turn over
// - the mount is whatever seats that reflected joint onto the part reflected across e

/** @typedef {import("./math3.js").M3} M3 */
/** @typedef {{position: number[], normal: number[], forward: number[]}} Face */
/** @typedef {Record<string, {female: Face, male: Face, dofs: {axis: number, offset: number[], rest: number[]}[]}>} Joints the "joints" query's answer */

/** columns: forward, normal × forward, normal @param {number[]} normal @param {number[]} forward @returns {M3} */
function faceFrame(normal, forward) {
  const n = normalize(normal);
  const f = normalize(forward);
  const b = cross(n, f);
  return [f[0], b[0], n[0], f[1], b[1], n[1], f[2], b[2], n[2]];
}
/** the turn that bolts child's face onto parent's (geometry.seat in mjolnir) @param {any} parent @param {any} child */
function seat(parent, child) {
  const pn = parent?.normal ?? [0, 0, 0];
  return mul(faceFrame([-pn[0], -pn[1], -pn[2]], parent?.forward ?? [0, 0, 0]), transpose(faceFrame(child?.normal ?? [0, 0, 0], child?.forward ?? [0, 0, 0])));
}

/** @param {any} m @param {string | undefined} name */
const index = (m, name) => (name ? m.parts.findIndex((/** @type {any} */ p) => p.name === name) : -1);
/** @param {Joints} joints @param {any} p */
const jointOf = (joints, p) => joints[p.joint ?? ""] ?? joints[""];

/** each part's orientation at rest in the model, as the rig places it @param {any} m @param {Joints} joints @returns {M3[]} */
export function restRotations(m, joints) {
  /** @type {M3[]} */
  const out = [];
  m.parts.forEach((/** @type {any} */ p, /** @type {number} */ i) => {
    const parent = index(m, p.parent);
    if (parent < 0 || parent >= i) return void (out[i] = IDENTITY);
    const j = jointOf(joints, p);
    let r = mul(out[parent], seat(p.socket, j.female));
    for (const d of j.dofs) r = mul(r, fromQuat(d.rest));
    out[i] = mul(r, seat(j.male, p.mount));
  });
  return out;
}

/** @param {number[]} v */
const clean = (v) => v.map((c) => Math.round(c * 1e5) / 1e5 || 0);

/**
 * partMirror is how part i changes when it is mirrored with its parent (or under a parent on the
 * centre line): its socket, mount, shape positions, and which binds turn over.
 * @param {any} m @param {number} i @param {Joints} joints @param {M3[]} rest from restRotations
 */
export function partMirror(m, i, joints, rest) {
  const p = m.parts[i];
  /** @param {number} k */
  const lateral = (k) => normalize(apply(transpose(rest[k]), [1, 0, 0]));
  const te = reflection(lateral(i));
  const out = {
    socket: p.socket,
    mount: p.mount,
    flip: [false, false, false],
    shapes: (p.shapes ?? []).map((/** @type {any} */ s) => clean(apply(te, s.position ?? [0, 0, 0]))),
  };
  const parent = index(m, p.parent);
  if (parent < 0) return out;

  const tp = reflection(lateral(parent));
  const s = p.socket ?? {};
  out.socket = { position: clean(apply(tp, s.position ?? [0, 0, 0])), normal: clean(apply(tp, s.normal ?? [0, 0, 0])), forward: clean(apply(tp, s.forward ?? [0, 0, 0]).map((c) => -c)) };

  const j = jointOf(joints, p);
  const male = { ...j.male, position: p.centered ? [0, 0, 0] : j.male.position };
  let d = j.female.forward;
  j.dofs.forEach((dof, k) => {
    d = apply(transpose(fromQuat(dof.rest)), d);
    out.flip[k] = Math.abs(d[dof.axis]) < 0.5;
  });
  // seat(male, mount') = T_d · seat(male, mount) · T_e
  const td = reflection(d);
  const r = mul(mul(td, seat(male, p.mount)), te);
  const c = mul(transpose(r), faceFrame(male.normal.map((x) => -x), male.forward));
  const mp = male.position;
  const tdm = apply(td, mp);
  const lever = apply(transpose(r), [0, 1, 2].map((k) => mp[k] - tdm[k]));
  const own = apply(te, p.mount?.position ?? [0, 0, 0]);
  const position = clean(lever.map((x, k) => x + own[k]));
  out.mount = { ...(position.some((x) => x !== 0) ? { position } : {}), normal: clean([c[2], c[5], c[8]]), forward: clean([c[0], c[3], c[6]]) };
  return out;
}
