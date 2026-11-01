// @ts-check
// The view's direct manipulation. Click a piece to select it: its shape in the model tab, its
// instance in the assemble and rig tabs. In the model tab, drag handles drawn over the view to edit
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
// In the rig and animate tabs, markers on the model's root and IK targets: click one, then drag
// its arrows (and the root's rings) to move (turn) it, in the pose test or the selected key.
// Shift snaps moves to 0.01 and sizes to 0.01. A drag is one undo step.
//
// Everything here is the page's: the engine only says where the part is ({"q": "parts"}) and
// its joints ({"q": "joints"}), where
// points show on the canvas ({"q": "project"}) and what is under the cursor ({"q": "pick"}).
import { hold, release } from "./dom.js";
import { ALONE_SCALE, editor } from "./editor.js";
import { add, apply, cross, euler, eulerFrom, fromQuat, mul, rotation, scale, transpose } from "./math3.js";
import { addSlot, faceCentre, FACE_NAMES, perpendicular, shapeOnFace, snapSocket, socketFace, stackOn } from "./model.js";

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
  if (editor.viewer && (editor.tab === "rig" || editor.tab === "animation")) return drawHandles();
  // previewing the mirror shows the part as it is not written: nothing to drag
  if (editor.tab !== "model" || !part || !editor.viewer || editor.explode > 0 || editor.mirrored) return;
  // the model tab shows the part alone, in model units (editor.alone)
  const s = ALONE_SCALE;
  if (gizmo.mode === "slot") return drawSlots(part, s);
  if (gizmo.mode === "joint") return drawJoints(part, s);
  const shape = part.shapes?.[editor.shape];
  const f = frameOf(part.name);
  if (!shape || !f) return;
  // the shape sits in its span's frame (the part's, unspanned)
  const span = editor.spanFrame(part.name, shape.span);
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
      const frame = editor.spanFrame(part.name, o.span);
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
          const frame = editor.spanFrame(part.name, on.span);
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
        // a span's length adds to y: the shape stays at least 0.005 long all told
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
        const frame = editor.spanFrame(part.name, o.span);
        return { shape: o, span: frame, size: [...(o.size ?? [0.2, 0.2, 0.2])], at: centreOf(o, frame) };
      });
      const middle = all.reduce((m, o) => add(m, scale(o.at, 1 / all.length)), [0, 0, 0]);
      startDrag(e, (d, ev) => {
        const f = Math.max(0.05, 1 + (d[0] - d[1]) / 150);
        for (const o of all) {
          // the whole extent scales, a span's length included
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
  const pts = project(slots.map((/** @type {any} */ x) => world(x.position ?? [0, 0, 0])));
  slots.forEach((/** @type {any} */ x, /** @type {number} */ i) => {
    const sp = pts[i];
    if (!sp) return;
    const lit = i === editor.slot;
    const ring = el("circle", { cx: sp[0], cy: sp[1], r: 9, fill: "transparent", stroke: lit ? "#6cb6ff" : "#e5b45b", "stroke-width": lit ? 2.5 : 2, class: "hit" });
    el("title", {}, ring).textContent = `slot ${x.name}`;
    ring.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      editor.select(() => (editor.slot = lit ? -1 : i));
    });
  });
}

/**
 * drawJoints: at each pivot of the joints the part hangs by, a ring per axis it turns about, its
 * range as an arc and where it is now as a spoke. Click one to select the
 * joint; drag it to try the joint (shift: 15° steps), held in its range. Trying is never saved.
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
    for (const a of j.axes) {
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
          const t = now + sign * turned;
          editor.setTry(j.name, a, clampTo(ev.shiftKey ? Math.round(t / (Math.PI / 12)) * (Math.PI / 12) : t, lo, hi));
        }, () => editor.emit("select"));
      }, `turn ${j.name} about ${a} (drag to try it)`);
      if (!lit) g.setAttribute("opacity", "0.6");
      // its range, and where it is
      if (lo !== hi) el("path", { d: arc(lo, hi), stroke: COLORS[i], "stroke-width": 6, "stroke-opacity": 0.35, fill: "none", "pointer-events": "none" });
      const tip = ring(now);
      el("path", { d: `M${c[0]},${c[1]}L${tip[0]},${tip[1]}`, stroke: COLORS[i], "stroke-width": 1.5, "pointer-events": "none" });
    }
    const dot = el("circle", { cx: c[0], cy: c[1], r: lit ? 6 : 4, fill: lit ? "#6cb6ff" : "#d8dce4", stroke: "#121418", "stroke-width": 1.5, class: "hit" });
    el("title", {}, dot).textContent = `joint ${j.name}`;
    dot.addEventListener("pointerdown", (e) => (e.stopPropagation(), pick()));
  }
}

/**
 * drawHandles (rig and animate tabs): a marker on the model's root and on each IK target. Click
 * one to select it: arrows move it along the model's axes, and the root's rings turn it. They set
 * the root's channels and the targets' drivers: the pose test's (rig), the selected key's
 * (animate).
 */
