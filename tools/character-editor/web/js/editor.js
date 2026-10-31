// @ts-check
// The editor's state: the open character's model and animation (plain data, as in the files),
// what is selected, playback, undo. Every edit goes through `edit`, which records undo and sends
// the changed data to the viewer (the game's own code, in wasm). Views listen with `on`.

import { listCharacters, readFile } from "./api.js";
import { uniqueName } from "./model.js";
import { blankCharacter, exportFile, loadLocal, localNames, pickFile, saveLocal } from "./store.js";
import { Viewer } from "./viewer.js";

/** @typedef {"model" | "rig" | "animation"} Tab */
/** @typedef {"character" | "part" | "material" | "joint" | "channel" | "driver" | "leg"} Inspect */
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

    // model and rig selection
    /** @type {Inspect} */
    this.inspect = "character";
    this.part = -1;
    this.shape = -1;
    this.isolate = false; // the model tab shows only the selected part
    this.explode = 0; // and pushes its shapes apart, 0 to 1
    this.material = -1;
    this.joint = -1;
    this.channel = -1;
    this.driver = -1;
    this.leg = -1;
    /** @type {Record<string, number>} the pose test, channel units */
    this.test = {};

    // animation
    this.clip = 0;
    /** @type {number[]} selected keys of the clip */
    this.keys = [];
    this.pose = -1;
    this.showPose = false; // preview the selected pose instead of the clip
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
    this.model = model;
    this.anim = anim;
    this.current = name;
    this.saved = this.snapshot();
    this.modelDirty = this.animDirty = false;
    this.undoStack = [];
    this.redoStack = [];
    this.part = this.shape = this.material = this.joint = this.channel = this.driver = this.leg = this.pose = -1;
    this.inspect = "character";
    this.clip = 0;
    this.keys = [];
    this.time = 0;
    this.playing = false;
    this.showPose = false;
    this.test = {};
    this.pendingModel = this.pendingAnim = true;
    this.sync();
    this.viewer?.frame();
    this.setStatus("");
    this.emit("data");
  }

  /**
   * edit changes the model, the animation or both in `change`. Edits with the same `coalesce`
   * key in quick succession (a drag, a slider) make one undo step.
   * @param {"model" | "anim" | "both"} what
   * @param {() => void} change
   * @param {string} [coalesce]
   */
  edit(what, change, coalesce = "") {
    const now = performance.now();
    if (!coalesce || coalesce !== this.lastEdit.key || now - this.lastEdit.at > 1000) {
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

  // sync sends what changed to the viewer, then tells it what to show.
  sync() {
    const v = this.viewer;
    if (!v) return;
    // a new character: drop the old animation first, so the new model is not compiled against it
    if (this.pendingModel && this.pendingAnim && this.sentModel) v.setAnimation({});
    if (this.pendingModel) this.sentModel = v.setModel(this.model) || this.sentModel;
    if (this.pendingAnim) v.setAnimation(this.anim);
    this.pendingModel = this.pendingAnim = false;
    this.show();
    const state = v.query({ q: "state" });
    if (state.messages?.length) this.messages = [...this.messages, ...state.messages].slice(-50);
  }

  // show tells the viewer what this tab shows: the rest pose while modelling, the pose test while rigging,
  // the clip (or a pose) while animating.
  show() {
    const v = this.viewer;
    if (!v) return;
    if (this.tab === "animation") {
      v.select(-1, -1);
      if (this.showPose && this.pose >= 0) v.showPose(this.pose);
      else v.play(this.clip, this.time, this.playing, this.speed, this.loop);
    } else {
      v.showValues(this.tab === "rig" ? this.test : {});
      const model = this.tab === "model";
      v.select(this.part, model ? this.shape : -1, model && this.isolate);
      v.explode(this.explode);
    }
  }

  toggleIsolate() {
    this.isolate = !this.isolate;
    this.show();
    this.emit("select");
  }

  // select changes what is selected (in `change`) and refreshes the views and the viewer.
  /** @param {() => void} change */
  select(change) {
    change();
    this.show();
    this.emit("select");
  }

  tick() {
    const v = this.viewer;
    if (v && this.tab === "animation" && this.playing && !this.showPose) {
      this.time = v.time();
      this.emit("time");
    }
    requestAnimationFrame(() => this.tick());
  }

  // shown is the channels as the viewer shows them now (after drivers and leg IK).
  /** @returns {Record<string, number>} */
  shown() {
    return this.viewer?.query({ q: "state" }).channels ?? {};
  }

  /** @param {Tab} tab */
  setTab(tab) {
    this.tab = tab;
    if (tab !== "animation") this.playing = false;
    this.show();
    this.emit("select");
  }

  /** @param {number} t */
  seek(t) {
    const d = this.clipData?.duration ?? 1;
    this.time = Math.min(Math.max(t, 0), d);
    this.playing = false;
    this.showPose = false;
    this.show();
    this.emit("time");
  }

  togglePlay() {
    this.playing = !this.playing;
    this.showPose = false;
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
    this.sync();
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
