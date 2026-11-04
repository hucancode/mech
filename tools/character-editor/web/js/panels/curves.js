// @ts-check
// The curve editor: the Animate tab's dock. It shows the motion picked in the sidebar's Motions as
// curves: on the left its shape over one cycle, on the right what each of its moves adds over the
// clip, one lane each, both drawn from what the engine computes (the "motion" query), so what
// shows is what plays.
//   shape: drag a point to reshape it        click empty space: add a point there
//          double-click a point: remove it   shift-drag: snap to 0.05, or onto an arc's point
//          (the dotted lines: the values that put the motion's arcs on their points)
//   lanes: drag one sideways to make its move run later or sooner (its delay); click a lane to
//          pick its move (shift: several, to split them off); too many moves for a lane each
//          (a chain's joints) share one: a drag there moves them all, a click scrubs
//   ruler: click or drag to scrub; the bar under it is the first move's first cycle: drag it to
//          make every move run later or sooner, its right end to fit more or fewer whole cycles
//          in the clip (its rate)
import { btn, h, select } from "../dom.js";
import { dockSpanButtons } from "../layout.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { arcSpan, EASES } from "../model.js";
import { shapeName, SHAPES } from "../shapes.js";

const TOP = 26; // the titles and the ruler
const PAD = 12;
const GAP = 22;
const HIT = 7;
const N = 160;

