// @ts-check
// The view's direct manipulation. Click a piece to select it: its shape in the model tab, its
// instance in the assemble tab. In the model tab, drag handles drawn over the view to edit
// the selected shape, or place the part's slots:
//   move (W)    arrows along the part's axes move the shape, snapping to the other shapes' faces;
//               dots on those faces stack it there (shift: close the gap; alt: a new box on it)
//   rotate (E)  rings about the part's axes turn the shape (shift: 15° steps)
//   scale (R)   boxes along the shape's own axes size that side, the other staying (alt: both
//               ways); the middle box sizes it all
//   slot (T)    rings are the part's slots (click one to select it); dots on its shapes' faces
//               put the selected slot there, or a new one when none is selected
//   joint (J)   rings about the axes of the joints the part hangs by, their
//               ranges as arcs: drag one to try the joint (not saved; shift: 15° steps)
// In the assemble and animate tabs, markers on the model's root and IK targets: click one, then drag
// its arrows (and the root's rings) to move (turn) it, in the pose test or the selected key; drag
// an IK's pole round its ring to swivel the bend. In the animate tab, the shown motion's arcs: drag
// a point (or its arrows), double-click the curve to add one, Delete to remove the picked one.
// Shift snaps moves to 0.01 and sizes to 0.01. A drag is one undo step.
//
// Everything here is the page's: the engine only says where the part is ({"q": "parts"}) and
// its joints ({"q": "joints"}), where
// points show on the canvas ({"q": "project"}) and what is under the cursor ({"q": "pick"}).
import { hold, release } from "./dom.js";
import { ALONE_SCALE, editor } from "./editor.js";
import { add, apply, cross, euler, eulerFrom, fromQuat, mul, rotation, scale, transpose } from "./math3.js";
import { addSlot, faceCentre, FACE_NAMES, insertArcPoint, perpendicular, removeArcPoint, shapeFrame, shapeOnFace, snapSocket, socketFace, stackOn } from "./model.js";

/** @typedef {"move" | "rotate" | "scale" | "slot" | "joint"} Mode */
/** @type {{mode: Mode}} */
export const gizmo = { mode: "move" };

const SVG = "http://www.w3.org/2000/svg";
const COLORS = ["#e5675b", "#7fc35b", "#5b9be5"];
const LENGTH = 80; // pixels, the longest handle
const STEP = 0.01; // metres along an axis, to find where it points on screen

/** @type {SVGSVGElement} */
let svg;
let drags = 0;
let faceCache = { key: "", faces: /** @type {import("./model.js").Face[][]} */ ([]) };

/** @param {string} tag @param {Record<string, any>} attrs @param {Element} [parent] */
function el(tag, attrs, parent = svg) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent.append(e);
  return e;
}

/** a part's place in the world now: position (metres) and turn @param {string} name */
function frameOf(name) {
  const f = editor.viewer?.query({ q: "parts", parts: [name] })?.[name];
  return f ? { position: /** @type {number[]} */ (f.position), rotation: fromQuat(f.rotation) } : null;
}

/** where world points show on the canvas @param {number[][]} points @returns {(number[] | null)[]} */
function project(points) {
  return editor.viewer?.query({ q: "project", points })?.points ?? [];
}

const round = (/** @type {number} */ v, /** @type {number} */ step = 1e-4) => Math.round(v / step) * step;
const r5 = (/** @type {number} */ v) => Math.round(v * 1e5) / 1e5 || 0;

/**
 * startDrag runs a drag from a handle: `update` gets the pointer's offset from where it went down
 * (and the event) and edits the model; all of it is one undo step.
 * @param {PointerEvent} e @param {(d: number[], e: PointerEvent) => void} update
 */
function startDrag(e, update) {
  const key = `drag:gizmo${++drags}`;
  follow(e, (d, m) => editor.edit("model", () => update(d, m), key));
}

/**
 * follow runs `move` with the pointer's offset from where it went down until it is let go, then
 * `done`: a drag that edits nothing (trying a joint).
 * @param {PointerEvent} e @param {(d: number[], e: PointerEvent) => void} move @param {() => void} [done]
 */
function follow(e, move, done) {
  e.preventDefault();
  e.stopPropagation();
  const x0 = e.clientX;
  const y0 = e.clientY;
  hold();
  const step = (/** @type {PointerEvent} */ m) => move([m.clientX - x0, m.clientY - y0], m);
  const up = () => {
    window.removeEventListener("pointermove", step);
    window.removeEventListener("pointerup", up);
    release();
    done?.();
  };
  window.addEventListener("pointermove", step);
  window.addEventListener("pointerup", up);
}

/** @param {number[]} a @param {number[]} b */
const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];

/** a handle: a wide invisible stroke to grab, a visible one to see @param {string} d @param {string} color @param {(e: PointerEvent) => void} down @param {string} title */
function handlePath(d, color, down, title) {
  const g = el("g", { class: "handle" });
  el("path", { d, stroke: color, "stroke-width": 2.5, fill: "none" }, g);
  const hit = el("path", { d, stroke: "transparent", "stroke-width": 14, fill: "none", class: "hit" }, g);
  el("title", {}, hit).textContent = title;
  hit.addEventListener("pointerdown", (e) => down(/** @type {PointerEvent} */ (e)));
  return g;
}

/** a square handle @param {number[]} at @param {string} color @param {(e: PointerEvent) => void} down @param {string} title */
function handleBox(at, color, down, title) {
  const r = el("rect", { x: at[0] - 6, y: at[1] - 6, width: 12, height: 12, fill: color, class: "hit" });
  el("title", {}, r).textContent = title;
  r.addEventListener("pointerdown", (e) => down(/** @type {PointerEvent} */ (e)));
}

