// @ts-check
// The editor's state: the open character's model and animation (plain data, as in the files),
// what is selected, playback, undo. Every edit goes through `edit`, which records undo and sends
// the changed data to the viewer (the game's own code, in wasm). Views listen with `on`.

import { listCharacters, readFile } from "./api.js";
import { eulerFrom, fromQuat, mul, transpose } from "./math3.js";
import { addValue, clone, setDofsSource, uniqueName, zipValue } from "./model.js";
import { blankCharacter, exportFile, loadLocal, localNames, pickFile, saveLocal } from "./store.js";
import { Viewer } from "./viewer.js";

/** the scale of the model the model tab shows (editor.alone): model units, as the part is written */
export const ALONE_SCALE = 1;

/** @typedef {"model" | "assemble" | "animation"} Tab */
/** @typedef {"character" | "part" | "material" | "ik" | "arc"} Inspect */
/** @typedef {"data" | "select" | "time" | "status"} Change */

class Editor {
  constructor() {
    /** @type {Viewer | null} */
    this.viewer = null;
    this.status = "Starting the viewer…";
    /** @type {{name: string, local: boolean, files: import("./api.js").CharacterFiles | null}[]} saved in this browser, or in assets/ */
    this.characters = [];
    /** @type {string} the open character's name */
    this.current = "";
    /** @type {import("./api.js").CharacterFiles[]} the characters in assets/ */
    this.assets = [];
    /** @type {any} */
    this.model = {};
    /** @type {any} */
    this.anim = {};
    /** @type {Tab} */
    this.tab = "model";
    this.modelDirty = false;
    this.animDirty = false;
    /** @type {string[]} */
    this.messages = [];
    this.toast = "";

    // model tab: a library part, shown alone, its shape and slot
    this.def = 0;
    this.shape = -1;
    this.slot = -1;
    /** @type {string} what the view's handles move in the assemble and animate tabs: "root", an IK target's name, an arc's point (gizmo.arcHandle), or "" */
    this.handle = "";
    /** @type {number[]} shapes selected with the selected one (shift-click) */
    this.also = [];
    /** @type {any[]} shapes copied (Cmd-C) */
    this.clipShapes = [];
    this.joint = -1; // of the joints the part hangs by, the one selected (the joint tool)
    /** @type {Record<string, import("./model.js").Value>} the part's joints tried, never saved: by their channels (jointChannel) */
    this.tries = {};
    // joints' channels are named as the engine has them
    setDofsSource((j) => this.viewer?.query({ q: "dofs", joint: j }) ?? null);
    this.explode = 0; // the part's shapes pushed apart, 0 to 1
    this.mirrored = false; // preview the part as a mirrored instance shows it (the right side)
    this.grid = localStorage.getItem("grid") !== "off"; // the grid in the view, through the origin
    /** @type {"hidden" | "point" | "label"} IK targets and poles in the view (assemble and animate tabs), kept in this browser */
    this.ikShow = /** @type {any} */ (localStorage.getItem("ikShow")) || "point";
    // assemble tab
    /** @type {Inspect} */
    this.inspect = "character";
    this.part = -1; // an instance of the assembly
    this.material = -1;
    this.ik = -1;
    /** @type {string} the arc being edited (Animation.arcs), "" for none */
    this.arc = "";
    /** @type {string} the position the edited arc is shown on when the motion shown doesn't use it */
    this.arcOn = "";
    /** @type {string} the pose picked in the Poses list (Animation.poses), "" for none */
    this.pose = "";
    /** @type {Record<string, import("./model.js").Value>} the pose test: channel values tried on the rest pose */
    this.test = {};

    // animation
    this.clip = 0;
    this.time = 0;
    this.playing = false;
    this.speed = 1;
    this.loop = true;
    /** the clip's motion the curve editor and the inspector show: the last picked */
    this.motion = 0;
    /** @type {number[]} the clip's motions picked, in the order picked (pickedMotions) */
    this.picked = [];
    /** @type {number[]} the shown motion's moves picked (pickedMoves) */
    this.moves = [];
    /** @type {number[]} the shown motion's moves unfolded in the inspector (folded, a move shows its channels' names only) */
    this.openMoves = [];
    /** only the picked motions play: the clip's other motions are left out */
    this.isolate = false;

    /** @type {{model: string, anim: string}[]} */
    this.undoStack = [];
    /** @type {{model: string, anim: string}[]} */
    this.redoStack = [];
    this.lastEdit = { key: "", at: 0 };
    // the data as last loaded or saved, to tell whether an undo made it clean again
    this.saved = { model: "", anim: "" };
    this.pendingModel = false;
    this.pendingAnim = false;
    this.sentModel = false; // the viewer holds a model
    this.sentAlone = false; // what it holds is one part alone (the model tab)
    // how each instance stands in the whole character at rest (rotations, by name), for the
    // assembly it was worked out from (`standsOf`): the part alone is shown standing so (stand)
    /** @type {Record<string, number[]>} */
    this.stands = {};
    this.standsOf = "";
    this.stand = [0, 0, 0]; // the root's turn that stands the part alone as in the character
    this.scheduled = false;
    /** @type {((what: Change) => void)[]} */
    this.listeners = [];
  }