const css = (/** @type {string} */ name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const round = (/** @type {number} */ v) => Math.round(v * 1000) / 1000;

export class Curves {
  constructor() {
    this.canvas = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "timeline", tabIndex: 0 }));
    this.scroll = h("div", { class: "dock-scroll", style: { overflow: "hidden" } }, this.canvas);
    this.bar = h("div", { class: "dock-bar" });
    this.el = [this.bar, this.scroll];
    this.width = 800;
    this.height = 200;
    /** the selected point of the shape, -1 none */
    this.point = -1;
    /** @type {any} */
    this.drag = null;
    /** @type {string} what's under the pointer, to draw it lit */
    this.hover = "";
    this.version = 0;
    /** @type {{stamp: string, data: any} | null} */
    this.cache = null;
    new ResizeObserver(() => {
      this.width = this.scroll.clientWidth;
      this.height = this.scroll.clientHeight;
      this.draw();
    }).observe(this.scroll);
    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    this.canvas.addEventListener("pointermove", (e) => this.move(e));
    this.canvas.addEventListener("pointerup", (e) => this.up(e));
    this.canvas.addEventListener("dblclick", (e) => this.dbl(e));
  }

  get motions() {
    return editor.clipData?.motions ?? [];
  }

  /** the motion shown, its index kept in range @returns {any} */
  get mo() {
    const ms = this.motions;
    editor.motion = Math.min(Math.max(editor.motion, 0), Math.max(ms.length - 1, 0));
    return ms[editor.motion];
  }

  get duration() {
    return Math.max(editor.clipData?.duration ?? 1, 0.01);
  }

  /** the motion as the engine samples it: {shape, moves: [{channels, delay, values}]} @returns {any} */
  get data() {
    const stamp = `${this.version}:${editor.clip}:${editor.motion}`;
    if (this.cache?.stamp !== stamp) {
      const a = this.mo && editor.viewer ? editor.viewer.query({ q: "motion", clip: editor.clipData.name, motion: editor.motion, n: N }) : null;
      this.cache = { stamp, data: a && !a.error ? a : null };
    }
    return this.cache.data;
  }

  // data changed: rebuild the toolbar and redraw
  refresh() {
    this.version++;
    if (this.point >= (this.mo?.shape?.length ?? 0)) this.point = -1;
    this.bar.replaceChildren(...this.toolbar().flat().filter((c) => c !== false && c !== null && c !== undefined && c !== ""));
    this.draw();
  }

  /** @param {() => void} change @param {string} [id] */
  set(change, id) {
    editor.edit("anim", change, id);
  }

  toolbar() {
    const clip = editor.clipData;
    const mo = this.mo;
    const p = mo?.shape?.[this.point];
    return [
      h("span", { class: "dock-title" }, "Motions"),
      h("span", { class: "sep" }),
      clip && !mo && h("span", { class: "muted" }, "No motions: add one in the sidebar's Motions"),
      editor.isolate && h("span", { class: "tag", title: "Only the picked motions play: the eye in the sidebar's Motions" }, "isolated"),
      mo && h("span", { class: "sep" }),
      ...(mo ? SHAPES.map((s) => btn(s.name, () => this.set(() => ((mo.shape = s.points()), mo.shape.length || delete mo.shape, (this.point = -1))), { on: shapeName(mo) === s.name, title: `${s.title}: start the shape over from this` })) : []),
      p && h("span", { class: "sep" }),
      p && h("span", { class: "muted", title: "How the shape reaches this point from the one before" }, "ease in"),
      p && select({ value: p.ease ?? "LINEAR", options: EASES, onchange: (v) => this.set(() => (v === "LINEAR" ? delete p.ease : (p.ease = v))) }),
      p && btn(icon("x"), () => this.deletePoint(), { kind: "icon", title: "Remove this point (Delete; or double-click it)" }),
      h("span", { class: "grow" }),
      dockSpanButtons(() => this.refresh()),
    ];
  }

  tick() {
    this.draw();
  }

  deletePoint() {
    const mo = this.mo;
    if (!mo?.shape?.[this.point]) return;
    this.set(() => {
      mo.shape.splice(this.point, 1);
      if (!mo.shape.length) delete mo.shape;
      this.point = -1;
    });
  }

  // ---- layout --------------------------------------------------------------------------------

  /**
   * the values of the shape that put the shown motion's arcs on their points (k / (n - 1) for an
   * arc of n points, mech.arc_at), each labelled with its points: [v, label][]
   * @returns {[number, string][]}
   */
  arcLevels() {
    /** @type {Map<number, string[]>} */
    const at = new Map();
    const seen = new Set();
    for (const mv of this.mo?.moves ?? [])
      for (const v of Object.values(mv.by ?? {})) {
        // a position on an arc: the arc, by name, once
        const arc = typeof v === "string" && !seen.has(v) && editor.anim.arcs?.find((/** @type {any} */ x) => x.name === v);
        if (!arc || arc.points.length < 2) continue;
        seen.add(v);
        arc.points.forEach((/** @type {any} */ _, /** @type {number} */ k) => {
          const u = round(k / arcSpan(arc));
          at.set(u, [...(at.get(u) ?? []), `${v} ${k + 1}`]);
        });
      }
    return [...at].map(([v, names]) => [v, names.join(", ")]);
  }

  /** the shape's box and the lanes' box: [x0, x1] each, and the rows' top and bottom */
  get boxes() {
    const w = Math.min(Math.max(220, this.width * 0.3), 380);
    return { s0: PAD, s1: PAD + w, l0: PAD + w + GAP, l1: this.width - PAD, top: TOP + 6, bottom: Math.max(this.height - PAD, TOP + 40) };
  }

  /** the shape's value range, padded: frozen while dragging so the box holds still @returns {[number, number]} */
  get range() {
    if (this.drag?.range) return this.drag.range;
    const vs = [0, 1, ...(this.mo?.shape ?? []).map((/** @type {any} */ p) => p.v ?? 0), ...(this.data?.shape ?? [])];
    const lo = Math.min(...vs);
    const hi = Math.max(...vs);
    const m = (hi - lo) * 0.12 || 0.2;
    return [lo - m, hi + m];
  }

  /** @param {number} u */
  xu(u) {
    const b = this.boxes;
    return b.s0 + u * (b.s1 - b.s0);
  }
  /** @param {number} v */
  yv(v) {
    const b = this.boxes;
    const [lo, hi] = this.range;
    return b.bottom - ((v - lo) / (hi - lo)) * (b.bottom - b.top);
  }
  /** @param {number} x */
  ux(x) {
    const b = this.boxes;
    return (x - b.s0) / (b.s1 - b.s0);
  }
  /** @param {number} y */
  vy(y) {
    const b = this.boxes;
    const [lo, hi] = this.range;
    return lo + ((b.bottom - y) / (b.bottom - b.top)) * (hi - lo);
  }
  /** @param {number} t */
  xt(t) {
    const b = this.boxes;
    return b.l0 + (t / this.duration) * (b.l1 - b.l0);
  }
  /** @param {number} x */
  tx(x) {
    const b = this.boxes;
    return ((x - b.l0) / (b.l1 - b.l0)) * this.duration;
  }

  /** whether the moves share one lane, too many for one each (a chain's joints): a wave shows travelling */
  get overlaid() {
    const b = this.boxes;
    const n = this.data?.moves?.length ?? 0;
    return n > 1 && (b.bottom - b.top) / n < 30;
  }

  /** the lanes, one per move, or one for them all when overlaid: [top, bottom] @returns {[number, number][]} */
  lanes() {
    const b = this.boxes;
    const n = this.overlaid ? 1 : Math.max(this.data?.moves?.length ?? 0, 1);
    const hgt = (b.bottom - b.top) / n;
    return Array.from({ length: n }, (_, k) => [b.top + k * hgt, b.top + (k + 1) * hgt]);
  }

  /** the first move's first cycle, seconds: [delay, delay + 1] / rate of the clip */
  get window() {
    const mo = this.mo;
    const rate = mo?.rate || 1;
    const at = ((mo?.moves?.[0]?.delay ?? 0) / rate) * this.duration;
    return [at, at + this.duration / rate];
  }

  // ---- drawing -------------------------------------------------------------------------------

  draw() {
    const g = this.canvas.getContext("2d");
    if (!g) return;
    const width = this.width;
    const height = Math.max(this.height, 1);
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const [bg, line, muted, text, accent, field, dim] = ["--panel", "--line", "--muted", "--text", "--accent", "--field", "--accent-dim"].map(css);
    g.fillStyle = bg;
    g.fillRect(0, 0, width, height);
    g.font = "11px system-ui";
    const mo = this.mo;
    const data = this.data;
    if (!editor.clipData || !mo) {
      g.fillStyle = muted;
      g.fillText(editor.clipData ? "No motions in this clip. Add one with +." : "No clip", PAD, TOP + 8);
      return;
    }
    const b = this.boxes;

    // ---- the shape, one cycle
    g.fillStyle = field;
    g.fillRect(b.s0, b.top, b.s1 - b.s0, b.bottom - b.top);
    g.strokeStyle = line;
    for (const u of [0.25, 0.5, 0.75]) {
      const x = Math.round(this.xu(u)) + 0.5;
      g.beginPath();
      g.moveTo(x, b.top);
      g.lineTo(x, b.bottom);
      g.stroke();
    }
    for (const v of [0, 1, -1]) {
      const y = Math.round(this.yv(v)) + 0.5;
      if (y < b.top || y > b.bottom) continue;
      g.strokeStyle = v === 0 ? muted : line;
      g.setLineDash(v === 0 ? [] : [3, 3]);
      g.beginPath();
      g.moveTo(b.s0, y);
      g.lineTo(b.s1, y);
      g.stroke();
      g.fillStyle = muted;
      g.fillText(String(v), b.s0 + 3, y - 3);
    }
    // an arc's points: where the shape puts its target on point k (k / (n - 1))
    g.strokeStyle = g.fillStyle = "rgba(229,180,91,0.55)";
    g.setLineDash([2, 4]);
    for (const [v, label] of this.arcLevels()) {
      const y = Math.round(this.yv(v)) + 0.5;
      if (y < b.top || y > b.bottom) continue;
      g.beginPath();
      g.moveTo(b.s0, y);
      g.lineTo(b.s1, y);
      g.stroke();
      g.fillText(label, b.s1 - g.measureText(label).width - 3, y - 3);
    }
    g.setLineDash([]);
    if (data?.shape) this.plot(g, data.shape, (i) => this.xu(i / (data.shape.length - 1)), (v) => this.yv(v), accent, 2);
    const pts = mo.shape ?? [];
    pts.forEach((/** @type {any} */ p, /** @type {number} */ i) => {
      const x = this.xu(p.u ?? 0);
      const y = this.yv(p.v ?? 0);
      g.beginPath();
      g.arc(x, y, i === this.point ? 5.5 : 4.5, 0, Math.PI * 2);
      g.fillStyle = i === this.point ? text : bg;
      g.fill();
      g.strokeStyle = i === this.point || this.hover === `point${i}` ? text : accent;
      g.lineWidth = 2;
      g.stroke();
      g.lineWidth = 1;
    });
    const sel = pts[this.point];
    if (sel) {
      g.fillStyle = text;
      const label = `u ${round(sel.u ?? 0)}  v ${round(sel.v ?? 0)}`;
      const x = Math.min(this.xu(sel.u ?? 0) + 8, b.s1 - g.measureText(label).width - 4);
      g.fillText(label, x, Math.max(this.yv(sel.v ?? 0) - 9, b.top + 11));
    }
    if (!pts.length) {
      g.fillStyle = muted;
      g.fillText("No points: held at 1. Click to add one.", b.s0 + 8, b.bottom - 8);
    }

    // ---- the lanes, over the clip
    const [w0, w1] = this.window;
    // the window, under the ruler
    const xa = Math.max(this.xt(w0), b.l0);
    const xb = Math.min(this.xt(w1), b.l1);
    if (xb > xa) {
      g.fillStyle = this.hover === "window" || this.hover === "length" ? accent : dim;
      g.fillRect(xa, TOP - 8, xb - xa, 6);
      g.fillStyle = this.hover === "length" ? text : accent;
      g.fillRect(xb - 3, TOP - 10, 3, 10);
    }
    // ruler ticks, seconds
    const step = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5].find((s) => ((b.l1 - b.l0) * s) / this.duration >= 50) ?? 5;
    for (let t = 0; t <= this.duration + 1e-6; t += step) {
      const x = Math.round(this.xt(t)) + 0.5;
      g.strokeStyle = line;
      g.beginPath();
      g.moveTo(x, b.top);
      g.lineTo(x, b.bottom);
      g.stroke();
      g.fillStyle = muted;
      g.fillText(`${+t.toFixed(2)}s`, x + 3, TOP - 12);
    }
    const lanesData = data?.moves ?? [];
    const lanes = this.lanes();
    const peak = Math.max(1e-6, ...lanesData.flatMap((/** @type {any} */ l) => l.values.map(Math.abs)));
    const overlaid = this.overlaid;
    lanes.forEach(([y0, y1], k) => {
      const l = lanesData[k];
      g.fillStyle = k % 2 ? bg : field;
      g.fillRect(b.l0, y0, b.l1 - b.l0, y1 - y0);
      const mid = (y0 + y1) / 2;
      const half = (y1 - y0) / 2 - 4;
      g.strokeStyle = line;
      g.beginPath();
      g.moveTo(b.l0, Math.round(mid) + 0.5);
      g.lineTo(b.l1, Math.round(mid) + 0.5);
      g.stroke();
      if (!l) {
        g.fillStyle = muted;
        g.fillText("No moves yet: add one in the inspector", b.l0 + 6, mid - 4);
        return;
      }
      const lit = this.hover === `lane${k}` || this.drag?.lane === k || (!overlaid && editor.pickedMoves().includes(k));
      const y = (/** @type {number} */ v) => mid - (v / peak) * half;
      if (overlaid) {
        // every move in the one lane, the first brightest, fading toward the last
        lanesData.forEach((/** @type {any} */ x, /** @type {number} */ n) => {
          g.globalAlpha = 1 - (0.75 * n) / (lanesData.length - 1);
          this.plot(g, x.values, (i) => this.xt((this.duration * i) / (x.values.length - 1)), y, lit ? text : accent, n ? 1.25 : 2);
        });
        g.globalAlpha = 1;
        const name = (/** @type {any} */ x) => x.channels[0]?.replace(/_[xyz]$/, "") ?? "?";
        g.fillStyle = muted;
        g.fillText(`${lanesData.length} moves, overlaid: ${name(lanesData[0])} (bright) to ${name(lanesData[lanesData.length - 1])} (faint)`, b.l0 + 6, y0 + 12);
        return;
      }
      // a spread move's later links, fainter as they come later
      (l.links ?? []).forEach((/** @type {any} */ x, /** @type {number} */ n, /** @type {any[]} */ all) => {
        g.globalAlpha = 0.5 - (0.35 * n) / Math.max(1, all.length - 1);
        this.plot(g, x.values, (i) => this.xt((this.duration * i) / (x.values.length - 1)), y, lit ? text : accent, 1);
      });
      g.globalAlpha = 1;
      // a twin move's twins (the other side), faint, under it
      if (l.twin) {
        g.globalAlpha = 0.4;
        this.plot(g, l.twin.values, (i) => this.xt((this.duration * i) / (l.twin.values.length - 1)), y, lit ? text : accent, 1.25);
        g.globalAlpha = 1;
      }
      this.plot(g, l.values, (i) => this.xt((this.duration * i) / (l.values.length - 1)), y, lit ? text : accent, lit ? 2 : 1.5);
      // the move's name: its channels
      const names = l.channels.length ? l.channels.map((/** @type {string} */ c) => c.replace(/_[xyz]$/, "")).filter((/** @type {string} */ c, /** @type {number} */ i, /** @type {string[]} */ a) => a.indexOf(c) === i) : ["(no channels)"];
      const label = `${k + 1}. ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""}${l.links ? ` (spread over ${l.links.length + 1})` : ""}${l.twin ? " (and twins, faint)" : ""}`;
      g.fillStyle = lit ? text : muted;
      g.fillText(label, b.l0 + 6, y0 + 12);
    });
    // the playhead, and where each lane is at it
    const px = Math.round(this.xt(Math.min(editor.time, this.duration))) + 0.5;
    g.strokeStyle = g.fillStyle = "#5bb8ff";
    g.beginPath();
    g.moveTo(px, TOP - 12);
    g.lineTo(px, b.bottom);
    g.stroke();
  }

  /**
   * a polyline through `vs`, the i-th at (x(i), y(vs[i]))
   * @param {CanvasRenderingContext2D} g @param {number[]} vs @param {(i: number) => number} x @param {(v: number) => number} y @param {string} color @param {number} wide
   */
  plot(g, vs, x, y, color, wide) {
    g.strokeStyle = color;
    g.lineWidth = wide;
    g.beginPath();
    vs.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v))));
    g.stroke();
    g.lineWidth = 1;
  }

  // ---- pointer -------------------------------------------------------------------------------

  /** @param {MouseEvent} e */
  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** what is at (x, y): a point, the shape's box, the window or its end, the ruler, a lane @param {number} x @param {number} y */
  hit(x, y) {
    const b = this.boxes;
    const mo = this.mo;
    if (!mo) return "";
    if (x >= b.s0 - HIT && x <= b.s1 + HIT && y >= b.top - HIT && y <= b.bottom + HIT) {
      const pts = mo.shape ?? [];
      let best = -1;
      let near = HIT * HIT;
      pts.forEach((/** @type {any} */ p, /** @type {number} */ i) => {
        const d = (this.xu(p.u ?? 0) - x) ** 2 + (this.yv(p.v ?? 0) - y) ** 2;
        if (d <= near) ((near = d), (best = i));
      });
      return best >= 0 ? `point${best}` : "shape";
    }
    if (x < b.l0 - HIT) return "";
    if (y < b.top) {
      const [, w1] = this.window;
      if (y >= TOP - 12 && Math.abs(x - this.xt(w1)) <= HIT) return "length";
      const [w0] = this.window;
      if (y >= TOP - 10 && x >= this.xt(w0) && x <= this.xt(w1)) return "window";
      return "ruler";
    }
    const k = this.lanes().findIndex(([y0, y1]) => y >= y0 && y < y1);
    return k >= 0 && this.data?.moves?.[k] ? `lane${k}` : "ruler";
  }

  /** @param {PointerEvent} e */
  down(e) {
    const { x, y } = this.pos(e);
    const mo = this.mo;
    const what = this.hit(x, y);
    if (!what) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.focus();
    const id = `drag:curves-${performance.now()}`;
    if (what.startsWith("point") || what === "shape") {
      const range = this.range;
      if (what === "shape") {
        // a new point, where clicked
        const p = { u: round(Math.min(Math.max(this.ux(x), 0), 1)), v: round(this.vy(y)) };
        this.set(() => {
          mo.shape ??= [];
          mo.shape.push(p);
          mo.shape.sort((/** @type {any} */ a, /** @type {any} */ c) => (a.u ?? 0) - (c.u ?? 0));
          this.point = mo.shape.indexOf(p);
        }, id);
      } else editor.select(() => (this.point = Number(what.slice(5))));
      this.drag = { mode: "point", range, id };
      return;
    }
    if (what === "ruler") {
      this.drag = { mode: "scrub" };
      editor.seek(Math.min(Math.max(this.tx(x), 0), this.duration));
      return;
    }
    const delays = (mo.moves ?? []).map((/** @type {any} */ mv) => mv.delay ?? 0);
    if (what === "window" || what === "length") {
      this.drag = { mode: what, x0: x, window: this.window, delays, rate: mo.rate || 1, id };
      return;
    }
    // a lane moves its own move; the lane the moves share moves them all
    const k = Number(what.slice(4));
    this.drag = { mode: "lane", lane: k, x0: x, delays, id, moved: false, add: e.shiftKey || e.metaKey || e.ctrlKey };
  }

  /** @param {PointerEvent} e */
  move(e) {
    const { x, y } = this.pos(e);
    const d = this.drag;
    const mo = this.mo;
    if (!d) {
      const what = this.hit(x, y);
      if (what !== this.hover) {
        this.hover = what;
        this.draw();
      }
      this.canvas.style.cursor = what.startsWith("point") ? "grab" : what === "shape" ? "crosshair" : what === "length" ? "ew-resize" : what === "window" || what.startsWith("lane") ? "grab" : what === "ruler" ? "text" : "default";
      return;
    }
    if (d.mode === "scrub") return editor.seek(Math.min(Math.max(this.tx(x), 0), this.duration));
    const dt = this.tx(x) - this.tx(d.x0);
    if (d.mode === "point") {
      const snap = (/** @type {number} */ v) => (e.shiftKey ? Math.round(v * 20) / 20 : round(v));
      // shift: a value onto an arc's point when near one (its target held there)
      const levels = this.arcLevels().map(([v]) => v);
      const snapV = (/** @type {number} */ v) => {
        const near = levels.find((l) => Math.abs(l - v) < 0.05);
        return e.shiftKey && near !== undefined ? round(near) : snap(v);
      };
      this.set(() => {
        const p = mo.shape[this.point];
        if (!p) return;
        p.u = snap(Math.min(Math.max(this.ux(x), 0), 1));
        p.v = snapV(this.vy(y));
        if (!p.u) delete p.u;
        if (!p.v) delete p.v;
        mo.shape.sort((/** @type {any} */ a, /** @type {any} */ c) => (a.u ?? 0) - (c.u ?? 0));
        this.point = mo.shape.indexOf(p);
      }, d.id);
    } else if (d.mode === "window") {
      // every move runs dt later: rate cycles over the clip
      this.shiftDelays(mo, d, null, (d.rate * dt) / this.duration);
    } else if (d.mode === "length") {
      // the cycle's end follows the pointer: as many whole cycles as fit in the clip
      const [w0, w1] = d.window;
      const rate = Math.max(1, Math.round(this.duration / Math.max(0.02, w1 - w0 + dt)));
      if (rate !== (mo.rate || 1)) this.set(() => (rate === 1 ? delete mo.rate : (mo.rate = rate)), d.id);
    } else if (d.mode === "lane") {
      if (Math.abs(x - d.x0) < 3 && !d.moved) return;
      d.moved = true;
      // sliding a lane right by dt makes its move run dt later: rate cycles over the clip
      this.shiftDelays(mo, d, this.overlaid ? null : d.lane, ((mo.rate || 1) * dt) / this.duration);
    }
  }

  /**
   * shiftDelays makes move `k` (null: every move) run `by` cycles later than when the drag began
   * @param {any} mo @param {any} d @param {number | null} k @param {number} by
   */
  shiftDelays(mo, d, k, by) {
    this.set(() => {
      (mo.moves ?? []).forEach((/** @type {any} */ mv, /** @type {number} */ n) => {
        if (k !== null && n !== k) return;
        const delay = round((d.delays[n] ?? 0) + by);
        delay ? (mv.delay = delay) : delete mv.delay;
      });
    }, d.id);
  }

  /** @param {PointerEvent} e */
  up(e) {
    const d = this.drag;
    this.drag = null;
    // a click on a move's lane picks it; on the lane the moves share, it scrubs
    if (d?.mode === "lane" && !d.moved) {
      if (this.overlaid) editor.seek(Math.min(Math.max(this.tx(this.pos(e).x), 0), this.duration));
      else editor.pickMove(d.lane, d.add);
    }
    this.draw();
  }

  /** @param {MouseEvent} e */
  dbl(e) {
    const { x, y } = this.pos(e);
    const what = this.hit(x, y);
    if (!what.startsWith("point")) return;
    this.point = Number(what.slice(5));
    this.deletePoint();
  }
}