function draw() {
  svg.replaceChildren();
  const m = editor.model;
  const part = m.parts?.[editor.def];
  if (editor.viewer && (editor.tab === "assemble" || editor.tab === "animation")) return drawHandles();
  if (editor.tab !== "model" || !part || !editor.viewer || editor.explode > 0) return;
  // the model tab shows the part alone, in model units (editor.alone)
  const s = ALONE_SCALE;
  if (gizmo.mode === "slot") return drawSlots(part, s);
  if (gizmo.mode === "joint") return drawJoints(part, s);
  const shape = part.shapes?.[editor.shape];
  const f = frameOf(part.name);
  if (!shape || !f) return;
  // the shape sits in its frame: a stretched one's halfway up the part (shapeFrame)
  const span = shapeFrame(part, shape);
  const back = transpose(span.rotation);
  const centre = add(f.position, apply(f.rotation, scale(add(span.position, apply(span.rotation, shape.position ?? [0, 0, 0])), s)));
  // move and rotate go by the part's axes, scale by the shape's own
  const axes = gizmo.mode === "scale" ? mul(f.rotation, mul(span.rotation, euler(shape.rotation))) : f.rotation;
  const dirs = [0, 1, 2].map((k) => [axes[k], axes[3 + k], axes[6 + k]]);
  // a short step along each axis: the view is flat across it even close up in perspective
  const pts = project([centre, ...dirs.map((d) => add(centre, scale(d, STEP)))]);
  if (pts.length < 4 || pts.some((p) => !p)) return;
  const c = /** @type {number[]} */ (pts[0]);
  // each axis on screen, per world unit
  const v = pts.slice(1).map((p) => [(/** @type {number[]} */ (p)[0] - c[0]) / STEP, (/** @type {number[]} */ (p)[1] - c[1]) / STEP]);
  const k = LENGTH / (Math.max(...v.map((x) => Math.hypot(x[0], x[1]))) || 1);
  const at = (/** @type {number[]} */ x, /** @type {number} */ t = 1) => [c[0] + x[0] * k * t, c[1] + x[1] * k * t];
  /** world units along screen vector vv for a pointer offset d @param {number[]} vv @param {number[]} d */
  const along = (vv, d) => dot2(d, vv) / (dot2(vv, vv) || 1);

  if (gizmo.mode === "move") {
    // the other selected shapes, each in its span's frame, where it is in the part's
    const others = editor.selectedShapes().slice(1).map((k) => {
      const o = part.shapes[k];
      const frame = shapeFrame(part, o);
      return { shape: o, span: frame, p0: centreOf(o, frame) };
    });
    // the other shapes' faces: click one to stack the shape on it, shift-click to only close the
    // gap, alt-click to add a box on it
    const faces = partFaces(part);
    faceDots(f, s, faces, {
      skip: editor.shape,
      title: (k, n) => `stack the shape on the ${FACE_NAMES[n]} face of shape ${k + 1} (shift: close the gap only; alt: a new box on it)`,
      down: (e, k, n) => {
        const target = faces[k][n];
        if (e.altKey) {
          const on = part.shapes[k];
          const frame = shapeFrame(part, on);
          editor.edit("model", () => {
            part.shapes.push(shapeOnFace(on, n, target, frame));
            editor.shape = part.shapes.length - 1;
          });
        } else if (faces[editor.shape]) {
          const before = centreOf(shape, span);
          editor.edit("model", () => {
            stackOn(shape, faces[editor.shape], target, span, e.shiftKey);
            // the others selected move with it
            const by = centreOf(shape, span).map((c, k) => c - before[k]);
            for (const o of others) o.shape.position = apply(transpose(o.span.rotation), add(o.p0, by).map((c, k) => c - o.span.position[k])).map(r5);
          });
        }
      },
    });
    v.forEach((vv, i) => {
      const end = at(vv);
      handlePath(`M${c[0]},${c[1]}L${end[0]},${end[1]}`, COLORS[i], (e) => {
        // along the part's axis i, in the span's frame
        const p0 = add(span.position, apply(span.rotation, shape.position ?? [0, 0, 0]));
        // its faces across axis i, from its centre, and the other shapes' planes there: it snaps
        // flush or level with them (shift: the 0.01 grid instead)
        const own = (faces[editor.shape] ?? []).filter((x) => Math.abs(x.normal[i]) > 0.999).map((x) => x.position[i] - p0[i]);
        const planes = faces.flatMap((list, k) => (k === editor.shape ? [] : list.filter((x) => Math.abs(x.normal[i]) > 0.999).map((x) => x.position[i])));
        const near = SNAP_PX / (Math.hypot(vv[0], vv[1]) || 1) / s;
        startDrag(e, (d, ev) => {
          const p = [...p0];
          p[i] = round(p0[i] + along(vv, d) / s, ev.shiftKey ? 0.01 : 1e-4);
          if (!ev.shiftKey) p[i] = snapTo(p[i], own, planes, near);
          shape.position = apply(back, p.map((c, k) => c - span.position[k])).map(r5);
          // the others selected move by as much
          for (const o of others) {
            const q = [...o.p0];
            q[i] += p[i] - p0[i];
            o.shape.position = apply(transpose(o.span.rotation), q.map((c, k) => c - o.span.position[k])).map(r5);
          }
        });
      }, `move along ${"xyz"[i]} (snaps to the other shapes' faces; shift: 0.01 steps)`);
      el("circle", { cx: end[0], cy: end[1], r: 5, fill: COLORS[i], "pointer-events": "none" });
    });
  } else if (gizmo.mode === "scale") {
    v.forEach((vv, i) => {
      const end = at(vv);
      el("path", { d: `M${c[0]},${c[1]}L${end[0]},${end[1]}`, stroke: COLORS[i], "stroke-width": 2, "pointer-events": "none" });
      handleBox(end, COLORS[i], (e) => {
        const s0 = [...(shape.size ?? [0.2, 0.2, 0.2])];
        // a stretched one's length adds to y: the shape stays at least 0.005 long all told
        const least = 0.005 - (i === 1 ? span.length : 0);
        const p0 = [...(shape.position ?? [0, 0, 0])];
        // the shape's axis i in its span's frame: the side that grows
        const own = euler(shape.rotation);
        const axis = [own[i], own[3 + i], own[6 + i]];
        startDrag(e, (d, ev) => {
          const size = [...s0];
          // that side only, the other face staying put; alt: both ways from the centre
          size[i] = Math.max(least, round(s0[i] + ((ev.altKey ? 2 : 1) * along(vv, d)) / s, ev.shiftKey ? 0.01 : 1e-4));
          shape.size = size.map(r5);
          const grow = ev.altKey ? 0 : (size[i] - s0[i]) / 2;
          shape.position = p0.map((c, k) => r5(c + axis[k] * grow));
        });
      }, `size the shape's +${"xyz"[i]} side (alt: both ways)`);
    });
    handleBox(c, "#d8dce4", (e) => {
      // every selected shape, about their middle: sizes and places scale together
      const all = editor.selectedShapes().map((k) => {
        const o = part.shapes[k];
        const frame = shapeFrame(part, o);
        return { shape: o, span: frame, size: [...(o.size ?? [0.2, 0.2, 0.2])], at: centreOf(o, frame) };
      });
      const middle = all.reduce((m, o) => add(m, scale(o.at, 1 / all.length)), [0, 0, 0]);
      startDrag(e, (d, ev) => {
        const f = Math.max(0.05, 1 + (d[0] - d[1]) / 150);
        for (const o of all) {
          // the whole extent scales, a stretched one's length included
          const length = o.size.map((_, k) => (k === 1 ? o.span.length : 0));
          o.shape.size = o.size.map((x, k) => r5(Math.max(0.005, round((x + length[k]) * f, ev.shiftKey ? 0.01 : 1e-4)) - length[k]));
          if (all.length > 1) {
            const at = add(middle, scale(o.at.map((c, k) => c - middle[k]), f));
            o.shape.position = apply(transpose(o.span.rotation), at.map((c, k) => c - o.span.position[k])).map(r5);
          }
        }
      });
    }, "size it all (drag right or up); with several shapes selected, all of them about their middle");
  } else {
    v.forEach((_, i) => {
      const u = v[(i + 1) % 3];
      const w = v[(i + 2) % 3];
      const ring = [];
      for (let n = 0; n <= 48; n++) {
        const t = (n / 48) * 2 * Math.PI;
        const p = at([Math.cos(t) * u[0] + Math.sin(t) * w[0], Math.cos(t) * u[1] + Math.sin(t) * w[1]], 0.85);
        ring.push(`${n ? "L" : "M"}${p[0]},${p[1]}`);
      }
      handlePath(ring.join(""), COLORS[i], (e) => {
        const r0 = euler(shape.rotation);
        // a turn about axis i takes u toward w; on screen that is this way round
        const sign = Math.sign(u[0] * w[1] - u[1] * w[0]) || 1;
        const box = svg.getBoundingClientRect();
        const angle = (/** @type {number} */ x, /** @type {number} */ y) => Math.atan2(y - box.top - c[1], x - box.left - c[0]);
        const a0 = angle(e.clientX, e.clientY);
        let turned = 0;
        let last = a0;
        startDrag(e, (d, ev) => {
          const a = angle(e.clientX + d[0], e.clientY + d[1]);
          let step = a - last;
          step -= Math.round(step / (2 * Math.PI)) * 2 * Math.PI;
          turned += step;
          last = a;
          const theta = ev.shiftKey ? Math.round((sign * turned) / (Math.PI / 12)) * (Math.PI / 12) : sign * turned;
          // about the part's axis i: in the span's frame, Rᵀ · turn · R
          shape.rotation = eulerFrom(mul(back, mul(rotation(i, theta), mul(span.rotation, r0)))).map(r5);
        });
      }, `turn about ${"xyz"[i]} (shift: 15° steps)`);
    });
  }
}