function drawHandles() {
  const a = editor.viewer?.query({ q: "handles" });
  if (!a || a.error) return;
  const root = editor.rootChannels();
  const s = a.scale;
  /** @type {{id: string, position: number[], move: string[], turn?: string[]}[]} */
  const iks = editor.ikShow === "hidden" ? [] : a.iks;
  const handles = [
    { id: "root", position: a.root.position, move: root.move, turn: root.turn },
    ...iks.map((/** @type {any} */ ik) => ({ id: ik.name, position: ik.position, move: ["x", "y", "z"].map((x) => `${ik.name}_${x}`) })),
    // a pole: the point its chain bends toward
    ...iks.filter((/** @type {any} */ ik) => ik.pole).map((/** @type {any} */ ik) => ({ id: `${ik.name} pole`, position: ik.pole, move: ["x", "y", "z"].map((x) => `${ik.name}_pole_${x}`) })),
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
          ? el("circle", { cx: p[0], cy: p[1], r: lit ? 8 : 6, fill: "rgba(18,20,24,0.6)", stroke: lit ? "#6cb6ff" : "rgba(229,180,91,0.9)", "stroke-width": 3, class: "hit" })
          : el("circle", { cx: p[0], cy: p[1], r: lit ? 8 : 6, fill: lit ? "#6cb6ff" : "rgba(229,180,91,0.9)", stroke: "#121418", "stroke-width": 1.5, class: "hit" });
    el("title", {}, marker).textContent = x.id === "root" ? "the root: click to move and turn the whole model" : pole ? `${x.id}: the point the chain bends toward; click to move it` : `IK target ${x.id}: click to move it`;
    marker.addEventListener("pointerdown", (e) => {
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

/**
 * handleTools: the selected handle's arrows (and the root's rings), along and about the model's
 * axes, at `x.position`. `s`: metres per model unit.
 * @param {{id: string, position: number[], move: string[], turn?: string[]}} x @param {number} s
 */
function handleTools(x, s) {
  const pts = project([x.position, ...[0, 1, 2].map((k) => add(x.position, scale(IDENTITY_AXES[k], STEP)))]);
  if (pts.length < 4 || pts.some((p) => !p)) return;
  const c = /** @type {number[]} */ (pts[0]);
  const v = pts.slice(1).map((p) => [(/** @type {number[]} */ (p)[0] - c[0]) / STEP, (/** @type {number[]} */ (p)[1] - c[1]) / STEP]);
  const k = LENGTH / (Math.max(...v.map((q) => Math.hypot(q[0], q[1]))) || 1);
  const key = `drag:handle${++drags}`;
  v.forEach((vv, i) => {
    const end = [c[0] + vv[0] * k, c[1] + vv[1] * k];
    handlePath(`M${c[0]},${c[1]}L${end[0]},${end[1]}`, COLORS[i], (e) => {
      const name = x.move[i];
      const v0 = editor.shown()[name] ?? 0;
      follow(e, (d, ev) => {
        // world metres along the axis, to model units
        const by = dot2(d, vv) / (dot2(vv, vv) || 1) / s;
        editor.setChannels({ [name]: r5(round(v0 + by, ev.shiftKey ? 0.01 : 1e-4)) }, key);
      }, () => editor.emit("select"));
    }, `move ${x.id} along ${"xyz"[i]} (shift: 0.01 steps)`);
    el("circle", { cx: end[0], cy: end[1], r: 5, fill: COLORS[i], "pointer-events": "none" });
  });
  const turn = x.turn;
  if (!turn?.length) return;
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
      const r0 = euler(turn.map((n) => now[n] ?? 0));
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
        editor.setChannels(Object.fromEntries(turn.map((n, j) => [n, r[j]])), key);
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

/** pickAt selects what is under a point of the canvas: a shape in the model tab (`add`: shift, to the selection), an instance in the assemble and rig tabs, and in the animate tab an instance whose keys the timeline then shows (empty space: all of them) @param {number} x @param {number} y @param {boolean} [add] */
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
