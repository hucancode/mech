// @ts-check
// The view's direct manipulation (model tab): click a piece to select its part and shape, and drag
// handles drawn over the view to edit the selected shape or put the part's socket on its parent.
//   move (W)    arrows along the part's axes move the shape
//   rotate (E)  rings about the part's axes turn the shape (shift: 15° steps)
//   scale (R)   boxes along the shape's own axes size it; the middle box sizes it all
//   socket (T)  dots on the parent's shapes' faces; click one to bolt the part there
// Shift snaps moves to 0.01 and sizes to 0.01. A drag is one undo step.
//
// Everything here is the page's: the engine only says where the part is ({"q": "parts"}), where
// points show on the canvas ({"q": "project"}) and what is under the cursor ({"q": "pick"}).
import { hold, release } from "./dom.js";
import { editor } from "./editor.js";
import { add, apply, cross, euler, eulerFrom, fromQuat, mul, rotation, scale } from "./math3.js";
import { FACE_NAMES, partIndex, perpendicular, snapSocket, socketFace } from "./model.js";

/** @typedef {"move" | "rotate" | "scale" | "socket"} Mode */
/** @type {{mode: Mode}} */
export const gizmo = { mode: "move" };

const SVG = "http://www.w3.org/2000/svg";
const COLORS = ["#e5675b", "#7fc35b", "#5b9be5"];
const LENGTH = 80; // pixels, the longest handle

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
  e.preventDefault();
  e.stopPropagation();
  const x0 = e.clientX;
  const y0 = e.clientY;
  const key = `drag:gizmo${++drags}`;
  hold();
  const move = (/** @type {PointerEvent} */ m) => editor.edit("model", () => update([m.clientX - x0, m.clientY - y0], m), key);
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    release();
  };
  window.addEventListener("pointermove", move);
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
  const part = m.parts?.[editor.part];
  if (editor.tab !== "model" || !part || !editor.viewer || (editor.isolate && editor.explode > 0)) return;
  const s = m.scale ?? 1;
  if (gizmo.mode === "socket") return drawSocket(part, s);
  const shape = part.shapes?.[editor.shape];
  const f = frameOf(part.name);
  if (!shape || !f) return;
  const centre = add(f.position, apply(f.rotation, scale(shape.position ?? [0, 0, 0], s)));
  // move and rotate go by the part's axes, scale by the shape's own
  const axes = gizmo.mode === "scale" ? mul(f.rotation, euler(shape.rotation)) : f.rotation;
  const dirs = [0, 1, 2].map((k) => [axes[k], axes[3 + k], axes[6 + k]]);
  const pts = project([centre, ...dirs.map((d) => add(centre, d))]);
  if (pts.length < 4 || pts.some((p) => !p)) return;
  const c = /** @type {number[]} */ (pts[0]);
  // each axis on screen, per world unit (the view is near enough flat across a handle)
  const v = pts.slice(1).map((p) => [/** @type {number[]} */ (p)[0] - c[0], /** @type {number[]} */ (p)[1] - c[1]]);
  const k = LENGTH / (Math.max(...v.map((x) => Math.hypot(x[0], x[1]))) || 1);
  const at = (/** @type {number[]} */ x, /** @type {number} */ t = 1) => [c[0] + x[0] * k * t, c[1] + x[1] * k * t];
  /** world units along screen vector vv for a pointer offset d @param {number[]} vv @param {number[]} d */
  const along = (vv, d) => dot2(d, vv) / (dot2(vv, vv) || 1);

  if (gizmo.mode === "move") {
    v.forEach((vv, i) => {
      const end = at(vv);
      handlePath(`M${c[0]},${c[1]}L${end[0]},${end[1]}`, COLORS[i], (e) => {
        const p0 = [...(shape.position ?? [0, 0, 0])];
        startDrag(e, (d, ev) => {
          const p = [...p0];
          p[i] = round(p0[i] + along(vv, d) / s, ev.shiftKey ? 0.01 : 1e-4);
          shape.position = p.map(r5);
        });
      }, `move along ${"xyz"[i]}`);
      el("circle", { cx: end[0], cy: end[1], r: 5, fill: COLORS[i], "pointer-events": "none" });
    });
  } else if (gizmo.mode === "scale") {
    v.forEach((vv, i) => {
      const end = at(vv);
      el("path", { d: `M${c[0]},${c[1]}L${end[0]},${end[1]}`, stroke: COLORS[i], "stroke-width": 2, "pointer-events": "none" });
      handleBox(end, COLORS[i], (e) => {
        const s0 = [...(shape.size ?? [0.2, 0.2, 0.2])];
        startDrag(e, (d, ev) => {
          const size = [...s0];
          size[i] = Math.max(0.005, round(s0[i] + (2 * along(vv, d)) / s, ev.shiftKey ? 0.01 : 1e-4));
          shape.size = size.map(r5);
        });
      }, `size along the shape's ${"xyz"[i]}`);
    });
    handleBox(c, "#d8dce4", (e) => {
      const s0 = [...(shape.size ?? [0.2, 0.2, 0.2])];
      startDrag(e, (d, ev) => {
        const f = Math.max(0.05, 1 + (d[0] - d[1]) / 150);
        shape.size = s0.map((x) => r5(Math.max(0.005, round(x * f, ev.shiftKey ? 0.01 : 1e-4))));
      });
    }, "size it all (drag right or up)");
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
          shape.rotation = eulerFrom(mul(rotation(i, theta), r0)).map(r5);
        });
      }, `turn about ${"xyz"[i]} (shift: 15° steps)`);
    });
  }
}

