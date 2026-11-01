// @ts-check
// The timeline: a ruler with the playhead, then one row per channel the clip keys (grouped, a
// group folds to one row), under an "all keys" row. A key shows on every row it sets: a ramp from
// `at` across its `duration` (the time it takes to blend in), then a diamond where it lands. Time scrolls sideways; the ruler and
// the labels stay put.
//   ruler: click or drag to scrub          diamond or ramp: drag to move the key
//   ramp's start: drag to retime it        alt-drag: duplicate, then move
//   shift-click: add to the selection      drag on empty space: box select
//   double-click: play from that key       cmd/ctrl-wheel: zoom time
import { btn, h, num } from "../dom.js";
import { dockSpanButtons } from "../layout.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { clone, groupDrivers } from "../model.js";

const LABEL = 172;
const RULER = 26;
const ROW = 22;
const PAD = 24; // room after the clip's end
const SNAP = 0.01;

const snap = (/** @type {number} */ t) => Math.round(t / SNAP) * SNAP;
const css = (/** @type {string} */ name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** @typedef {{kind: "all"} | {kind: "group", name: string, channels: string[], open: boolean} | {kind: "channel", name: string}} Row */

export class Timeline {
  constructor() {
    this.canvas = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "timeline", tabIndex: 0 }));
    // the spacer is as big as every row across the clip; the canvas sticks to the view over it
    this.spacer = h("div", { class: "timeline-space" }, this.canvas);
    this.scroll = h("div", { class: "dock-scroll" }, this.spacer);
    this.bar = h("div", { class: "dock-bar" });
    this.el = [this.bar, this.scroll];
    this.timeLabel = h("span", { class: "time" });
    this.width = 800;
    this.height = 200;
    /** @type {number | null} pixels per second; null fits the clip to the view */
    this.pps = null;
    /** @type {{row: number, key: number, ramp: boolean} | null} */
    this.hover = null;
    /** @type {any} */
    this.drag = null;
    this.keyPoseOpen = false;
    /** @type {Record<string, boolean>} driver groups the capture menu keys */
    this.keyGroups = {};
    /** @type {Record<string, boolean>} groups folded to one row */
    this.folded = {};
    /** @type {{stamp: string, data: {name: string, channels: Set<string>} | null} | null} */
    this.moves = null;
    this.version = 0;
    new ResizeObserver(() => {
      this.width = this.scroll.clientWidth;
      this.height = this.scroll.clientHeight;
      this.draw();
    }).observe(this.scroll);
    this.scroll.addEventListener("scroll", () => this.draw());
    this.scroll.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    this.canvas.addEventListener("pointermove", (e) => this.move(e));
    this.canvas.addEventListener("pointerup", () => this.up());
    this.canvas.addEventListener("pointerleave", () => ((this.hover = null), this.draw()));
    this.canvas.addEventListener("dblclick", (e) => this.dbl(e));
  }

  get keys() {
    return editor.clipData?.keys ?? [];
  }

  // the part selected in the view (animate tab): its name and the channels that move it, by the
  // engine (query "moves"); null with none
  get moving() {
    // an IK target or pole selected in the view: its three channels
    const hd = editor.tab === "animation" ? editor.handle : "";
    if (hd && hd !== "root") {
      const base = hd.endsWith(" pole") ? `${hd.slice(0, -5)}_pole` : hd;
      return { name: hd, channels: new Set(["x", "y", "z"].map((x) => `${base}_${x}`)), handle: true };
    }
    const inst = editor.tab === "animation" ? editor.model.assembly?.[editor.part] : undefined;
    if (!inst || !editor.viewer) return null;
    const stamp = `${this.version}:${inst.name}`;
    if (this.moves?.stamp !== stamp) {
      const a = editor.viewer.query({ q: "moves", part: inst.name });
      this.moves = { stamp, data: a?.channels ? { name: inst.name, channels: new Set(a.channels) } : null };
    }
    return this.moves.data;
  }

  // the channels the clip keys, in the model's order (drivers, then the root's), grouped; with a
  // part selected, only those moving it
  get channels() {
    const keyed = new Set(this.keys.flatMap((/** @type {any} */ k) => Object.keys(k.values ?? {})));
    const root = editor.rootChannels();
    const m = this.moving;
    const all = [...(editor.model.drivers ?? []).map((/** @type {any} */ d) => d.name), ...root.move, ...root.turn];
    const known = new Set(all);
    // names the model lacks still show, last, so their keys can be found and removed
    const names = [...all, ...[...keyed].filter((n) => !known.has(n))].filter((n) => keyed.has(n) && (!m || m.channels.has(n)));
    return groupDrivers(names.map((name) => ({ name })));
  }

  /** @returns {Row[]} */
  get rows() {
    /** @type {Row[]} */
    const rows = [{ kind: "all" }];
    for (const [g, list] of this.channels) {
      const open = !this.folded[g];
      rows.push({ kind: "group", name: g, channels: list.map((/** @type {any} */ c) => c.name), open });
      if (open) for (const c of list) rows.push({ kind: "channel", name: c.name });
    }
    return rows;
  }

  // whether key `k` shows on `row`
  /** @param {any} k @param {Row} row */
  sets(k, row) {
    if (row.kind === "all") return true;
    const v = k.values ?? {};
    return row.kind === "group" ? row.channels.some((c) => c in v) : row.name in v;
  }

  get duration() {
    return Math.max(editor.clipData?.duration ?? 1, 0.01);
  }

  get fit() {
    return Math.max((this.width - LABEL - PAD) / this.duration, 1);
  }

  get scale() {
    return this.pps ?? this.fit;
  }

  /** @param {number} t view x of time t */
  xOf(t) {
    return LABEL + t * this.scale - this.scroll.scrollLeft;
  }

  /** @param {number} x */
  tOf(x) {
    return (x - LABEL + this.scroll.scrollLeft) / this.scale;
  }

  /** @param {number} r view y of row r's top */
  yOf(r) {
    return RULER + r * ROW - this.scroll.scrollTop;
  }

  // data changed: rebuild the toolbar and redraw
  refresh() {
    this.version++;
    this.bar.replaceChildren(...this.toolbar().flat().filter((c) => c !== false && c !== null && c !== undefined && c !== ""));
    this.draw();
  }

  toolbar() {
    const clip = editor.clipData;
    // the drivers and the root's channels (a group of their own)
    const root = editor.rootChannels();
    const groups = groupDrivers([...(editor.model.drivers ?? []), ...[...root.move, ...root.turn].map((name) => ({ name }))]);
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
      h("span", { class: "sep" }),
      btn(icon("zoomOut"), () => this.zoom(1 / 1.5), { kind: "icon", title: "Zoom out (cmd/ctrl-wheel)" }),
      btn(icon("frame"), () => ((this.pps = null), this.draw()), { kind: "icon", title: "Fit the clip", on: this.pps === null }),
      btn(icon("zoomIn"), () => this.zoom(1.5), { kind: "icon", title: "Zoom in (cmd/ctrl-wheel)" }),
      h("span", { class: "grow" }),
      this.moving && h("span", { class: "muted", title: "Only the channels that move what is selected in the view" }, this.moving.handle ? `channels of ${this.moving.name}` : `channels moving ${this.moving.name}`),
      this.moving && btn(icon("x"), () => editor.select(() => (this.moving?.handle ? (editor.handle = "") : (editor.part = -1))), { kind: "icon", title: "Show every channel" }),
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

  // the playhead moved: keep it in view while playing
  tick() {
    this.updateTime();
    const x = this.xOf(editor.time);
    if (editor.playing && (x < LABEL || x > this.width - 8)) this.scroll.scrollLeft = Math.max(0, editor.time * this.scale - 24);
    this.draw();
  }

  /** zoom time by `factor`, keeping the time at view x `x` (default: the playhead) in place @param {number} factor @param {number} [x] */
  zoom(factor, x) {
    const at = x ?? Math.min(Math.max(this.xOf(editor.time), LABEL), this.width);
    const t = this.tOf(at);
    this.pps = Math.min(Math.max(this.scale * factor, Math.min(this.fit, 20)), 4000);
    if (Math.abs(this.pps - this.fit) < 1e-3) this.pps = null;
    this.layout();
    this.scroll.scrollLeft = Math.max(0, LABEL + t * this.scale - at);
    this.refresh();
  }

  /** @param {WheelEvent} e */
  wheel(e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    this.zoom(Math.exp(-e.deltaY * 0.01), e.clientX - this.scroll.getBoundingClientRect().left);
  }

  // sizes the spacer to every row across the clip, and the canvas to the view
  layout() {
    const rows = this.rows.length;
    this.spacer.style.width = `${LABEL + this.duration * this.scale + PAD}px`;
    this.spacer.style.height = `${RULER + rows * ROW + 8}px`;
    return rows;
  }

  draw() {
    const g = this.canvas.getContext("2d");
    if (!g || !editor.clipData) {
      this.canvas.style.display = editor.clipData ? "" : "none";
      return;
    }
    this.canvas.style.display = "";
    const keys = this.keys;
    const rows = this.rows;
    this.layout();
    const width = this.width;
    const height = Math.max(this.height, 1);
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const [bg, line, muted, text, accent, field, hover, dim] = ["--panel", "--line", "--muted", "--text", "--accent", "--field", "--hover", "--accent-dim"].map(css);
    g.fillStyle = bg;
    g.fillRect(0, 0, width, height);
    g.font = "11px system-ui";
    const end = this.xOf(this.duration);

    // rows: stripes, the selection's band, labels later (over the lanes)
    g.save();
    g.beginPath();
    g.rect(0, RULER, width, height - RULER);
    g.clip();
    rows.forEach((row, r) => {
      const y = this.yOf(r);
      if (y + ROW < RULER || y > height) return;
      if (row.kind !== "channel" || r % 2) {
        g.fillStyle = row.kind === "channel" ? hover : field;
        g.fillRect(0, y, width, ROW);
      }
    });
    // past the clip's end
    if (end < width) {
      g.fillStyle = "rgba(0,0,0,0.18)";
      g.fillRect(Math.max(end, LABEL), RULER, width - end, height - RULER);
    }

    // the lanes: grid and keys, clipped right of the labels
    g.save();
    g.beginPath();
    g.rect(LABEL, RULER, width - LABEL, height - RULER);
    g.clip();
    const step = this.tickStep();
    for (let t = Math.ceil(this.tOf(LABEL) / step) * step; t <= Math.min(this.tOf(width), this.duration); t += step) {
      const x = Math.round(this.xOf(t)) + 0.5;
      g.strokeStyle = line;
      g.globalAlpha = Math.abs(t / (step * 5) - Math.round(t / (step * 5))) < 1e-6 ? 0.6 : 0.25;
      g.beginPath();
      g.moveTo(x, RULER);
      g.lineTo(x, height);
      g.stroke();
    }
    g.globalAlpha = 1;

    // keys, earliest first so later ones (which win) draw on top
    const hov = this.hover;
    const order = keys.map((/** @type {any} */ _, /** @type {number} */ i) => i).sort((/** @type {number} */ a, /** @type {number} */ b) => (keys[a].at ?? 0) - (keys[b].at ?? 0));
    rows.forEach((row, r) => {
      const y = this.yOf(r);
      if (y + ROW < RULER || y > height) return;
      const mid = y + ROW / 2;
      for (const i of order) {
        const k = keys[i];
        if (!this.sets(k, row)) continue;
        const selected = editor.keys.includes(i);
        const x0 = this.xOf(k.at ?? 0);
        const x1 = Math.max(this.xOf((k.at ?? 0) + (k.duration ?? 0)), x0);
        if (x1 < LABEL - 8 || x0 > width + 8) continue;
        const color = row.kind === "channel" ? (selected ? text : accent) : selected ? text : muted;
        // the ramp, leading to the diamond
        if (x1 - x0 >= 2) {
          g.fillStyle = selected ? dim : "rgba(91,184,255,0.12)";
          g.fillRect(x0, y + 4, x1 - x0, ROW - 8);
          if (hov && hov.key === i && hov.ramp) {
            g.fillStyle = text;
            g.fillRect(x0 - 1, y + 3, 3, ROW - 6);
          }
        }
        const rad = row.kind === "channel" ? 5 : 4;
        g.fillStyle = color;
        g.beginPath();
        g.moveTo(x1, mid - rad);
        g.lineTo(x1 + rad, mid);
        g.lineTo(x1, mid + rad);
        g.lineTo(x1 - rad, mid);
        g.closePath();
        g.fill();
        if (selected || (hov && hov.key === i && !hov.ramp)) {
          g.strokeStyle = selected ? bg : text;
          g.stroke();
        }
      }
    });
    g.restore();

    // labels
    g.fillStyle = bg;
    g.fillRect(0, RULER, LABEL, height - RULER);
    rows.forEach((row, r) => {
      const y = this.yOf(r);
      if (y + ROW < RULER || y > height) return;
      if (row.kind !== "channel" || r % 2) {
        g.fillStyle = row.kind === "channel" ? hover : field;
        g.fillRect(0, y, LABEL, ROW);
      }
      g.fillStyle = row.kind === "channel" ? muted : text;
      const label = row.kind === "all" ? `all keys  (${keys.length})` : row.kind === "group" ? `${row.open ? "▾" : "▸"} ${row.name}  (${row.channels.length})` : row.name;
      g.fillText(label.slice(0, 26), row.kind === "channel" ? 24 : 8, y + 15);
    });
    g.strokeStyle = line;
    g.beginPath();
    g.moveTo(LABEL + 0.5, RULER);
    g.lineTo(LABEL + 0.5, height);
    g.stroke();
    g.restore();

    // ruler
    g.fillStyle = bg;
    g.fillRect(0, 0, LABEL, RULER);
    g.fillStyle = field;
    g.fillRect(LABEL, 0, width - LABEL, RULER);
    g.save();
    g.beginPath();
    g.rect(LABEL, 0, width - LABEL, RULER);
    g.clip();
    const minor = step / 5;
    for (let t = Math.ceil(this.tOf(LABEL) / minor) * minor; t <= Math.min(this.tOf(width), this.duration) + 1e-6; t += minor) {
      const x = Math.round(this.xOf(t)) + 0.5;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      g.strokeStyle = major ? muted : line;
      g.beginPath();
      g.moveTo(x, major ? 6 : 17);
      g.lineTo(x, RULER);
      g.stroke();
      if (major) {
        g.fillStyle = muted;
        g.fillText(`${+t.toFixed(3)}s`, x + 3, 12);
      }
    }
    g.restore();
    g.strokeStyle = line;
    g.beginPath();
    g.moveTo(0, RULER - 0.5);
    g.lineTo(width, RULER - 0.5);
    g.stroke();

    // the playhead
    const px = Math.round(this.xOf(editor.time)) + 0.5;
    if (px >= LABEL) {
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
    }

    if (this.drag?.mode === "box") {
      const d = this.drag;
      g.strokeStyle = accent;
      g.setLineDash([3, 3]);
      g.strokeRect(Math.min(d.x0, d.x), Math.min(d.y0, d.y), Math.abs(d.x - d.x0), Math.abs(d.y - d.y0));
      g.setLineDash([]);
    }
  }

  // seconds between labelled ticks: about every 80 pixels, on a 1-2-5 step
  tickStep() {
    const want = 80 / this.scale;
    const p = Math.pow(10, Math.floor(Math.log10(want)));
    return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= want) ?? 10 * p;
  }

  // ---- pointer --------------------------------------------------------------------------------

  /** @param {number} y */
  rowAt(y) {
    const r = Math.floor((y - RULER + this.scroll.scrollTop) / ROW);
    return y < RULER || r < 0 || r >= this.rows.length ? -1 : r;
  }

  // the key under (x, y): the latest-starting one on that row (it wins), a selected one first;
  // `ramp` on the start of its ramp
  /** @param {number} x @param {number} y */
  hit(x, y) {
    const r = this.rowAt(y);
    if (r < 0 || x < LABEL) return { row: r, key: -1, ramp: false };
    const row = this.rows[r];
    const keys = this.keys;
    let best = -1;
    let ramp = false;
    keys.forEach((/** @type {any} */ k, /** @type {number} */ i) => {
      if (!this.sets(k, row)) return;
      const x0 = this.xOf(k.at ?? 0);
      const x1 = Math.max(this.xOf((k.at ?? 0) + (k.duration ?? 0)), x0);
      if (x < x0 - 5 || x > x1 + 6) return;
      const better = best < 0 || (editor.keys.includes(i) && !editor.keys.includes(best)) || (editor.keys.includes(i) === editor.keys.includes(best) && (k.at ?? 0) >= (keys[best].at ?? 0));
      if (!better) return;
      best = i;
      ramp = x1 - x0 >= 12 && Math.abs(x - x0) <= 5;
    });
    return { row: r, key: best, ramp };
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
      editor.seek(Math.max(0, this.tOf(x)));
      return;
    }
    const hit = this.hit(x, y);
    if (x < LABEL) {
      // a group's label folds it
      const row = this.rows[hit.row];
      if (row?.kind === "group") {
        this.folded[row.name] = row.open;
        this.draw();
      }
      return;
    }
    if (hit.key < 0) {
      if (!e.shiftKey) editor.select(() => (editor.keys = []));
      this.drag = { mode: "box", x0: x, y0: y, x, y, base: e.shiftKey ? [...editor.keys] : [] };
      return;
    }
    // a drag from a channel or group row moves only that row's values, unless several keys are
    // selected (a column) or it starts on the "all keys" row
    const row = this.rows[hit.row];
    const whole = row.kind === "all" || e.shiftKey || (editor.keys.length > 1 && editor.keys.includes(hit.key));
    const only = whole ? null : row.kind === "group" ? row.channels : row.kind === "channel" ? [row.name] : null;
    editor.select(() => {
      if (e.shiftKey) editor.keys = editor.keys.includes(hit.key) ? editor.keys.filter((k) => k !== hit.key) : [...editor.keys, hit.key];
      else if (!editor.keys.includes(hit.key)) editor.keys = [hit.key];
    });
    // show the pose where the key lands, so editing its values shows in the view
    if (!e.shiftKey) editor.seek((this.keys[hit.key].at ?? 0) + (this.keys[hit.key].duration ?? 0));
    if (e.altKey) this.duplicateSelected();
    this.drag = {
      mode: hit.ramp ? "ramp" : "move",
      only,
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
      const hover = hit.key >= 0 ? hit : null;
      if (JSON.stringify(hover) !== JSON.stringify(this.hover)) {
        this.hover = hover;
        this.draw();
      }
      const group = x < LABEL && this.rows[hit.row]?.kind === "group";
      this.canvas.style.cursor = y < RULER && x >= LABEL ? "text" : group ? "pointer" : hit.ramp ? "ew-resize" : hit.key >= 0 ? "grab" : "default";
      return;
    }
    if (d.mode === "scrub") return editor.seek(Math.max(0, this.tOf(x)));
    if (d.mode === "box") {
      d.x = x;
      d.y = y;
      const [ra, rb] = [this.rowAt(Math.max(Math.min(d.y0, y), RULER)), this.rowAt(Math.max(d.y0, y))];
      const [ta, tb] = [this.tOf(Math.min(d.x0, x)), this.tOf(Math.max(d.x0, x))];
      const rows = this.rows;
      const inBox = this.keys.flatMap((/** @type {any} */ k, /** @type {number} */ i) => {
        const a = k.at ?? 0;
        const b = a + (k.duration ?? 0);
        if (b < ta || a > tb) return [];
        for (let r = Math.max(ra, 0); r <= (rb < 0 ? rows.length - 1 : rb); r++) if (this.sets(k, rows[r])) return [i];
        return [];
      });
      editor.select(() => (editor.keys = [...new Set([...d.base, ...inBox])]));
      return;
    }
    const dt = snap(this.tOf(x) - this.tOf(d.x0));
    editor.edit(
      "anim",
      () => {
        const ks = editor.clipData.keys;
        // first movement: the row's values leave their key for one of their own, which moves
        if (d.only && dt !== 0 && d.sel.length === 1) {
          const src = ks[d.sel[0]];
          const vals = src.values ?? {};
          const names = d.only.filter((/** @type {string} */ c) => c in vals);
          if (names.length && names.length < Object.keys(vals).length) {
            const part = { ...src, values: Object.fromEntries(names.map((/** @type {string} */ c) => [c, vals[c]])) };
            for (const c of names) delete vals[c];
            ks.push(part);
            d.sel = [ks.length - 1];
            editor.keys = [...d.sel];
          }
          d.only = null;
        }
        d.sel.forEach((/** @type {number} */ i, /** @type {number} */ n) => {
          const o = d.orig[n];
          if (d.mode === "move") ks[i].at = Math.max(0, snap(o.at + dt));
          else {
            // the ramp's start moves; where the key lands stays
            const end = o.at + o.duration;
            ks[i].at = Math.min(Math.max(0, snap(o.at + dt)), end);
            ks[i].duration = snap(end - ks[i].at);
          }
        });
      },
      d.id,
    );
  }

  up() {
    const d = this.drag;
    this.drag = null;
    if (d?.sel && (d.mode === "move" || d.mode === "ramp")) this.merge(d);
    this.draw();
  }

  // a dragged key that landed on another with the same start and ramp joins it: its values go
  // into that key (the dragged ones win) and it is removed
  /** @param {any} d */
  merge(d) {
    const ks = editor.clipData?.keys;
    if (!ks) return;
    const same = (/** @type {any} */ a, /** @type {any} */ b) => Math.abs((a.at ?? 0) - (b.at ?? 0)) < 1e-6 && Math.abs((a.duration ?? 0) - (b.duration ?? 0)) < 1e-6;
    const moved = d.sel.map((/** @type {number} */ i) => ks[i]).filter(Boolean);
    const pairs = moved.flatMap((/** @type {any} */ k) => {
      const into = ks.find((/** @type {any} */ o) => o !== k && !moved.includes(o) && same(o, k));
      return into ? [[k, into]] : [];
    });
    if (!pairs.length) return;
    editor.edit(
      "anim",
      () => {
        for (const [k, into] of pairs) Object.assign((into.values ??= {}), k.values ?? {});
        const gone = new Set(pairs.map((/** @type {any} */ p) => p[0]));
        const kept = [...new Set(pairs.map((/** @type {any} */ p) => p[1]))];
        editor.clipData.keys = ks.filter((/** @type {any} */ k) => !gone.has(k));
        editor.keys = kept.map((k) => editor.clipData.keys.indexOf(k));
      },
      d.id,
    );
  }

  /** @param {MouseEvent} e */
  dbl(e) {
    const { x, y } = this.pos(e);
    const hit = this.hit(x, y);
    if (hit.key < 0) return;
    editor.seek(this.keys[hit.key].at ?? 0);
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

  /** @param {Record<string, number>} values */
  addKey(values = {}) {
    editor.edit("anim", () => {
      const c = editor.clipData;
      c.keys ??= [];
      c.keys.push({ at: snap(editor.time), duration: 0.2, values });
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
    this.addKey(values);
  }
}
