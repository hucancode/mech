// @ts-check
// The timeline: a ruler with the playhead, one row per key frame (a bar from `at` across
// `duration`, its ease drawn inside, coloured by priority), and below them the selected key's
// channels as curves over the clip, which the engine samples (query "sample").
//   ruler: click or drag to scrub          bar: drag to move, drag its right edge to retime
//   alt-drag: duplicate, then move         shift-click: add to the selection
//   drag on empty rows: box select         double-click a row: play from that key
import { btn, h, num } from "../dom.js";
import { dockSpanButtons } from "../layout.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { clone, drivenChannels, groupChannels } from "../model.js";

const LABEL = 172;
const RULER = 26;
const ROW = 24;
const CURVE = 40;
const SNAP = 0.01;

const snap = (/** @type {number} */ t) => Math.round(t / SNAP) * SNAP;
/** @param {string | undefined} e @param {number} t */
function easeShape(e, t) {
  if (e === "LINEAR") return t;
  if (e === "IN") return t * t;
  if (e === "OUT") return 1 - (1 - t) * (1 - t);
  return t * t * (3 - 2 * t);
}
const css = (/** @type {string} */ name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class Timeline {
  constructor() {
    this.canvas = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "timeline", tabIndex: 0 }));
    this.scroll = h("div", { class: "dock-scroll" }, this.canvas);
    this.bar = h("div", { class: "dock-bar" });
    this.el = [this.bar, this.scroll];
    this.timeLabel = h("span", { class: "time" });
    this.width = 800;
    /** @type {{row: number, edge: boolean} | null} */
    this.hover = null;
    /** @type {any} */
    this.drag = null;
    this.solved = false; // curves as the rig shows them (drivers and leg IK), or as the clip sets them
    this.keyPoseOpen = false;
    /** @type {Record<string, boolean>} */
    this.keyGroups = {};
    /** @type {{stamp: string, data: any} | null} */
    this.samples = null;
    this.version = 0;
    new ResizeObserver(() => {
      this.width = this.scroll.clientWidth;
      this.draw();
    }).observe(this.scroll);
    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    this.canvas.addEventListener("pointermove", (e) => this.move(e));
    this.canvas.addEventListener("pointerup", () => this.up());
    this.canvas.addEventListener("pointerleave", () => ((this.hover = null), this.draw()));
    this.canvas.addEventListener("dblclick", (e) => this.dbl(e));
  }

  get keys() {
    return editor.clipData?.keys ?? [];
  }

  get duration() {
    return Math.max(editor.clipData?.duration ?? 1, 0.01);
  }

  /** @param {number} t */
  xOf(t) {
    return LABEL + (t / this.duration) * (this.width - LABEL - 14);
  }

  /** @param {number} x */
  tOf(x) {
    return ((x - LABEL) / (this.width - LABEL - 14)) * this.duration;
  }

  // the channels the selected key holds, drawn as curves
  get curveChannels() {
    const k = this.keys[editor.keys[0]];
    const names = Object.keys(k?.values ?? {});
    return (editor.model.channels ?? []).filter((/** @type {any} */ c) => names.includes(c.name)).slice(0, 8);
  }

  // data changed: rebuild the toolbar and resample
  refresh() {
    this.version++;
    this.bar.replaceChildren(...this.toolbar().flat().filter((c) => c !== false && c !== null && c !== undefined && c !== ""));
    this.draw();
  }

  toolbar() {
    const clip = editor.clipData;
    const groups = groupChannels(editor.model.channels ?? [], drivenChannels(editor.model));
    const menu = this.keyPoseOpen
      ? h(
          "div",
          { class: "menu" },
          groups.map(([g, list]) => {
            const box = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: this.keyGroups[g] !== false }));
            box.addEventListener("change", () => (this.keyGroups[g] = box.checked));
            return h("label", null, box, g, h("span", { class: "muted" }, list.length));
          }),
          btn("Key", () => this.keyPose(groups), { kind: "primary" }),
        )
      : null;
    this.updateTime();
    return [
      btn(icon("start"), () => editor.seek(0), { kind: "icon", title: "To the start" }),
      btn(icon(editor.playing ? "pause" : "play"), () => editor.togglePlay(), { kind: "primary", title: editor.playing ? "Pause (space)" : "Play (space)" }),
      btn(icon("loop"), () => ((editor.loop = !editor.loop), editor.show(), this.refresh()), { on: editor.loop, title: editor.loop ? "Looping: click to play once" : "Playing once: click to loop" }),
      this.timeLabel,
      this.speedSelect(),
      h("span", { class: "sep" }),
      btn(icon("key"), () => this.addKey(), { title: "Add an empty key at the playhead", disabled: !clip }),
      h("div", { class: "pop" }, btn(icon("capture"), () => ((this.keyPoseOpen = !this.keyPoseOpen), this.refresh()), { on: this.keyPoseOpen, disabled: !clip, title: "Key the pose shown now at the playhead…" }), menu),
      btn(icon("copy"), () => this.duplicateSelected(), { kind: "icon", title: "Duplicate the selected keys (Cmd-D; alt-drag also duplicates)", disabled: !editor.keys.length }),
      btn(icon("trash"), () => this.deleteSelected(), { kind: "icon", title: "Delete the selected keys (Delete)", disabled: !editor.keys.length }),
      h("span", { class: "grow" }),
      btn(icon(this.solved ? "solved" : "curve"), () => ((this.solved = !this.solved), (this.samples = null), this.refresh()), {
        kind: "icon",
        on: this.solved,
        title: this.solved ? "Curves as the rig shows them (after drivers and leg IK): click for as keyed" : "Curves as the clip keys them: click for as shown (after drivers and leg IK)",
      }),
      clip && h("span", { class: "muted", title: "Clip length (s)" }, icon("clock")),
      clip && h("div", { style: { width: "84px", display: "flex" } }, num({ value: clip.duration ?? 1, step: 0.05, min: 0.05, onchange: (v) => editor.edit("anim", () => (clip.duration = v), "clip-duration") })),
      h("span", { class: "sep" }),
      dockSpanButtons(() => this.refresh()),
    ];
  }

  speedSelect() {
    const sel = /** @type {HTMLSelectElement} */ (h("select", { style: { flex: "0 0 auto" } }, [0.1, 0.25, 0.5, 1, 2].map((s) => h("option", { value: String(s) }, `${s}×`))));
    sel.value = String(editor.speed);
    sel.addEventListener("change", () => {
      editor.speed = parseFloat(sel.value);
      editor.show();
    });
    return sel;
  }

  updateTime() {
    this.timeLabel.innerHTML = `${editor.time.toFixed(2)} <span class="muted">/ ${this.duration.toFixed(2)} s</span>`;
  }

  // the playhead moved
  tick() {
    this.updateTime();
    this.draw();
  }

  sample() {
    const v = editor.viewer;
    const clip = editor.clipData;
    const chans = this.curveChannels;
    if (!v || !clip || !chans.length) return null;
    const n = Math.max(32, Math.min(400, Math.round((this.width - LABEL) / 3)));
    const stamp = `${this.version}:${editor.clip}:${n}:${this.solved}:${chans.map((/** @type {any} */ c) => c.name).join(",")}`;
    if (this.samples?.stamp !== stamp) this.samples = { stamp, data: v.query({ q: "sample", clip: clip.name, channels: chans.map((/** @type {any} */ c) => c.name), n, solved: this.solved }) };
    return this.samples.data;
  }

  draw() {
    const g = this.canvas.getContext("2d");
    if (!g || !editor.clipData) {
      this.canvas.style.display = editor.clipData ? "" : "none";
      return;
    }
    this.canvas.style.display = "";
    const keys = this.keys;
    const chans = this.curveChannels;
    const width = this.width;
    const height = RULER + Math.max(keys.length, 1) * ROW + (chans.length ? 8 + chans.length * CURVE : 0) + 8;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    this.canvas.style.height = `${height}px`;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const [bg, line, muted, text, accent, field, hover, dim] = ["--panel", "--line", "--muted", "--text", "--accent", "--field", "--hover", "--accent-dim"].map(css);
    g.fillStyle = bg;
    g.fillRect(0, 0, width, height);
    g.font = "11px system-ui";

    // ruler: ticks every 50 ms, labels every half second (or finer for short clips)
    g.fillStyle = field;
    g.fillRect(LABEL, 0, width - LABEL, RULER);
    const steps = Math.round(this.duration / 0.05);
    for (let i = 0; i <= steps; i++) {
      const t = i * 0.05;
      const x = Math.round(this.xOf(t)) + 0.5;
      const major = i % 10 === 0;
      const mid = i % 2 === 0;
      if (!mid && this.duration > 3) continue;
      g.strokeStyle = major ? muted : line;
      g.beginPath();
      g.moveTo(x, major ? 6 : mid ? 14 : 19);
      g.lineTo(x, RULER);
      g.stroke();
      if (major || (this.duration <= 1.2 && i % 4 === 0)) {
        g.fillStyle = muted;
        g.fillText(`${+t.toFixed(2)}s`, x + 3, 12);
      }
      g.globalAlpha = major ? 0.5 : 0.15;
      g.beginPath();
      g.moveTo(x, RULER);
      g.lineTo(x, height);
      g.stroke();
      g.globalAlpha = 1;
    }

    // key rows
    const maxP = Math.max(1, ...keys.map((/** @type {any} */ k) => k.priority ?? 0));
    keys.forEach((/** @type {any} */ k, /** @type {number} */ i) => {
      const y = RULER + i * ROW;
      const selected = editor.keys.includes(i);
      if (selected || i % 2) {
        g.fillStyle = selected ? dim : hover;
        g.fillRect(0, y, width, ROW);
      }
      g.fillStyle = selected ? text : muted;
      const nvals = Object.keys(k.values ?? {}).length;
      const what = [k.pose, nvals ? `${nvals} ch` : ""].filter(Boolean).join(" + ") || "empty";
      g.fillText(`${i}   p${k.priority ?? 0}   ${what}`.slice(0, 28), 10, y + 16);
      const x0 = this.xOf(k.at ?? 0);
      const x1 = Math.max(this.xOf((k.at ?? 0) + (k.duration ?? 0)), x0);
      const fill = `hsl(${205 - ((k.priority ?? 0) / maxP) * 165} 55% ${selected ? 60 : 45}%)`;
      g.fillStyle = fill;
      if (x1 - x0 < 3) {
        // a snap key: a diamond
        g.beginPath();
        g.moveTo(x0, y + 5);
        g.lineTo(x0 + 6, y + ROW / 2);
        g.lineTo(x0, y + ROW - 5);
        g.lineTo(x0 - 6, y + ROW / 2);
        g.closePath();
        g.fill();
      } else {
        g.beginPath();
        g.roundRect(x0, y + 4, x1 - x0, ROW - 8, 3);
        g.fill();
        g.strokeStyle = "rgba(0,0,0,0.45)";
        g.lineWidth = 1.5;
        g.beginPath();
        for (let s = 0; s <= 24; s++) {
          const u = s / 24;
          const px = x0 + u * (x1 - x0);
          const py = y + ROW - 6 - easeShape(k.ease, u) * (ROW - 12);
          s ? g.lineTo(px, py) : g.moveTo(px, py);
        }
        g.stroke();
        g.lineWidth = 1;
        if (k.blend === "ADDITIVE") {
          g.fillStyle = "rgba(0,0,0,0.65)";
          g.fillText("+", x0 + 4, y + 15);
        }
        if (this.hover?.row === i && this.hover.edge) {
          g.fillStyle = text;
          g.fillRect(x1 - 2, y + 4, 3, ROW - 8);
        }
      }
      if (selected) {
        g.strokeStyle = text;
        g.strokeRect(Math.round(x0) - 0.5, y + 3.5, Math.max(x1 - x0, 1) + 1, ROW - 7);
      }
    });

    // the selected key's channels over the clip
    const s = this.sample();
    if (s?.channels) {
      const top = RULER + Math.max(keys.length, 1) * ROW + 8;
      chans.forEach((/** @type {any} */ c, /** @type {number} */ r) => {
        const values = s.channels[c.name];
        if (!values) return;
        const y = top + r * CURVE;
        g.strokeStyle = line;
        g.beginPath();
        g.moveTo(0, y + 0.5);
        g.lineTo(width, y + 0.5);
        g.stroke();
        g.fillStyle = muted;
        g.fillText(c.name, 10, y + 15);
        let lo = Math.min(...values);
        let hi = Math.max(...values);
        if (hi - lo < 1e-3) [lo, hi] = [lo - 1, hi + 1];
        g.fillText(hi.toFixed(1), LABEL - 42, y + 12);
        g.fillText(lo.toFixed(1), LABEL - 42, y + CURVE - 4);
        g.strokeStyle = accent;
        g.lineWidth = 1.5;
        g.beginPath();
        values.forEach((/** @type {number} */ val, /** @type {number} */ k) => {
          const px = this.xOf(s.times[k]);
          const py = y + CURVE - 5 - ((val - lo) / (hi - lo)) * (CURVE - 10);
          k ? g.lineTo(px, py) : g.moveTo(px, py);
        });
        g.stroke();
        g.lineWidth = 1;
      });
    }

    // the playhead
    const px = Math.round(this.xOf(editor.time)) + 0.5;
    g.strokeStyle = g.fillStyle = "#5bb8ff";
    g.beginPath();
    g.moveTo(px, 0);
    g.lineTo(px, height);
    g.stroke();
    g.beginPath();
    g.moveTo(px - 5, 0);
    g.lineTo(px + 5, 0);
    g.lineTo(px, 7);
    g.fill();

    if (this.drag?.mode === "box") {
      const d = this.drag;
      g.strokeStyle = accent;
      g.setLineDash([3, 3]);
      g.strokeRect(Math.min(d.x0, d.x), Math.min(d.y0, d.y), Math.abs(d.x - d.x0), Math.abs(d.y - d.y0));
      g.setLineDash([]);
    }
  }

  // ---- pointer --------------------------------------------------------------------------------

  /** @param {number} x @param {number} y */
  hit(x, y) {
    const row = Math.floor((y - RULER) / ROW);
    if (y < RULER || row < 0 || row >= this.keys.length) return { row: -1, onBar: false, edge: false };
    const k = this.keys[row];
    const x0 = this.xOf(k.at ?? 0);
    const x1 = Math.max(this.xOf((k.at ?? 0) + (k.duration ?? 0)), x0);
    return { row, onBar: x >= x0 - 6 && x <= x1 + 5, edge: x1 - x0 >= 3 && Math.abs(x - x1) <= 5 };
  }

  /** @param {MouseEvent} e */
  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** @param {PointerEvent} e */
  down(e) {
    const { x, y } = this.pos(e);
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.focus();
    if (y < RULER && x >= LABEL) {
      this.drag = { mode: "scrub" };
      editor.seek(this.tOf(x));
      return;
    }
    const hit = this.hit(x, y);
    if (hit.row < 0 || (!hit.onBar && x >= LABEL)) {
      if (!e.shiftKey) editor.select(() => (editor.keys = []));
      this.drag = { mode: "box", x0: x, y0: y, x, y, base: e.shiftKey ? [...editor.keys] : [] };
      return;
    }
    editor.select(() => {
      if (e.shiftKey) editor.keys = editor.keys.includes(hit.row) ? editor.keys.filter((k) => k !== hit.row) : [...editor.keys, hit.row];
      else if (!editor.keys.includes(hit.row)) editor.keys = [hit.row];
      editor.showPose = false;
    });
    if (x < LABEL) return;
    if (e.altKey) this.duplicateSelected();
    this.drag = {
      mode: hit.edge ? "resize" : "move",
      x0: x,
      sel: [...editor.keys],
      orig: editor.keys.map((i) => ({ at: this.keys[i].at ?? 0, duration: this.keys[i].duration ?? 0 })),
      id: `timeline-${performance.now()}`,
    };
  }

  /** @param {PointerEvent} e */
  move(e) {
    const { x, y } = this.pos(e);
    const d = this.drag;
    if (!d) {
      const hit = this.hit(x, y);
      const hover = hit.row >= 0 && x >= LABEL ? { row: hit.row, edge: hit.edge } : null;
      if (JSON.stringify(hover) !== JSON.stringify(this.hover)) {
        this.hover = hover;
        this.draw();
      }
      this.canvas.style.cursor = y < RULER && x >= LABEL ? "text" : hit.edge ? "ew-resize" : hit.onBar ? "grab" : "default";
      return;
    }
    if (d.mode === "scrub") return editor.seek(this.tOf(x));
    if (d.mode === "box") {
      d.x = x;
      d.y = y;
      const [ya, yb] = [Math.min(d.y0, y), Math.max(d.y0, y)];
      const [ta, tb] = [this.tOf(Math.min(d.x0, x)), this.tOf(Math.max(d.x0, x))];
      const inBox = this.keys.flatMap((/** @type {any} */ k, /** @type {number} */ i) => {
        const ky = RULER + i * ROW + ROW / 2;
        const a = k.at ?? 0;
        const b = a + (k.duration ?? 0);
        return ky >= ya && ky <= yb && b >= ta && a <= tb ? [i] : [];
      });
      editor.select(() => (editor.keys = [...new Set([...d.base, ...inBox])]));
      return;
    }
    const dt = snap(this.tOf(x) - this.tOf(d.x0));
    editor.edit(
      "anim",
      () => {
        const ks = editor.clipData.keys;
        d.sel.forEach((/** @type {number} */ i, /** @type {number} */ n) => {
          const o = d.orig[n];
          if (d.mode === "move") ks[i].at = Math.max(0, snap(o.at + dt));
          else ks[i].duration = Math.max(0, snap(o.duration + dt));
        });
      },
      d.id,
    );
  }

  up() {
    this.drag = null;
    this.draw();
  }

  /** @param {MouseEvent} e */
  dbl(e) {
    const { x, y } = this.pos(e);
    const hit = this.hit(x, y);
    if (hit.row < 0) return;
    editor.seek(this.keys[hit.row].at ?? 0);
    editor.togglePlay();
  }

  // ---- key commands ---------------------------------------------------------------------------

  duplicateSelected() {
    if (!editor.keys.length) return;
    const sel = [...editor.keys];
    editor.edit("anim", () => {
      const ks = editor.clipData.keys;
      const copies = sel.map((i) => clone(ks[i]));
      ks.push(...copies);
      editor.keys = copies.map((_, n) => ks.length - copies.length + n);
    });
  }

  deleteSelected() {
    if (!editor.keys.length) return;
    const sel = new Set(editor.keys);
    editor.edit("anim", () => {
      const c = editor.clipData;
      c.keys = (c.keys ?? []).filter((/** @type {any} */ _, /** @type {number} */ i) => !sel.has(i));
      editor.keys = [];
    });
  }

  /** @type {any[]} keys copied with copyKeys, their times relative to the first */
  static clipboard = [];

  copyKeys() {
    const ks = editor.keys.map((i) => this.keys[i]).filter(Boolean);
    const first = Math.min(...ks.map((k) => k.at ?? 0));
    Timeline.clipboard = ks.map((k) => ({ ...clone(k), at: (k.at ?? 0) - first }));
  }

  pasteKeys() {
    if (!Timeline.clipboard.length || !editor.clipData) return;
    editor.edit("anim", () => {
      const c = editor.clipData;
      c.keys ??= [];
      const pasted = Timeline.clipboard.map((k) => ({ ...clone(k), at: snap(editor.time + k.at) }));
      c.keys.push(...pasted);
      editor.keys = pasted.map((_, n) => c.keys.length - pasted.length + n);
    });
  }

  addKey() {
    editor.edit("anim", () => {
      const c = editor.clipData;
      c.keys ??= [];
      c.keys.push({ at: snap(editor.time), duration: 0.2, priority: Math.max(0, ...c.keys.map((/** @type {any} */ k) => k.priority ?? 0)) + 1, values: {} });
      editor.keys = [c.keys.length - 1];
    });
  }

  /** @param {[string, any[]][]} groups */
  keyPose(groups) {
    const shown = editor.shown();
    /** @type {Record<string, number>} */
    const values = {};
    for (const [g, list] of groups) if (this.keyGroups[g] !== false) for (const c of list) values[c.name] = Math.round((shown[c.name] ?? 0) * 100) / 100;
    this.keyPoseOpen = false;
    editor.edit("anim", () => {
      const c = editor.clipData;
      c.keys ??= [];
      c.keys.push({ at: snap(editor.time), duration: 0.2, priority: Math.max(0, ...c.keys.map((/** @type {any} */ k) => k.priority ?? 0)) + 1, values });
      editor.keys = [c.keys.length - 1];
    });
  }
}
