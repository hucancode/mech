// @ts-check
// The viewer: the game's own Odin code (src/viewer over src/character, src/mech and mjolnir), built
// to wasm by `make web`. The editor sends it data and asks it questions; it never poses, samples
// or formats anything itself. The exports are in src/viewer/web.odin, the queries in
// src/viewer/query.odin.

/* global odin */

export class Viewer {
  /** @param {any} mem */
  constructor(mem) {
    this.mem = mem;
    /** @type {Record<string, (...a: number[]) => number>} */
    this.x = mem.exports;
  }

  /**
   * start runs the viewer in the page's <canvas id="canvas"> and resolves once it takes data.
   * @param {(message: string) => void} onFail
   */
  static async start(onFail) {
    if (!("gpu" in navigator)) throw new Error("This browser has no WebGPU.");
    const odinRt = /** @type {any} */ (window).odin;
    const mem = new odinRt.WasmMemoryInterface();
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("canvas"));
    /** @type {() => void} */
    let ready = () => {};
    const started = new Promise((resolve) => (ready = () => resolve(undefined)));
    // what mjolnir's web platform calls (vendor/mjolnir/mjolnir/platform/web/index.html)
    const page = {
      ready: () => ready(),
      fail: () => onFail("The viewer stopped on an error; see the browser console."),
      fullscreen: () => {},
      is_fullscreen: () => false,
      cursor: (/** @type {number} */ mode) => (canvas.style.cursor = mode === 0 ? "" : "none"),
      cursor_locked: () => false,
      set_clipboard: (/** @type {number} */ ptr, /** @type {number} */ len) => navigator.clipboard?.writeText(mem.loadString(ptr, len)),
    };
    const imports = { mjolnir: page, wgpu: new odinRt.WebGPUInterface(mem).getInterface() };
    await odinRt.runWasm("/viewer.wasm", null, imports, mem);
    await started;
    return new Viewer(mem);
  }

  /**
   * @template T
   * @param {string} text
   * @param {(p: number, n: number) => T} call
   */
  withText(text, call) {
    const bytes = new TextEncoder().encode(text);
    const p = this.x.viewer_alloc(bytes.length);
    this.mem.loadBytes(p, bytes.length).set(bytes);
    try {
      return call(p, bytes.length);
    } finally {
      this.x.viewer_free(p, bytes.length);
    }
  }

  /** @param {number} p */
  resultText(p) {
    const n = this.x.viewer_result_len();
    return n > 0 ? this.mem.loadString(p, n) : "";
  }

  /** @param {object} model the model data, as a character file's "model" holds it */
  setModel(model) {
    return this.withText(JSON.stringify(model), (p, n) => this.x.viewer_set_model(p, n)) !== 0;
  }

  /** @param {object} anim the animation data, as a character file's "animation" holds it */
  setAnimation(anim) {
    return this.withText(JSON.stringify(anim), (p, n) => this.x.viewer_set_animation(p, n)) !== 0;
  }

  /** showValues holds the mech in these driver values; others are 0. @param {Record<string, number>} values */
  showValues(values) {
    return this.withText(JSON.stringify(values), (p, n) => this.x.viewer_set_values(p, n)) !== 0;
  }

  /** @param {number} clip @param {number} time @param {boolean} playing @param {number} speed @param {boolean} loops */
  play(clip, time, playing, speed = 1, loops = true) {
    this.x.viewer_play(clip, time, playing ? 1 : 0, speed, loops ? 1 : 0);
  }

  /** @param {number} part @param {number} shape @param {boolean} isolate hide the rest of the character */
  select(part, shape = -1, isolate = false) {
    this.x.viewer_select(part, shape, isolate);
  }

  /** @param {number} amount 0 assembled, 1 the isolated part's shapes pushed out by its size */
  explode(amount) {
    this.x.viewer_explode(amount);
  }

  frame() {
    this.x.viewer_frame();
  }

  /** look from a view, framed: 0 free (perspective orbit), then from +x, -x, +y, -y, +z, -z (orthographic) @param {number} view */
  view(view) {
    this.x.viewer_view(view);
  }

  time() {
    return this.x.viewer_time();
  }

  /** The character (model and animation) as character file text, written as the game's tools write it. */
  formatCharacter() {
    return this.resultText(this.x.viewer_format_character());
  }

  /**
   * query asks the engine a question and returns its JSON answer (see src/viewer/query.odin):
   * state, sample, pose, parts, trajectory, bounds, info.
   * @param {Record<string, any>} q
   * @returns {any}
   */
  query(q) {
    const answer = JSON.parse(this.withText(JSON.stringify(q), (p, n) => this.resultText(this.x.viewer_query(p, n))));
    if (answer.error) console.warn("query", q, answer.error);
    return answer;
  }
}