/** the faces of each of a part's shapes (the "faces" query), asked again only when the part changes @param {any} part */
function partFaces(part) {
  const key = `${part.name}:${JSON.stringify(part.shapes)}:${JSON.stringify(part.slots)}`;
  if (faceCache.key !== key) faceCache = { key, faces: editor.faces(part.name) };
  return faceCache.faces;
}

/**
 * faceDots draws a dot on each face of the part's shapes that faces the camera (and on any `lit`
 * one), but those of shape `skip`.
 * @param {{position: number[], rotation: number[]}} f the part's place @param {number} s
 * @param {import("./model.js").Face[][]} faces
 * @param {{skip?: number, lit?: (k: number, n: number) => boolean, title: (k: number, n: number) => string, down: (e: PointerEvent, k: number, n: number) => void}} o
 */
function faceDots(f, s, faces, o) {
  const world = (/** @type {number[]} */ p) => add(f.position, apply(f.rotation, scale(p, s)));
  const flat = faces.flatMap((list, k) => (k === o.skip ? [] : list.map((face, n) => ({ k, n, face }))));
  // each face's point and two along it: wound one way on screen when it faces the camera
  const pts = project(
    flat.flatMap(({ face }) => {
      const t1 = perpendicular(face.normal);
      const t2 = cross(face.normal, t1);
      return [face.position, add(face.position, scale(t1, 0.05)), add(face.position, scale(t2, 0.05))].map(world);
    }),
  );
  flat.forEach(({ k, n }, i) => {
    const [p, a, b] = pts.slice(i * 3, 3 + i * 3);
    if (!p || !a || !b) return;
    const lit = o.lit?.(k, n) ?? false;
    const facing = (a[0] - p[0]) * (b[1] - p[1]) - (a[1] - p[1]) * (b[0] - p[0]) < 0;
    if (!facing && !lit) return;
    const dot = el("circle", { cx: p[0], cy: p[1], r: lit ? 7 : 5, fill: lit ? "#6cb6ff" : "rgba(216,220,228,0.85)", stroke: "#121418", "stroke-width": 1.5, class: "hit" });
    el("title", {}, dot).textContent = o.title(k, n);
    dot.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      o.down(/** @type {PointerEvent} */ (e), k, n);
    });
  });
}

/**
 * drawSlots: a ring on each of the part's slots (the selected one lit; click to select), and a
 * dot on each face of its shapes that faces the camera: click one to put the selected slot there,
 * or a new slot when none is selected.
 * @param {any} part @param {number} s
 */