/** drawSocket: a dot on each face of the parent's shapes that faces the camera; the one the socket is on is lit @param {any} part @param {number} s */
function drawSocket(part, s) {
  const m = editor.model;
  const parent = m.parts[partIndex(m, part.parent)];
  const f = parent && frameOf(parent.name);
  if (!parent || !f) return;
  const key = `${parent.name}:${JSON.stringify(parent.shapes)}`;
  if (faceCache.key !== key) faceCache = { key, faces: editor.faces(parent.name) };
  const faces = faceCache.faces;
  const world = (/** @type {number[]} */ p) => add(f.position, apply(f.rotation, scale(p, s)));
  const flat = faces.flatMap((list, k) => list.map((face, n) => ({ k, n, face })));
  // each face's point and two along it: wound one way on screen when it faces the camera
  const pts = project([
    world(part.socket?.position ?? [0, 0, 0]),
    ...flat.flatMap(({ face }) => {
      const t1 = perpendicular(face.normal);
      const t2 = cross(face.normal, t1);
      return [face.position, add(face.position, scale(t1, 0.05)), add(face.position, scale(t2, 0.05))].map(world);
    }),
  ]);
  const on = faces.map((list) => socketFace(part.socket, list));
  flat.forEach(({ k, n, face }, i) => {
    const [p, a, b] = pts.slice(1 + i * 3, 4 + i * 3);
    if (!p || !a || !b) return;
    const lit = on[k] === n;
    const facing = (a[0] - p[0]) * (b[1] - p[1]) - (a[1] - p[1]) * (b[0] - p[0]) < 0;
    if (!facing && !lit) return;
    const dot = el("circle", { cx: p[0], cy: p[1], r: lit ? 7 : 5, fill: lit ? "#6cb6ff" : "rgba(216,220,228,0.85)", stroke: "#121418", "stroke-width": 1.5, class: "hit" });
    el("title", {}, dot).textContent = `bolt onto the ${FACE_NAMES[n]} face of ${parent.name}'s shape ${k + 1}`;
    dot.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      editor.edit("model", () => (part.socket = snapSocket(part.socket, face, parent.shapes[k].position ?? [0, 0, 0])));
    });
  });
  const sp = pts[0];
  if (sp) el("circle", { cx: sp[0], cy: sp[1], r: 9, fill: "none", stroke: "#6cb6ff", "stroke-width": 2, "pointer-events": "none" });
}

/** pickAt selects the part (and shape) under a point of the canvas, in the model and rig tabs @param {number} x @param {number} y */
function pickAt(x, y) {
  if (editor.tab === "animation") return;
  const hit = editor.viewer?.query({ q: "pick", x, y });
  if (!hit || hit.part < 0) return;
  editor.select(() => {
    editor.part = hit.part;
    editor.shape = hit.shape >= 0 ? hit.shape : (editor.model.parts[hit.part]?.shapes?.length ?? 0) > 0 ? 0 : -1;
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
    if (down && Math.hypot(e.offsetX - down.x, e.offsetY - down.y) < 4) pickAt(e.offsetX, e.offsetY);
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
