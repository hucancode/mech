// @ts-check
// The editor's state: the open character's model and animation (plain data, as in the files),
// what is selected, playback, undo. Every edit goes through `edit`, which records undo and sends
// the changed data to the viewer (the game's own code, in wasm). Views listen with `on`.

import { listCharacters, readFile } from "./api.js";
import { fromQuat } from "./math3.js";
import { clone, inlineJoints, jointAxes, respan, tryDriver, uniqueName, upgradeAnim } from "./model.js";
import { blankCharacter, exportFile, loadLocal, localNames, pickFile, saveLocal } from "./store.js";
import { Viewer } from "./viewer.js";

/** the scale of the model the model tab shows (editor.alone): model units, as the part is written */
export const ALONE_SCALE = 1;

/** @typedef {"model" | "assemble" | "rig" | "animation"} Tab */
/** @typedef {"character" | "part" | "material" | "driver" | "ik"} Inspect */
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
    /** @type {{move: string[], turn: string[]} | undefined} the root's channels, from the engine (rootChannels) */
    this.root = undefined;
    /** @type {string} what the view's handles move in the rig and animate tabs: "root", an IK target's name, or "" */
    this.handle = "";
    /** @type {number[]} shapes selected with the selected one (shift-click) */
    this.also = [];
    /** @type {{spanned: any, flat: any}[]} shapes copied (Cmd-C): as they were, and in their part's frame */
    this.clipShapes = [];
    this.joint = -1; // of the joints the part hangs by, the one selected (the joint tool)
    /** @type {Record<string, number>} the part's joints tried, never saved: by tryDriver(joint, axis) */
    this.tries = {};
    this.explode = 0; // the part's shapes pushed apart, 0 to 1
    this.mirrored = false; // preview the part as a mirrored instance shows it (the right side)
    /** @type {"hidden" | "point" | "label"} IK targets and poles in the view (rig and animate tabs), kept in this browser */
    this.ikShow = /** @type {any} */ (localStorage.getItem("ikShow")) || "point";
    // assemble and rig tabs
    /** @type {Inspect} */
    this.inspect = "character";
    this.part = -1; // an instance of the assembly
    this.material = -1;
    this.driver = -1;
    this.ik = -1;
    /** @type {Record<string, number>} the pose test, driver values */
    this.test = {};

    // animation
    this.clip = 0;
    /** @type {number[]} selected keys of the clip */
    this.keys = [];
    this.time = 0;
    this.playing = false;
    this.speed = 1;
    this.loop = true;

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
    this.sentHang = ""; // the slot that part hangs by
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
    // saves from before characters were one file hold the model's and animation's text apart
    if (typeof data.model === "string") this.load(name, JSON.parse(data.model), JSON.parse(data.anim ?? "{}"));
    else this.load(name, data.model ?? {}, data.animation ?? {});
  }

  discardOk() {
    return !this.dirty || confirm(`Discard unsaved changes to ${this.current}?`);
  }

  /** load shows a character from its data, with a fresh undo history. @param {string} name @param {any} model @param {any} anim */
  load(name, model, anim) {
    this.model = inlineJoints(model);
    this.anim = upgradeAnim(anim);
    this.current = name;
    this.saved = this.snapshot();
    this.modelDirty = this.animDirty = false;
    this.undoStack = [];
    this.redoStack = [];
    this.part = this.shape = this.slot = this.material = this.driver = this.ik = -1;
    this.also = [];
    this.def = 0;
    this.inspect = "character";
    this.clip = 0;
    this.keys = [];
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
    this.keys = this.keys.filter((k) => k < (this.clipData?.keys?.length ?? 0));
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
  // hanging by its origin with its own joints, or by the selected slot when that has joints;
  // mirrored, as the other side shows it, when previewing that. It shows in model units
  // (ALONE_SCALE), not scaled to the character's size.
  // Each axis of the joints it hangs by gets a driver (tryDriver), which the joints' try sliders
  // and the joint tool set (this.tries), so a joint can be tried before it is rigged.
  alone() {
    const m = this.model;
    const part = m.parts?.[this.def];
    const slot = this.hang();
    const drivers = this.hangJoints().flatMap((/** @type {any} */ j) =>
      jointAxes(j).map((axis) => ({ name: tryDriver(j.name, axis), min: -Math.PI, max: Math.PI, drives: [{ part: part.name, joint: j.name, axis, from: [0, 1], to: [0, 1] }] })),
    );
    return {
      name: m.name,
      scale: ALONE_SCALE,
      materials: m.materials,
      hardware: m.hardware,
      drivers,
      parts: part ? [part] : [],
      assembly: part ? [{ name: part.name, part: part.name, ...(slot ? { slot } : {}), ...(this.mirrored ? { mirror: true } : {}) }] : [],
    };
  }

  /** the joints the model tab hangs the part by: the selected slot's, when it has some, else its own (its origin's) */
  hangJoints() {
    const part = this.model.parts?.[this.def];
    const slot = this.hang();
    return (slot ? part?.slots?.find((/** @type {any} */ s) => s.name === slot)?.joints : part?.joints) ?? [];
  }

  /** setTry turns a joint the model tab shows, to try it; never saved @param {string} joint @param {string} axis @param {number} v */
  setTry(joint, axis, v) {
    this.tries[tryDriver(joint, axis)] = v;
    this.viewer?.showValues(this.tries);
  }

  /** resetTries puts the tried joints back at rest */
  resetTries() {
    this.tries = {};
    this.viewer?.showValues(this.tries);
    this.emit("select");
  }

  // hang is the slot the model tab hangs the part by: the selected one, when it has joints.
  hang() {
    const s = this.model.parts?.[this.def]?.slots?.[this.slot];
    return s?.joints?.length ? s.name : "";
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
      this.sentHang = alone ? this.hang() : "";
      this.sentModel = v.setModel(alone ? this.alone() : this.model) || this.sentModel;
    }
    if (this.pendingAnim) v.setAnimation(alone ? {} : this.anim);
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
  // the character at rest while assembling; the pose test while rigging; the clip while animating.
  show() {
    const v = this.viewer;
    if (!v) return;
    if (this.tab === "animation") {
      // the part whose keys the timeline shows
      v.select(this.part, -1, false);
      v.play(this.clip, this.time, this.playing, this.speed, this.loop);
    } else if (this.tab === "model") {
      // selecting a slot with joints hangs the part by it
      if (this.hang() !== this.sentHang) {
        this.pendingModel = true;
        return this.sync();
      }
      v.showValues(this.tries);
      v.select(this.model.parts?.[this.def] ? 0 : -1, this.shape, true);
      v.explode(this.explode);
    } else {
      v.showValues(this.tab === "rig" ? this.test : {});
      v.select(this.part, -1, false);
      v.explode(0);
    }
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

  /** copyShapes keeps the selected shapes for pasteShapes, each as it is and in its part's frame (its span undone) */
  copyShapes() {
    const part = this.model.parts?.[this.def];
    if (!part) return;
    const none = this.spanFrame(part.name, ["", ""]);
    this.clipShapes = this.selectedShapes().map((k) => {
      const spanned = clone(part.shapes[k]);
      const flat = clone(spanned);
      respan(flat, ["", ""], this.spanFrame(part.name, spanned.span), none);
      return { spanned, flat };
    });
    this.flash(`${this.clipShapes.length} shape${this.clipShapes.length === 1 ? "" : "s"} copied`);
  }

  /** pasteShapes adds the copied shapes to the part the model tab shows, selected: spanning as they did when it has those slots, else where they were in their part */
  pasteShapes() {
    const part = this.model.parts?.[this.def];
    if (!part || !this.clipShapes.length) return;
    const has = (/** @type {string} */ n) => !n || (part.slots ?? []).some((/** @type {any} */ x) => x.name === n);
    this.edit("model", () => {
      part.shapes ??= [];
      const at = part.shapes.length;
      for (const c of this.clipShapes) part.shapes.push(clone(c.spanned.span?.every(has) ? c.spanned : c.flat));
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
   * the frame a shape of library part `part` spanning slots `span` sits in (the "span" query)
   * @param {string} part @param {string[] | undefined} span @returns {import("./model.js").SpanFrame}
   */
  spanFrame(part, span) {
    const a = this.ask({ q: "span", part, span: span ?? ["", ""] });
    return a ? { position: a.position, rotation: fromQuat(a.rotation), length: a.length } : { position: [0, 0, 0], rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], length: 0 };
  }

  /**
   * setChannels sets driver and root values from the view's handles: the pose test's in the rig
   * tab; the selected key's own values in the animate tab (one key must be selected). `coalesce`
   * makes a drag one undo step.
   * @param {Record<string, number>} values @param {string} [coalesce]
   */
  setChannels(values, coalesce) {
    if (this.tab === "rig") {
      Object.assign(this.test, values);
      this.show();
      return;
    }
    const key = this.keys.length === 1 ? this.clipData?.keys?.[this.keys[0]] : undefined;
    if (!key) return this.flash("Select one key to set it there");
    this.edit("anim", () => Object.assign((key.values ??= {}), values), coalesce);
  }

  /** the root's channels, the values after the drivers (the engine's "info"): those moving it (model units) and turning it (radians) @returns {{move: string[], turn: string[]}} */
  rootChannels() {
    if (!this.root) {
      const info = this.viewer?.query({ q: "info" });
      if (info?.root) this.root = info.root;
    }
    return this.root ?? { move: [], turn: [] };
  }

  // shown is the drivers as the viewer shows them now.
  /** @returns {Record<string, number>} */
  shown() {
    return this.viewer?.query({ q: "state" }).drivers ?? {};
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