function drawSlots(part, s) {
  const f = frameOf(part.name);
  if (!f) return;
  const faces = partFaces(part);
  const slots = part.slots ?? [];
  const slot = slots[editor.slot];
  const world = (/** @type {number[]} */ p) => add(f.position, apply(f.rotation, scale(p, s)));
  const on = slot ? faces.map((list) => socketFace(slot, list)) : [];
  faceDots(f, s, faces, {
    lit: (k, n) => on[k] === n,
    title: (k, n) => (slot ? `put slot ${slot.name} on the ${FACE_NAMES[n]} face of shape ${k + 1}` : `add a slot on the ${FACE_NAMES[n]} face of shape ${k + 1}`),
    down: (_, k, n) =>
      editor.edit("model", () => {
        const face = faces[k][n];
        if (slot) Object.assign(slot, snapSocket(slot, face, faceCentre(faces[k])));
        else {
          addSlot(part, "slot", snapSocket(undefined, face, faceCentre(faces[k])));
          editor.slot = part.slots.length - 1;
        }
      }),
  });
  // the origin, the default slot (dashed), and where the part hangs, its length above, joined
  const [o, top] = project([world([0, 0, 0]), world([0, part.length ?? 0, 0])]);
  if (o && top && part.length) el("line", { x1: o[0], y1: o[1], x2: top[0], y2: top[1], stroke: "#e5b45b", "stroke-width": 1.5, "stroke-dasharray": "4 3", opacity: 0.7 });
  if (o) el("title", {}, el("circle", { cx: o[0], cy: o[1], r: 9, fill: "transparent", stroke: "#e5b45b", "stroke-width": 2, "stroke-dasharray": "3 3" })).textContent = "the origin: the default slot, where the next link of a chain is matched";
  if (top && part.length) el("title", {}, el("rect", { x: top[0] - 5, y: top[1] - 5, width: 10, height: 10, fill: "transparent", stroke: "#e5b45b", "stroke-width": 2 })).textContent = `where the part hangs, its length (${part.length}) above its origin`;
  const pts = project(slots.map((/** @type {any} */ x) => world(x.position ?? [0, 0, 0])));
  slots.forEach((/** @type {any} */ x, /** @type {number} */ i) => {
    const sp = pts[i];
    if (!sp) return;
    const lit = i === editor.slot;
    const ring = el("circle", { cx: sp[0], cy: sp[1], r: 9, fill: "transparent", stroke: lit ? "#6cb6ff" : "#e5b45b", "stroke-width": lit ? 2.5 : 2, class: "hit" });
    el("title", {}, ring).textContent = `slot ${x.name}${x.mirror ? ` (mirrored across ${x.mirror.toLowerCase()} = 0)` : ""}`;
    ring.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      editor.select(() => (editor.slot = lit ? -1 : i));
    });
    // a mirrored slot's other side (mech.Slot.mirror), reflected across its plane: dashed, as the
    // engine makes it; it moves with the slot as written
    if (!x.mirror) return;
    const k = "XYZ".indexOf(x.mirror);
    const [rp] = project([world((x.position ?? [0, 0, 0]).map((/** @type {number} */ c, /** @type {number} */ n) => (n === k ? -c : c)))]);
    if (!rp) return;
    el("line", { x1: sp[0], y1: sp[1], x2: rp[0], y2: rp[1], stroke: "#e5b45b", "stroke-width": 1, "stroke-dasharray": "2 4", opacity: 0.5 });
    el("title", {}, el("circle", { cx: rp[0], cy: rp[1], r: 9, fill: "transparent", stroke: lit ? "#6cb6ff" : "#e5b45b", "stroke-width": 1.5, "stroke-dasharray": "3 3" })).textContent = `slot ${x.name}, its other side: reflected across ${x.mirror.toLowerCase()} = 0`;
  });
}

/**
 * drawJoints: at each pivot of the joints the part hangs by, a ring per axis it turns about, its
 * range as an arc and where it is now as a spoke; a linear actuator's, an arrow out along its
 * stroke. Click one to select the joint; drag it to try the joint (shift: 15° steps, 0.01
 * slides), held in its range. Trying is never saved.
 * @param {any} part @param {number} s
 */
function drawJoints(part, s) {
  const joints = editor.viewer?.query({ q: "joints", part: part.name })?.joints ?? [];
  const R = 0.55; // of LENGTH, a ring's radius on screen
  for (const j of joints) {
    const rot = fromQuat(j.rotation);
    const dirs = [0, 1, 2].map((k) => [rot[k], rot[3 + k], rot[6 + k]]);
    const pts = project([j.pivot, ...dirs.map((d) => add(j.pivot, scale(d, STEP)))]);
    if (pts.length < 4 || pts.some((p) => !p)) continue;
    const c = /** @type {number[]} */ (pts[0]);
    const v = pts.slice(1).map((p) => [(/** @type {number[]} */ (p)[0] - c[0]) / STEP, (/** @type {number[]} */ (p)[1] - c[1]) / STEP]);
    const k = (LENGTH * R) / (Math.max(...v.map((x) => Math.hypot(x[0], x[1]))) || 1);
    const lit = editor.joint === j.index;
    const pick = () => editor.select(() => (editor.joint = j.index));
    for (const [n, a] of j.axes.entries()) {
      const i = "XYZ".indexOf(a);
      const lo = j.min[i];
      const hi = j.max[i];
      const now = j.at[i];
      // the ring about axis i: angle θ is cos θ · u + sin θ · w, a turn taking u toward w
      const u = v[(i + 1) % 3];
      const w = v[(i + 2) % 3];
      const ring = (/** @type {number} */ t) => [c[0] + (Math.cos(t) * u[0] + Math.sin(t) * w[0]) * k, c[1] + (Math.cos(t) * u[1] + Math.sin(t) * w[1]) * k];
      const arc = (/** @type {number} */ t0, /** @type {number} */ t1, /** @type {number} */ n = 48) =>
        Array.from({ length: n + 1 }, (_, m) => ring(t0 + ((t1 - t0) * m) / n)).map((p, m) => `${m ? "L" : "M"}${p[0]},${p[1]}`).join("");
      const g = handlePath(arc(0, 2 * Math.PI), COLORS[i], (e) => {
        pick();
        const sign = Math.sign(u[0] * w[1] - u[1] * w[0]) || 1;
        const box = svg.getBoundingClientRect();
        const angle = (/** @type {number} */ x, /** @type {number} */ y) => Math.atan2(y - box.top - c[1], x - box.left - c[0]);
        let last = angle(e.clientX, e.clientY);
        let turned = 0;
        follow(e, (d, ev) => {
          const at = angle(e.clientX + d[0], e.clientY + d[1]);
          let step = at - last;
          step -= Math.round(step / (2 * Math.PI)) * 2 * Math.PI;
          turned += step;
          last = at;
          const t = clampTo(now + sign * turned, lo, hi);
          const snapped = ev.shiftKey ? Math.round(t / (Math.PI / 12)) * (Math.PI / 12) : t;
          // a ball's channel is its three turns, a hinge's its one
          if (j.axes.length === 3) {
            const all = [...j.at];
            all[i] = snapped;
            editor.setTry(j.channel, all);
          } else editor.setTry(j.channel, snapped);
        }, () => editor.emit("select"));
      }, `turn ${j.name} about ${a} (drag to try it)`);
      if (!lit) g.setAttribute("opacity", "0.6");
      // its range, and where it is
      if (lo !== hi) el("path", { d: arc(lo, hi), stroke: COLORS[i], "stroke-width": 6, "stroke-opacity": 0.35, fill: "none", "pointer-events": "none" });
      const tip = ring(now);
      el("path", { d: `M${c[0]},${c[1]}L${tip[0]},${tip[1]}`, stroke: COLORS[i], "stroke-width": 1.5, "pointer-events": "none" });
    }
    if (j.kind === "LINEAR") {
      // out along its -y, as far as its stroke goes (or a handle's length)
      const out = [-v[1][0], -v[1][1]];
      const len = Math.hypot(out[0], out[1]) || 1;
      const reach = Math.max(j.stroke[1] * s * len, LENGTH * R);
      const end = [c[0] + (out[0] / len) * reach, c[1] + (out[1] / len) * reach];
      const g = handlePath(`M${c[0]},${c[1]}L${end[0]},${end[1]}`, COLORS[1], (e) => {
        pick();
        const at = j.slide;
        follow(e, (d, ev) => {
          const by = dot2(d, out) / (dot2(out, out) || 1) / s;
          const x = clampTo(at + by, j.stroke[0], j.stroke[1]);
          editor.setTry(j.channel, ev.shiftKey ? Math.round(x * 100) / 100 : x);
        }, () => editor.emit("select"));
      }, `slide ${j.name} out (drag to try it)`);
      if (!lit) g.setAttribute("opacity", "0.6");
    }
    const dot = el("circle", { cx: c[0], cy: c[1], r: lit ? 6 : 4, fill: lit ? "#6cb6ff" : "#d8dce4", stroke: "#121418", "stroke-width": 1.5, class: "hit" });
    el("title", {}, dot).textContent = `joint ${j.name}`;
    dot.addEventListener("pointerdown", (e) => (e.stopPropagation(), pick()));
  }
}