  /** @param {(what: Change) => void} fn */
  on(fn) {
    this.listeners.push(fn);
  }

  /** @param {Change} what */
  emit(what) {
    for (const fn of this.listeners) fn(what);
  }

  async start() {
    try {
      this.viewer = await Viewer.start((m) => this.setStatus(m));
      this.viewer.grid(this.grid);
      this.assets = await listCharacters();
      this.refreshList();
      const first = this.characters.find((c) => c.name === "mech") ?? this.characters[0];
      if (first) await this.open(first.name);
      else await this.newCharacter();
      requestAnimationFrame(() => this.tick());
    } catch (e) {
      this.setStatus(String(e));
    }
  }

  /** @param {string} message */
  setStatus(message) {
    this.status = message;
    this.emit("status");
  }

  // refreshList merges the characters saved here with those in assets/; a saved one wins.
  refreshList() {
    const local = localNames();
    this.characters = [
      ...local.map((name) => ({ name, local: true, files: this.assets.find((a) => a.name === name) ?? null })),
      ...this.assets.filter((a) => !local.includes(a.name)).map((a) => ({ name: a.name, local: false, files: a })),
    ].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** @param {string} name */
  async open(name) {
    const c = this.characters.find((x) => x.name === name);
    if (!c) return;
    if (!this.discardOk()) return;
    const text = c.local ? loadLocal(name) : c.files ? await readFile(c.files.file) : null;
    if (!text) return;
    const data = JSON.parse(text);
    this.load(name, data.model ?? {}, data.animation ?? {});
  }

  discardOk() {
    return !this.dirty || confirm(`Discard unsaved changes to ${this.current}?`);
  }

  /** load shows a character from its data, with a fresh undo history. @param {string} name @param {any} model @param {any} anim */
  load(name, model, anim) {
    this.model = model;
    this.anim = anim;
    this.current = name;
    this.saved = this.snapshot();
    this.modelDirty = this.animDirty = false;
    this.undoStack = [];
    this.redoStack = [];
    this.part = this.shape = this.slot = this.material = this.ik = -1;
    this.also = [];
    this.def = 0;
    this.inspect = "character";
    this.clip = 0;
    this.time = 0;
    this.playing = false;
    this.test = {};
    this.pendingModel = this.pendingAnim = true;
    this.sync();
    this.viewer?.frame();
    this.setStatus("");
    this.emit("data");
  }

  /**
   * edit changes the model, the animation or both in `change`. Edits with the same `coalesce`
   * key in quick succession (a drag, a slider) make one undo step; a key starting "drag:" makes
   * one step however slow the drag (give each drag its own key).
   * @param {"model" | "anim" | "both"} what
   * @param {() => void} change
   * @param {string} [coalesce]
   */
  edit(what, change, coalesce = "") {
    const now = performance.now();
    const same = !!coalesce && coalesce === this.lastEdit.key && (coalesce.startsWith("drag:") || now - this.lastEdit.at <= 1000);
    if (!same) {
      this.undoStack.push(this.snapshot());
      if (this.undoStack.length > 300) this.undoStack.shift();
      this.redoStack = [];
    }
    this.lastEdit = { key: coalesce, at: now };
    change();
    if (what !== "anim") this.modelDirty = this.pendingModel = true;
    if (what !== "model") this.animDirty = this.pendingAnim = true;
    this.schedule();
  }

  snapshot() {
    return { model: JSON.stringify(this.model), anim: JSON.stringify(this.anim) };
  }

  /** @param {{model: string, anim: string}} s */
  restore(s) {
    if (s.model !== JSON.stringify(this.model)) {
      this.model = JSON.parse(s.model);
      this.modelDirty = this.pendingModel = true;
    }
    if (s.anim !== JSON.stringify(this.anim)) {
      this.anim = JSON.parse(s.anim);
      this.animDirty = this.pendingAnim = true;
    }
    const now = this.snapshot();
    this.modelDirty = now.model !== this.saved.model;
    this.animDirty = now.anim !== this.saved.anim;
    this.lastEdit = { key: "", at: 0 };
    this.schedule();
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snapshot());
    this.restore(s);
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snapshot());
    this.restore(s);
  }

  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.sync();
      this.emit("data");
    });
  }

  // alone is the model the model tab shows: the selected library part, placed once at the origin,
  // hanging by its joints; mirrored, as the other side shows it, when previewing that. It shows in model units
  // (ALONE_SCALE), not scaled to the character's size.
  // Each joint it hangs by is a channel of its own (jointChannel), which the joints' try sliders
  // and the joint tool set (this.tries), so a joint can be tried before it is rigged.
  alone() {
    const m = this.model;
    const part = m.parts?.[this.def];
    return {
      name: m.name,
      scale: ALONE_SCALE,
      materials: m.materials,
      hardware: m.hardware,
      parts: part ? [part] : [],
      // mirroring names a twin; alone, it names its own part (no twin there): reflected only
      assembly: part ? [{ name: part.name, part: part.name, ...(this.mirrored ? { mirror: part.name } : {}) }] : [],
    };
  }

  /** setTry moves a joint the model tab shows, to try it; never saved @param {string} channel its channel (the joints query's) @param {import("./model.js").Value} v */
  setTry(channel, v) {
    if (channel) this.tries[channel] = v;
    this.showTries();
  }

  /** showTries shows the part alone standing as in the character, its joints as tried */
  showTries() {
    this.viewer?.showValues({ ...this.tries, "root.turn": this.stand });
  }

  /** restTurns: every instance's rotation in the model the viewer holds, at rest @returns {Record<string, number[]>} */
  restTurns() {
    const parts = this.viewer?.query({ q: "parts", rest: true }) ?? {};
    return Object.fromEntries(Object.entries(parts).map(([name, f]) => [name, fromQuat(f.rotation)]));
  }

  /**
   * standAlone: the root's turn (euler) that stands the part alone, as the viewer holds it, the
   * way the first instance of it (mirrored ones, previewing the mirror) stands in the character
   */
  standAlone() {
    const part = this.model.parts?.[this.def];
    const all = (this.model.assembly ?? []).filter((/** @type {any} */ x) => x.part === part?.name);
    const inst = all.find((/** @type {any} */ x) => !!x.mirror === this.mirrored) ?? all[0];
    const want = inst && this.stands[inst.name];
    const now = part && this.restTurns()[part.name];
    return want && now ? eulerFrom(mul(want, transpose(now))) : [0, 0, 0];
  }

  /** resetTries puts the tried joints back at rest */
  resetTries() {
    this.tries = {};
    this.showTries();
    this.emit("select");
  }

  // sync sends what changed to the viewer, then tells it what to show. `whole`: the whole
  // character even in the model tab (to write it out).
  sync(whole = false) {
    const v = this.viewer;
    if (!v) return;
    const alone = !whole && this.tab === "model";
    if (alone !== this.sentAlone) this.pendingModel = this.pendingAnim = true;
    // a new character: drop the old animation first, so the new model is not compiled against it
    if (this.pendingModel && this.pendingAnim && this.sentModel) v.setAnimation({});
    if (this.pendingModel) {
      // the part alone stands as its first instance does in the character: worked out on the
      // whole one, whenever the assembly changed since
      const assembly = JSON.stringify(this.model.assembly ?? []);
      // (measured on the viewer once it holds the whole model, not the part alone it held before)
      if (!alone || this.standsOf !== assembly) {
        this.sentModel = v.setModel(this.model) || this.sentModel;
        this.stands = this.restTurns();
        this.standsOf = assembly;
      }
      if (alone) this.sentModel = v.setModel(this.alone()) || this.sentModel;
      if (alone) this.stand = this.standAlone();
    }
    if (this.pendingAnim) v.setAnimation(alone ? {} : this.isolate ? this.isolated() : this.anim);
    this.pendingModel = this.pendingAnim = false;
    if (alone !== this.sentAlone) {
      this.sentAlone = alone;
      v.frame();
    }
    this.show();
    const state = v.query({ q: "state" });
    if (state.messages?.length) this.messages = [...this.messages, ...state.messages].slice(-50);
  }

  // show tells the viewer what this tab shows: the part alone, exploded as asked, while modelling;
  // the pose test (from the rest pose) while assembling; the clip while animating.
  show() {
    const v = this.viewer;
    if (!v) return;
    if (this.tab === "animation") {
      // the part picked in the view, lit
      v.select(this.part, -1, false);
      // held past the end it shows the end, not the start again
      v.play(this.clip, this.time, this.playing, this.speed, this.loop && this.playing);
    } else if (this.tab === "model") {
      this.showTries();
      v.select(this.model.parts?.[this.def] ? 0 : -1, this.shape, true);
      v.explode(this.explode);
    } else {
      v.showValues(this.test);
      v.select(this.part, -1, false);
      v.explode(0);
    }
  }

  /** setGrid shows or hides the view's grid through the origin, kept in this browser @param {boolean} on */
  setGrid(on) {
    this.grid = on;
    localStorage.setItem("grid", on ? "on" : "off");
    this.viewer?.grid(on);
  }

  /** setMirrored previews the model tab's part as the other side (true) or as modelled @param {boolean} on */
  setMirrored(on) {
    this.mirrored = on;
    this.pendingModel = true;
    this.sync();
    this.emit("select");
  }

  /** pickPart shows library part i alone (the model tab) @param {number} i */
  pickPart(i) {
    this.def = i;
    this.shape = (this.model.parts?.[i]?.shapes?.length ?? 0) > 0 ? 0 : -1;
    this.slot = this.joint = -1;
    this.also = [];
    this.tries = {};
    this.inspect = "part";
    this.pendingModel = true;
    this.sync();
    this.viewer?.frame();
    this.emit("select");
  }

  /** pickClip shows clip i from its start, its first motion picked @param {number} i */
  pickClip(i) {
    this.select(() => {
      this.clip = i;
      this.time = 0;
      this.motion = 0;
      this.picked = [];
      this.moves = [];
      this.openMoves = [];
    });
    if (this.isolate) this.setIsolate(false);
  }

  /** the clip's motions picked, in the order picked, the one shown (`motion`) last @returns {number[]} */
  pickedMotions() {
    const n = this.clipData?.motions?.length ?? 0;
    if (!n) return [];
    const shown = Math.min(Math.max(this.motion, 0), n - 1);
    return [...this.picked.filter((k, i, all) => k >= 0 && k < n && k !== shown && all.indexOf(k) === i), shown];
  }

  /**
   * pickMotion shows motion i, picking it alone; `add` (shift- or cmd-click) adds it to the
   * motions picked, or takes it out when it is one of them
   * @param {number} i @param {boolean} [add]
   */
  pickMotion(i, add = false) {
    this.select(() => {
      const was = this.pickedMotions();
      if (add && was.includes(i) && was.length > 1) this.picked = was.filter((k) => k !== i);
      else this.picked = add ? [...was.filter((k) => k !== i), i] : [i];
      this.motion = /** @type {number} */ (this.picked.at(-1));
      this.moves = [];
      this.openMoves = [];
      if (this.isolate) this.pendingAnim = true;
    });
    if (this.isolate) this.sync();
  }

  /** the shown motion's moves picked, in order @returns {number[]} */
  pickedMoves() {
    const n = this.clipData?.motions?.[this.motion]?.moves?.length ?? 0;
    return [...new Set(this.moves)].filter((k) => k >= 0 && k < n).sort((a, b) => a - b);
  }

  /** pickMove picks move i of the motion shown, alone; `add` adds it or takes it out @param {number} i @param {boolean} [add] */
  pickMove(i, add = false) {
    this.select(() => {
      const was = this.pickedMoves();
      this.moves = !add ? (was.length === 1 && was[0] === i ? [] : [i]) : was.includes(i) ? was.filter((k) => k !== i) : [...was, i];
    });
  }

  /** toggleMove unfolds move i of the motion shown in the inspector, or folds it @param {number} i */
  toggleMove(i) {
    this.select(() => (this.openMoves = this.openMoves.includes(i) ? this.openMoves.filter((k) => k !== i) : [...this.openMoves, i]));
  }

  /** setIsolate plays only the picked motions (on), or the whole clip @param {boolean} on */
  setIsolate(on) {
    this.isolate = on;
    this.pendingAnim = true;
    this.sync();
    this.emit("select");
  }

  /** the animation as isolating shows it: the clip shown with its motions not picked emptied (kept, so motions keep their places) */
  isolated() {
    const a = JSON.parse(JSON.stringify(this.anim));
    const c = a.clips?.[this.clip];
    if (!c) return a;
    const keep = new Set(this.pickedMotions());
    c.motions = (c.motions ?? []).map((/** @type {any} */ mo, /** @type {number} */ k) => (keep.has(k) ? mo : { moves: [] }));
    return a;
  }

  // select changes what is selected (in `change`) and refreshes the views and the viewer.
  /** @param {() => void} change */
  select(change) {
    change();
    this.show();
    this.emit("select");
  }

  /** the selected shapes of the part the model tab shows: the selected one first, then those shift-clicked */
  selectedShapes() {
    const n = this.model.parts?.[this.def]?.shapes?.length ?? 0;
    return [this.shape, ...this.also].filter((k, i, all) => k >= 0 && k < n && all.indexOf(k) === i);
  }

  /** pickShape selects shape k of the part the model tab shows; `add` (shift) adds it to the selection, or takes it out @param {number} k @param {boolean} [add] */
  pickShape(k, add = false) {
    this.select(() => {
      if (add && this.shape >= 0 && k !== this.shape) this.also = this.also.includes(k) ? this.also.filter((x) => x !== k) : [...this.also, k];
      else {
        this.shape = k;
        this.also = [];
      }
      this.inspect = "part";
    });
  }

  /** selectAllShapes selects every shape of the part the model tab shows (Cmd-A) */
  selectAllShapes() {
    const n = this.model.parts?.[this.def]?.shapes?.length ?? 0;
    if (!n) return;
    this.select(() => {
      this.shape = Math.max(0, this.shape);
      this.also = [...Array(n).keys()].filter((k) => k !== this.shape);
      this.inspect = "part";
    });
  }

  /** copyShapes keeps the selected shapes for pasteShapes */
  copyShapes() {
    const part = this.model.parts?.[this.def];
    if (!part) return;
    this.clipShapes = this.selectedShapes().map((k) => clone(part.shapes[k]));
    this.flash(`${this.clipShapes.length} shape${this.clipShapes.length === 1 ? "" : "s"} copied`);
  }

  /** pasteShapes adds the copied shapes to the part the model tab shows, selected (stretched ones run its length) */
  pasteShapes() {
    const part = this.model.parts?.[this.def];
    if (!part || !this.clipShapes.length) return;
    this.edit("model", () => {
      part.shapes ??= [];
      const at = part.shapes.length;
      for (const c of this.clipShapes) part.shapes.push(clone(c));
      this.shape = at;
      this.also = this.clipShapes.map((_, i) => at + i).slice(1);
    });
  }

  tick() {
    const v = this.viewer;
    if (v && this.tab === "animation" && this.playing) {
      this.time = v.time();
      this.emit("time");
    }
    requestAnimationFrame(() => this.tick());
  }

  /**
   * ask puts the latest data in the viewer and asks it a query (src/viewer/query.odin); null
   * without a viewer or on an error.
   * @param {Record<string, any>} q
   */
  ask(q) {
    if (!this.viewer) return null;
    this.sync();
    const answer = this.viewer.query(q);
    return answer?.error ? null : answer;
  }

  /** faces of each of a library part's shapes, in its frame (the "faces" query) @param {string} part @returns {import("./model.js").Face[][]} */
  faces(part) {
    return this.ask({ q: "faces", part })?.shapes ?? [];
  }

  /**
   * setChannels sets channel values from the view's handles (by channel: a number or [x, y, z]):
   * the pose test's in the assemble tab; in the animate tab, the shown motion's move (the one picked,
   * else its first) changes its amounts so the pose shown now becomes these values: by the change
   * over how much of them the move adds now (its shape at the playhead). `coalesce` makes a drag
   * one undo step. @param {Record<string, import("./model.js").Value>} values @param {string} [coalesce]
   */
  setChannels(values, coalesce) {
    if (this.tab === "assemble") {
      Object.assign(this.test, values);
      this.show();
      return;
    }
    const mo = this.clipData?.motions?.[this.motion];
    const k = this.pickedMoves()[0] ?? 0;
    const mv = mo?.moves?.[k];
    if (!mv) return this.flash("Pick a motion with a move to pose it (add a held motion: +)");
    // how much of its amounts the move adds now
    const d = this.clipData.duration || 1;
    const lane = this.ask({ q: "motion", clip: this.clipData.name, motion: this.motion, n: 201 })?.moves?.[k];
    const at = Math.round(Math.min(Math.max(this.time / d, 0), 1) * 200);
    const f = lane ? lane.values[at] : 1;
    if (Math.abs(f) < 0.05) return this.flash("This move adds nothing now: move the playhead to where it acts");
    const shown = this.shown();
    // a twin move: a channel the move moves only as its twin's twin goes into its twin's amount, by
    // how much of it the twins add now (half a cycle on when OPPOSITE), x mirrored
    const twins = mv.twin && mv.twin !== "NONE" ? (this.ask({ q: "twins" }) ?? {}) : {};
    const ft = lane?.twin ? lane.twin.values[at] : f;
    const r4 = (/** @type {number} */ x) => Math.round(x * 1e4) / 1e4;
    this.edit(
      "anim",
      () => {
        mv.by ??= {};
        for (const [n, v] of Object.entries(values)) {
          const change = zipValue(v, shown[n], (x, y) => x - y);
          const t = twins[n];
          if (!(n in mv.by) && t && typeof mv.by[t.twin] !== "string" && t.twin in mv.by) {
            if (Math.abs(ft) >= 0.05) mv.by[t.twin] = zipValue(addValue(mv.by[t.twin], zipValue(change, t.flip, (x, fl) => x / (ft * fl))), 0, r4);
            continue;
          }
          if (typeof mv.by[n] === "string") continue; // on an arc: drag its points
          mv.by[n] = zipValue(addValue(mv.by[n], zipValue(change, 0, (x) => x / f)), 0, r4);
        }
      },
      coalesce,
    );
  }

  /** the root's channels (the "channels" query: the position and the rotation no IK target or joint owns): {move, turn} names @returns {{move: string, turn: string}} */
  rootChannels() {
    const cs = this.channels().filter((c) => !c.ik && !c.part);
    return { move: cs.find((c) => c.kind === "POSITION")?.name ?? "", turn: cs.find((c) => c.kind === "BALL")?.name ?? "" };
  }

  /** every channel of the character, in the engine's order (the "channels" query): {name, kind, size, min, max, part?, ik?} @returns {any[]} */
  channels() {
    return this.viewer?.query({ q: "channels" }) ?? [];
  }

  // shown is the channels as the viewer shows them now.
  /** @returns {Record<string, import("./model.js").Value>} */
  shown() {
    return this.viewer?.query({ q: "state" }).values ?? {};
  }

  /** @param {Tab} tab */
  setTab(tab) {
    this.tab = tab;
    if (tab !== "animation") this.playing = false;
    if (tab === "model") this.def = Math.min(Math.max(this.def, 0), (this.model.parts?.length ?? 1) - 1);
    this.sync();
    this.show();
    this.emit("select");
  }

  /** @param {number} t */
  seek(t) {
    const d = this.clipData?.duration ?? 1;
    this.time = Math.min(Math.max(t, 0), d);
    this.playing = false;
    this.show();
    this.emit("time");
  }

  togglePlay() {
    this.playing = !this.playing;
    if (this.playing && this.time >= (this.clipData?.duration ?? 1) - 1e-3 && !this.loop) this.time = 0;
    this.show();
    this.emit("time");
  }

  get clipData() {
    return this.anim.clips?.[this.clip];
  }

  get dirty() {
    return this.modelDirty || this.animDirty;
  }

  // text is the open character as character file text, written by the engine (the viewer) itself.
  text() {
    this.sync(true);
    return /** @type {Viewer} */ (this.viewer).formatCharacter();
  }

  // save keeps the character in this browser (localStorage); export writes files.
  save() {
    if (!this.viewer || !this.current) return;
    try {
      saveLocal(this.current, this.text());
    } catch (e) {
      this.messages = [...this.messages, `Could not save ${this.current}: ${e}`];
      this.emit("status");
      return;
    }
    this.saved = this.snapshot();
    this.modelDirty = this.animDirty = false;
    this.refreshList();
    this.flash(`Saved ${this.current} in this browser`);
    this.emit("data");
  }

  exportFile() {
    if (!this.viewer || !this.current) return;
    exportFile(this.current, this.text());
  }

  async importFile() {
    if (!this.discardOk()) return;
    try {
      const picked = await pickFile();
      if (!picked) return;
      const name = picked.name;
      if (this.characters.some((c) => c.name === name && c.local) && !confirm(`Replace ${name} saved in this browser?`)) return;
      this.load(name, picked.model, picked.anim);
      this.save();
    } catch (e) {
      this.messages = [...this.messages, `Import failed: ${e}`];
      this.emit("status");
    }
  }

  async newCharacter() {
    if (!this.discardOk()) return;
    const name = prompt("Name of the new character", uniqueName("character", (n) => this.characters.some((c) => c.name === n)))?.trim();
    if (!name) return;
    if (this.characters.some((c) => c.name === name) && !confirm(`A character named ${name} exists. Replace it?`)) return;
    const blank = blankCharacter(name);
    this.load(name, blank.model, blank.anim);
    this.save();
  }

  /** @param {string} message */
  flash(message) {
    this.toast = message;
    this.emit("status");
    setTimeout(() => {
      if (this.toast === message) {
        this.toast = "";
        this.emit("status");
      }
    }, 2500);
  }
}

export const editor = new Editor();
