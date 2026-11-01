// @ts-check
// The view gizmo in the view's corner: the world axes as the camera sees them, a fixed size,
// turning with the camera and always drawn on top. Click an axis end to look from that side
// (orthographic, framed); click the disc to go back to the free perspective orbit. Dragging the
// view turns the camera and goes back to free on its own.
import { editor } from "./editor.js";
import { fromQuat } from "./math3.js";

const SVG = "http://www.w3.org/2000/svg";
const COLORS = ["#e5675b", "#7fc35b", "#5b9be5"];
/** the disc's radius and each axis's length on screen, CSS pixels */
const RADIUS = 46;
const LENGTH = 32;
/** the viewer's View of looking from each axis end: +x, -x, +y, -y, +z, -z */
const VIEW = [
  [1, 2],
  [3, 4],
  [5, 6],
];
const SIDES = [
  ["character's left (+x)", "character's right (-x)"],
  ["top (+y)", "bottom (-y)"],
  ["front (+z)", "back (-z)"],
];

/** @type {SVGSVGElement} */
let svg;
/** @type {SVGCircleElement} */
let disc;
/** each axis end, +x, -x, +y, -y, +z, -z: its group, line (positive ends), circle and text @type {{g: Element, line?: Element, dot: Element, text?: Element}[]} */
const ends = [];

/** @param {string} tag @param {Record<string, any>} attrs @param {Element} parent */
function el(tag, attrs, parent = svg) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent.appendChild(e);
  return e;
}

/** @param {number} view */
const look = (view) => editor.viewer?.view(view);

/** build makes the disc and the six ends; draw moves them */
function build() {
  const c = RADIUS;
  disc = /** @type {SVGCircleElement} */ (el("circle", { cx: c, cy: c, r: RADIUS - 2, class: "disc" }));
  el("title", {}, disc).textContent = "Free perspective orbit (drag the view to turn; click an axis to look from that side)";
  disc.addEventListener("pointerdown", () => look(0));
  for (let k = 0; k < 3; k++)
    for (const pos of [true, false]) {
      const g = el("g", { class: "end" });
      const end = {
        g,
        line: pos ? el("line", { x1: c, y1: c, stroke: COLORS[k], "stroke-width": 2 }, g) : undefined,
        dot: el("circle", pos ? { r: 8, fill: COLORS[k] } : { r: 6, fill: "rgba(0,0,0,0.25)", stroke: COLORS[k], "stroke-width": 1.5 }, g),
        text: pos ? el("text", { "text-anchor": "middle" }, g) : undefined,
      };
      if (end.text) end.text.textContent = "XYZ"[k];
      el("title", {}, g).textContent = `Look from the ${SIDES[k][pos ? 0 : 1]}`;
      g.addEventListener("pointerdown", (e) => (e.stopPropagation(), look(VIEW[k][pos ? 0 : 1])));
      ends.push(end);
    }
}

function draw() {
  const cam = editor.viewer?.query({ q: "camera" });
  svg.style.display = cam?.rotation ? "" : "none";
  if (!cam?.rotation) return;
  const r = fromQuat(cam.rotation);
  const c = RADIUS;
  disc.classList.toggle("on", !cam.view);
  // each world axis in the camera's frame is a row of its rotation; ends stacked back to front
  const depth = ends.map((end, n) => {
    const k = n >> 1, s = n & 1 ? -1 : 1;
    const x = c + r[k * 3] * s * LENGTH, y = c - r[k * 3 + 1] * s * LENGTH;
    end.line?.setAttribute("x2", String(x));
    end.line?.setAttribute("y2", String(y));
    end.dot.setAttribute("cx", String(x));
    end.dot.setAttribute("cy", String(y));
    end.text?.setAttribute("x", String(x));
    end.text?.setAttribute("y", String(y + 3.5));
    end.g.classList.toggle("on", cam.view === n + 1);
    return { end, z: r[k * 3 + 2] * s };
  });
  depth.sort((a, b) => a.z - b.z);
  depth.forEach(({ end }, n) => svg.children[n + 1] !== end.g && svg.insertBefore(end.g, svg.children[n + 1] ?? null));
}

/** install puts the view gizmo in the view's corner. */
export function install() {
  const stage = /** @type {HTMLElement} */ (document.getElementById("stage"));
  svg = /** @type {SVGSVGElement} */ (document.createElementNS(SVG, "svg"));
  svg.id = "view-gizmo";
  svg.setAttribute("width", String(2 * RADIUS));
  svg.setAttribute("height", String(2 * RADIUS));
  stage.appendChild(svg);
  build();
  const tick = () => {
    draw();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