/**
 * drawHandles (assemble and animate tabs): a marker on the model's root and on each IK target, and its
 * pole. Click one to select it: arrows move it along the model's axes (its position channel), and
 * the root's rings turn it (its rotation); drag a pole round its ring to swivel the bend. They set
 * the pose test (assemble), the picked move (animate).
 */
function drawHandles() {
  const a = editor.viewer?.query({ q: "handles" });
  if (!a || a.error) return;
  const root = editor.rootChannels();
  const s = a.scale;
  if (editor.tab === "animation") drawArcs(s);
  /** @type {any[]} */
  const iks = editor.ikShow === "hidden" ? [] : a.iks;
  // a pole's ring: where its swivel can take it, faint, while its target is picked or it is dragged
  for (const ik of iks) {
    if (!ik.ring || (editor.handle !== ik.name && poleDrag?.name !== ik.name)) continue;
    const ring = project(ik.ring);
    if (ring.some((p) => !p)) continue;
    el("path", { d: ring.map((p, n) => `${n ? "L" : "M"}${p?.[0]},${p?.[1]}`).join("") + "Z", stroke: "rgba(229,180,91,0.45)", "stroke-width": 1.5, "stroke-dasharray": "3 3", fill: "none", "pointer-events": "none" });
  }
  /** @type {{id: string, position: number[], move: string, turn?: string, ik?: any}[]} */
  const handles = [
    { id: "root", position: a.root.position, move: root.move, turn: root.turn },
    ...iks.map((/** @type {any} */ ik) => ({ id: ik.name, position: ik.position, move: ik.name })),
    // a pole: the point its chain bends toward, which the engine works out (mech.ik_pole) and its
    // swivel turns: drag it round its ring
    ...iks.filter((/** @type {any} */ ik) => ik.pole).map((/** @type {any} */ ik) => ({ id: `${ik.name} pole`, position: ik.pole, move: "", ik })),
  ];
  const at = project(handles.map((x) => x.position));
  handles.forEach((x, n) => {
    const p = at[n];
    if (!p) return;
    const lit = editor.handle === x.id;
    const pole = x.id.endsWith(" pole");
    const marker =
      x.id === "root"
        ? el("rect", { x: p[0] - 7, y: p[1] - 7, width: 14, height: 14, transform: `rotate(45 ${p[0]} ${p[1]})`, fill: lit ? "#6cb6ff" : "rgba(216,220,228,0.85)", stroke: "#121418", "stroke-width": 1.5, class: "hit" })
        : pole
          ? el("circle", { cx: p[0], cy: p[1], r: poleDrag?.name === x.ik?.name ? 7 : 5, fill: "rgba(18,20,24,0.6)", stroke: "rgba(229,180,91,0.85)", "stroke-width": 2, class: "hit" })
          : el("circle", { cx: p[0], cy: p[1], r: lit ? 8 : 6, fill: lit ? "#6cb6ff" : "rgba(229,180,91,0.9)", stroke: "#121418", "stroke-width": 1.5, class: "hit" });
    el("title", {}, marker).textContent = x.id === "root" ? "the root: click to move and turn the whole model" : pole ? `${x.id}: the point the chain bends toward, worked out from how it is built; drag it round the limb to swivel the bend (${x.ik.name}.swivel, ${+x.ik.swivel.toFixed(3)} rad; shift: 15° steps)` : `IK target ${x.id}: click to move it`;
    if (pole) marker.addEventListener("pointerdown", (e) => swivelDrag(/** @type {PointerEvent} */ (e), x.ik));
    else marker.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      editor.select(() => (editor.handle = lit ? "" : x.id));
    });
    if (editor.ikShow === "label" && x.id !== "root") {
      const t = el("text", { x: p[0] + 10, y: p[1] - 8, fill: pole ? "rgba(229,180,91,0.9)" : "#d8dce4", stroke: "#121418", "stroke-width": 3, "paint-order": "stroke", "font-size": 11, "pointer-events": "none" });
      t.textContent = x.id;
    }
    if (lit) handleTools(x, s);
  });
}

/** the pole being dragged round its ring @type {{name: string} | undefined} */
let poleDrag;

/**
 * swivelDrag turns IK target `ik`'s swivel as its pole is dragged: the pole follows the pointer
 * round its ring (the engine's: the pole at every swivel, a turn from where it was), to the point
 * of the ring nearest the pointer on screen. One undo step.
 * @param {PointerEvent} e @param {any} ik {name, swivel, ring}
 */
function swivelDrag(e, ik) {
  const ring = project(ik.ring);
  if (ring.some((p) => !p)) return;
  const pts = /** @type {number[][]} */ (ring);
  const n = pts.length;
  const box = svg.getBoundingClientRect();
  const s0 = ik.swivel;
  const name = `${ik.name}.swivel`;
  const key = `drag:swivel${++drags}`;
  poleDrag = { name: ik.name };
  follow(e, (_, ev) => {
    const q = [ev.clientX - box.left, ev.clientY - box.top];
    // the nearest point on the ring's segments: how far round it is, in parts of a turn
    let best = Infinity;
    let at = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const ab = [b[0] - a[0], b[1] - a[1]];
      const t = Math.min(1, Math.max(0, dot2([q[0] - a[0], q[1] - a[1]], ab) / (dot2(ab, ab) || 1)));
      const d = Math.hypot(a[0] + ab[0] * t - q[0], a[1] + ab[1] * t - q[1]);
      if (d < best) [best, at] = [d, (i + t) / n];
    }
    // the shorter way round from where it was
    let by = (at > 0.5 ? at - 1 : at) * 2 * Math.PI;
    if (ev.shiftKey) by = Math.round((s0 + by) / (Math.PI / 12)) * (Math.PI / 12) - s0;
    editor.setChannels({ [name]: r5(round(s0 + by)) }, key);
  }, () => ((poleDrag = undefined), editor.emit("select")));
}

/** an arc point's handle id: point `i` of arc `name` (Animation.arcs) @param {string} name @param {number} i */
export const arcHandle = (name, i) => `arc ${name} ${i}`;

/** the arc point picked in the view (editor.handle): its arc's name and the point, or null @returns {{name: string, i: number} | null} */
export function pickedArcPoint() {
  const m = /^arc (\S+) (\d+)$/.exec(editor.handle);
  return m ? { name: m[1], i: Number(m[2]) } : null;
}

/** the arc of the animation named `name` @param {string} name @returns {any} */
const arcNamed = (name) => editor.anim?.arcs?.find((/** @type {any} */ x) => x.name === name);

/**
 * drawArcs (animate tab): the arcs the shown motion's moves put positions on (mech.Arc), each the
 * curve the engine samples through its points, with a dot per point; a twin's (the other side's,
 * mirrored) dashed. Click one to edit it (editor.arc): the arc edited is drawn where the motion
 * puts it, else on its preview position (editor.arcOn, the "arc" query), numbered. Drag a dot to
 * move its point across the view (it picks it too; click a picked one to let it go); the picked
 * one's arrows move it along the model's axes. Double-click its curve to add a point there; Delete
 * removes the picked one (removeArcPoint). Every move naming the arc follows it.
 * @param {number} s metres per model unit
 */
function drawArcs(s) {
  const clip = editor.clipData;
  const mo = clip?.motions?.[editor.motion];
  const lanes = mo ? (editor.ask({ q: "motion", clip: clip.name, motion: editor.motion, n: 2 })?.moves ?? []) : [];
  /** @type {any} the edited arc as drawn, where the motion shown puts it, else on its preview position */
  let edited = null;
  for (const lane of lanes)
    for (const [own, l] of /** @type {[boolean, any][]} */ ([[true, lane], [false, lane.twin]]))
      for (const a of l?.arcs ?? []) {
        if (own && a.arc === editor.arc && !edited) {
          edited = a;
          continue;
        }
        arcCurve(a, own ? "none" : "4 4", 0.6);
      }
  if (editor.arc && !edited && arcNamed(editor.arc)) edited = editor.ask({ q: "arc", arc: editor.arc, on: editor.arcOn });
  if (edited && !edited.error) editArc(edited, s);
}

/**
 * arcCurve draws arc `a` (as the queries give it) to pick: click its curve or a dot to edit it.
 * @param {any} a @param {string} dash @param {number} alpha
 */
function arcCurve(a, dash, alpha) {
  const curve = project(a.curve);
  let d = "";
  curve.forEach((p, n) => p && (d += `${n && curve[n - 1] ? "L" : "M"}${p[0]},${p[1]}`));
  const pick = (/** @type {Event} */ e) => (e.stopPropagation(), editor.select(() => ((editor.arc = a.arc), (editor.arcOn = a.name), (editor.inspect = "arc"))));
  const hit = handlePath(d, `rgba(229,180,91,${alpha})`, (e) => pick(e), `arc ${a.arc} (on ${a.name}): click to edit it`);
  hit.firstElementChild?.setAttribute("stroke-dasharray", dash);
  for (const p of project(a.points)) if (p) el("circle", { cx: p[0], cy: p[1], r: 3, fill: `rgba(229,180,91,${alpha})`, "pointer-events": "none" });
  return curve;
}

/**
 * editArc draws the arc edited (`a`: as the queries give it) with its points to drag.
 * @param {any} a @param {number} s
 */
function editArc(a, s) {
  const arc = arcNamed(a.arc);
  if (!arc) return;
  const points = arc.points;
  const curve = project(a.curve);
  let d = "";
  curve.forEach((p, n) => p && (d += `${n && curve[n - 1] ? "L" : "M"}${p[0]},${p[1]}`));
  el("path", { d, stroke: "rgba(229,180,91,0.95)", "stroke-width": 2.5, fill: "none", "pointer-events": "none" });
  // the curve, wide, to double-click: a point added at the sample nearest the pointer, as an
  // offset like the others (the points drawn are where they put the position: rest + offset)
  const hit = el("path", { d, stroke: "transparent", "stroke-width": 12, fill: "none", class: "hit" });
  el("title", {}, hit).textContent = `arc ${a.arc} (on ${a.name}): double-click to add a point here`;
  hit.addEventListener("pointerdown", (e) => {
    const ev = /** @type {PointerEvent} */ (e);
    ev.stopPropagation();
    const box = svg.getBoundingClientRect();
    const q = [ev.clientX - box.left, ev.clientY - box.top];
    const again = lastCurveDown && lastCurveDown.id === a.arc && performance.now() - lastCurveDown.at < 400 && Math.hypot(q[0] - lastCurveDown.q[0], q[1] - lastCurveDown.q[1]) < 6;
    lastCurveDown = again ? undefined : { id: a.arc, at: performance.now(), q };
    if (!again) return;
    let n = 0;
    curve.forEach((p, m) => p && Math.hypot(p[0] - q[0], p[1] - q[1]) < Math.hypot((curve[n]?.[0] ?? Infinity) - q[0], (curve[n]?.[1] ?? Infinity) - q[1]) && (n = m));
    const u = n / Math.max(curve.length - 1, 1);
    const after = Math.min(Math.floor(u * (points.length - 1)), points.length - 2);
    const rest = a.points[0].map((/** @type {number} */ x, /** @type {number} */ c) => x - points[0][c] * s);
    const at = a.curve[n].map((/** @type {number} */ x, /** @type {number} */ c) => r5(round((x - rest[c]) / s)));
    editor.edit("anim", () => {
      if (insertArcPoint(editor.anim, arc, after, at)) editor.flash("Motions whose shape other moves follow too keep their shape: check their timing on the arc");
      editor.handle = arcHandle(a.arc, after + 1);
    });
  });
  const pts = project(a.points);
  pts.forEach((p, i) => {
    if (!p) return;
    const id = arcHandle(a.arc, i);
    const lit = editor.handle === id;
    const dot = el("circle", { cx: p[0], cy: p[1], r: lit ? 7 : 5, fill: lit ? "#6cb6ff" : "#121418", stroke: "rgba(229,180,91,0.95)", "stroke-width": 2, class: "hit" });
    el("title", {}, dot).textContent = `arc ${a.arc}, point ${i + 1} of ${pts.length} (at ${+(i / Math.max(pts.length - 1, 1)).toFixed(3)} on a shape): drag to move it across the view (shift: 0.01 steps), Delete to remove it`;
    dot.addEventListener("pointerdown", (e) => {
      const point = points[i];
      const axes = screenAxes(a.points[i]);
      if (!point || !axes) return;
      if (!lit) editor.select(() => (editor.handle = id));
      const base = [...point];
      const key = `drag:arc${++drags}`;
      let moved = false;
      follow(
        /** @type {PointerEvent} */ (e),
        (d, ev) => {
          if (!moved && Math.hypot(d[0], d[1]) < 3) return;
          moved = true;
          const by = unproject(axes.v, d);
          editor.edit("anim", () => by.forEach((b, c) => (point[c] = r5(round(base[c] + b / s, ev.shiftKey ? 0.01 : 1e-4)))), key);
        },
        () => (!moved && lit ? editor.select(() => (editor.handle = "")) : editor.emit("select")),
      );
    });
    const t = el("text", { x: p[0] + 8, y: p[1] + 14, fill: "rgba(229,180,91,0.95)", stroke: "#121418", "stroke-width": 3, "paint-order": "stroke", "font-size": 10, "pointer-events": "none" });
    t.textContent = String(i + 1);
    if (!lit) return;
    const key = `drag:arc${++drags}`;
    handleTools(
      {
        id,
        position: a.points[i],
        move: "",
        drag: (axis, by, ev) => {
          const point = points[i];
          if (!point) return;
          const base = (drag0 ??= [...point]);
          editor.edit("anim", () => (point[axis] = r5(round(base[axis] + by, ev.shiftKey ? 0.01 : 1e-4))), key);
        },
        done: () => (drag0 = undefined),
      },
      s,
    );
  });
}

/** an arc point as its drag started @type {number[] | undefined} */
let drag0;

/** the last press on an arc's curve, to tell a double-click (the view is redrawn every frame, so the browser's dblclick can't) @type {{id: string, at: number, q: number[]} | undefined} */
let lastCurveDown;

/**
 * removePickedArcPoint removes the arc point picked in the view (editor.handle), if one is and its
 * arc keeps two. Returns whether one was picked (the Delete key's, before the curve editor's).
 * @returns {boolean}
 */
export function removePickedArcPoint() {
  const p = pickedArcPoint();
  const arc = p && arcNamed(p.name);
  if (!p || !arc) return false;
  if (arc.points.length <= 2) {
    editor.flash("An arc keeps two points: delete the arc in the Arcs list");
    return true;
  }
  editor.edit("anim", () => {
    if (removeArcPoint(editor.anim, arc, p.i)) editor.handle = arcHandle(p.name, Math.max(p.i - 1, 0));
  });
  return true;
}

/**
 * screenAxes: where `position` (metres) shows on the canvas, `c`, and how far each of the model's
 * axes goes on screen per metre there, `v`; null when it is off screen.
 * @param {number[]} position @returns {{c: number[], v: number[][]} | null}
 */
function screenAxes(position) {
  const pts = project([position, ...[0, 1, 2].map((k) => add(position, scale(IDENTITY_AXES[k], STEP)))]);
  if (pts.length < 4 || pts.some((p) => !p)) return null;
  const c = /** @type {number[]} */ (pts[0]);
  return { c, v: pts.slice(1).map((p) => [(/** @type {number[]} */ (p)[0] - c[0]) / STEP, (/** @type {number[]} */ (p)[1] - c[1]) / STEP]) };
}

/**
 * unproject is the shortest move (metres along the model's axes) that shows as screen offset `d`,
 * the axes showing as `v` per metre: across the view, its depth kept (v's pseudo-inverse).
 * @param {number[][]} v @param {number[]} d @returns {number[]}
 */
function unproject(v, d) {
  let a = 0, b = 0, c = 0;
  for (const q of v) (a += q[0] * q[0]), (b += q[0] * q[1]), (c += q[1] * q[1]);
  const det = a * c - b * b;
  if (Math.abs(det) < 1e-9) return [0, 0, 0];
  const w = [(c * d[0] - b * d[1]) / det, (a * d[1] - b * d[0]) / det];
  return v.map((q) => dot2(q, w));
}

/**
 * handleTools: the selected handle's arrows (and the root's rings), along and about the model's
 * axes, at `x.position`. `s`: metres per model unit. They set its channels (`move`, `turn`), or,
 * given `drag`, call it with the axis and how far along it (model units) the drag has gone.
 * @param {{id: string, position: number[], move: string, turn?: string, drag?: (axis: number, by: number, e: PointerEvent) => void, done?: () => void}} x @param {number} s
 */
function handleTools(x, s) {
  const axes = screenAxes(x.position);
  if (!axes) return;
  const { c, v } = axes;
  const k = LENGTH / (Math.max(...v.map((q) => Math.hypot(q[0], q[1]))) || 1);
  const key = `drag:handle${++drags}`;
  v.forEach((vv, i) => {
    const end = [c[0] + vv[0] * k, c[1] + vv[1] * k];
    handlePath(`M${c[0]},${c[1]}L${end[0]},${end[1]}`, COLORS[i], (e) => {
      if (x.drag) {
        const drag = x.drag;
        follow(e, (d, ev) => drag(i, dot2(d, vv) / (dot2(vv, vv) || 1) / s, ev), () => (x.done?.(), editor.emit("select")));
        return;
      }
      // a position moves whole: this axis of it
      const name = x.move;
      const v0 = /** @type {number[]} */ (editor.shown()[name] ?? [0, 0, 0]);
      follow(e, (d, ev) => {
        // world metres along the axis, to model units
        const by = dot2(d, vv) / (dot2(vv, vv) || 1) / s;
        const v = [...v0];
        v[i] = r5(round(v0[i] + by, ev.shiftKey ? 0.01 : 1e-4));
        editor.setChannels({ [name]: v }, key);
      }, () => editor.emit("select"));
    }, `move ${x.id} along ${"xyz"[i]} (shift: 0.01 steps)`);
    el("circle", { cx: end[0], cy: end[1], r: 5, fill: COLORS[i], "pointer-events": "none" });
  });
  const turn = x.turn;
  if (!turn) return;
  v.forEach((_, i) => {
    const u = v[(i + 1) % 3];
    const w = v[(i + 2) % 3];
    const ring = [];
    for (let n = 0; n <= 48; n++) {
      const t = (n / 48) * 2 * Math.PI;
      ring.push(`${n ? "L" : "M"}${c[0] + (Math.cos(t) * u[0] + Math.sin(t) * w[0]) * k * 0.7},${c[1] + (Math.cos(t) * u[1] + Math.sin(t) * w[1]) * k * 0.7}`);
    }
    handlePath(ring.join(""), COLORS[i], (e) => {
      const now = editor.shown();
      const r0 = euler(/** @type {number[]} */ (now[turn] ?? [0, 0, 0]));
      const sign = Math.sign(u[0] * w[1] - u[1] * w[0]) || 1;
      const box = svg.getBoundingClientRect();
      const angle = (/** @type {number} */ px, /** @type {number} */ py) => Math.atan2(py - box.top - c[1], px - box.left - c[0]);
      let last = angle(e.clientX, e.clientY);
      let turned = 0;
      follow(e, (d, ev) => {
        const a = angle(e.clientX + d[0], e.clientY + d[1]);
        let step = a - last;
        step -= Math.round(step / (2 * Math.PI)) * 2 * Math.PI;
        turned += step;
        last = a;
        const theta = ev.shiftKey ? Math.round((sign * turned) / (Math.PI / 12)) * (Math.PI / 12) : sign * turned;
        const r = eulerFrom(mul(rotation(i, theta), r0)).map(r5);
        editor.setChannels({ [turn]: r }, key);
      }, () => editor.emit("select"));
    }, `turn ${x.id} about ${"xyz"[i]} (shift: 15° steps)`);
  });
}

/** the model's axes, as the view's handles move along them */
const IDENTITY_AXES = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** where shape `o` is in its part's frame, `span` its span's frame @param {any} o @param {import("./model.js").SpanFrame} span */
const centreOf = (o, span) => add(span.position, apply(span.rotation, o.position ?? [0, 0, 0]));

/** how near, in pixels, a dragged face snaps to another shape's */
const SNAP_PX = 8;

/**
 * snapTo is centre coordinate `p` moved so one of its faces (`own`, offsets from the centre)
 * meets one of the `planes` within `near`, the nearest; p itself when none is that near.
 * @param {number} p @param {number[]} own @param {number[]} planes @param {number} near
 */
function snapTo(p, own, planes, near) {
  let best = p;
  let gap = near;
  for (const o of own)
    for (const q of planes)
      if (Math.abs(p + o - q) < gap) {
        gap = Math.abs(p + o - q);
        best = q - o;
      }
  return r5(best);
}

/** v held in lo..hi, unless they are equal (free) @param {number} v @param {number} lo @param {number} hi */
const clampTo = (v, lo, hi) => (lo === hi ? v : Math.min(hi, Math.max(lo, v)));

/** pickAt selects what is under a point of the canvas: a shape in the model tab (`add`: shift, to the selection), an instance in the assemble tab, and in the animate tab an instance, lit (empty space: none) @param {number} x @param {number} y @param {boolean} [add] */
function pickAt(x, y, add = false) {
  const hit = editor.viewer?.query({ q: "pick", x, y });
  if (editor.tab === "animation") return editor.select(() => (editor.part = hit && hit.part >= 0 ? hit.part : -1));
  if (!hit || hit.part < 0) return;
  if (editor.tab === "model") {
    if (hit.shape >= 0) editor.pickShape(hit.shape, add);
    return;
  }
  editor.select(() => {
    editor.part = hit.part;
    editor.inspect = "part";
  });
}

/** install puts the gizmo layer over the view and listens for picks. */
export function install() {
  const stage = /** @type {HTMLElement} */ (document.getElementById("stage"));
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("canvas"));
  svg = /** @type {SVGSVGElement} */ (document.createElementNS(SVG, "svg"));
  svg.id = "gizmo";
  stage.insertBefore(svg, document.getElementById("viewport-tools"));
  // a click (no drag) on the view picks; a drag orbits as before
  /** @type {{x: number, y: number} | null} */
  let down = null;
  canvas.addEventListener("pointerdown", (e) => (down = e.button === 0 ? { x: e.offsetX, y: e.offsetY } : null));
  canvas.addEventListener("pointerup", (e) => {
    if (down && Math.hypot(e.offsetX - down.x, e.offsetY - down.y) < 4) pickAt(e.offsetX, e.offsetY, e.shiftKey);
    down = null;
  });
  const tick = () => {
    draw();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** @param {Mode} mode */
export function setMode(mode) {
  gizmo.mode = mode;
}
