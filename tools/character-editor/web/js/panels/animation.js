// @ts-check
// The Animation tab: the clips, and the selected key. A clip is keyframed (keys, edited on the
// timeline in the dock) or procedural (a walk, a run, a slither the engine computes from a few
// numbers, tuned here while it plays: gait.js).
import { btn, h, list, num, row, section, select, slider, text } from "../dom.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { isProcedural, makeClip, PRESETS } from "../gait.js";
import { clone, EASES, uniqueName } from "../model.js";
import { driverValues } from "./driverValues.js";

const KEYFRAMED = "Keyframed clip";

export function animSidebar() {
  const a = editor.anim;
  /** @param {boolean} copy */
  const addClip = (copy) =>
    editor.edit("anim", () => {
      a.clips ??= [];
      const src = copy ? a.clips[editor.clip] : undefined;
      const c = src ? clone(src) : { name: "clip", duration: 1, keys: [] };
      c.name = uniqueName(c.name, (n) => a.clips.some((/** @type {any} */ x) => x.name === n));
      a.clips.push(c);
      editor.clip = a.clips.length - 1;
      editor.keys = [];
    });
  const removeClip = () => {
    if (!confirm(`Delete clip ${a.clips[editor.clip].name}?`)) return;
    editor.edit("anim", () => {
      a.clips.splice(editor.clip, 1);
      editor.clip = Math.max(0, editor.clip - 1);
      editor.keys = [];
    });
  };
  /** @param {string} label */
  const addProcedural = (label) => {
    const preset = PRESETS.find((p) => p.label === label);
    if (!preset) return;
    let made = /** @type {number | string} */ ("");
    // a preset may make the legs' IK targets: the model changes too
    editor.edit("both", () => (made = makeClip(editor.model, a, preset)));
    if (typeof made === "string") return editor.flash(made);
    editor.select(() => {
      editor.clip = /** @type {number} */ (made);
      editor.keys = [];
      editor.time = 0;
      editor.playing = true;
      editor.loop = true;
    });
  };
  const clip = editor.clipData;
  const add = select({
    value: "",
    none: "+ clip…",
    options: [KEYFRAMED, ["procedural", PRESETS.map((p) => p.label)]],
    onchange: (v) => (v === KEYFRAMED ? addClip(false) : addProcedural(v)),
  });
  return [
    section(
      "Clips",
      [
        list(
          a.clips ?? [],
          (c) => [
            h("span", { class: "name", style: { flex: "1" } }, c.name),
            h("span", { class: "tag" }, `${+(c.duration ?? 0).toFixed(2)}s`),
            isProcedural(c)
              ? h("span", { class: "tag", title: "procedural: tuned by its numbers" }, "procedural")
              : h("span", { class: "tag count-key", title: `${c.keys?.length ?? 0} key frames` }, icon("key", 12), c.keys?.length ?? 0),
          ],
          (i) => i === editor.clip,
          (i) =>
            editor.select(() => {
              editor.clip = i;
              editor.keys = [];
              editor.time = 0;
            }),
        ),
        clip && h("div", { style: { marginTop: "8px" } }, row("name", text({ value: clip.name, onchange: (v) => editor.edit("anim", () => (clip.name = v)) }))),
        h("div", { style: { marginTop: "6px" } }, add),
      ],
      {
        actions: [
          btn(icon("copy"), () => addClip(true), { kind: "icon", title: "Duplicate the clip", disabled: !clip }),
          btn(icon("trash"), removeClip, { kind: "icon", title: "Delete the clip", disabled: !clip }),
        ],
      },
    ),
  ];
}

export function animInspector() {
  const keys = editor.clipData?.keys ?? [];
  if (isProcedural(editor.clipData) && editor.keys.length !== 1) return gaitInspector(editor.clipData);
  if (editor.keys.length === 1 && keys[editor.keys[0]]) {
    const k = editor.keys[0];
    const key = keys[k];
    /** @param {(x: any) => void} change @param {string} [coalesce] */
    const set = (change, coalesce) => editor.edit("anim", () => change(key), coalesce);
    const capture = () => {
      const shown = editor.shown();
      set((x) => {
        for (const n of Object.keys(x.values ?? {})) x.values[n] = Math.round((shown[n] ?? 0) * 100) / 100;
      });
    };
    return [
      section(`Key ${k}`, [
        row("at", num({ value: key.at ?? 0, step: 0.01, min: 0, onchange: (v) => set((x) => (x.at = v), "at") }), "seconds into the clip"),
        row("duration", num({ value: key.duration ?? 0, step: 0.01, min: 0, onchange: (v) => set((x) => (x.duration = v), "duration") }), "seconds to blend in; 0 snaps"),
        row("ease", select({ value: key.ease ?? "SMOOTH", options: EASES, onchange: (v) => set((x) => (x.ease = v)) })),
      ]),
      section(
        "Key values",
        driverValues(key.values, {
          onset: (n, v) => set((x) => ((x.values ??= {})[n] = v), `key-${k}-${n}`),
          onremove: (n) => set((x) => delete x.values?.[n]),
        }),
        { actions: [btn(icon("capture"), capture, { kind: "icon", title: "Capture: set this key's drivers to what the view shows now", disabled: !Object.keys(key.values ?? {}).length })] },
      ),
    ];
  }
  return [];
}

/**
 * gaitInspector tunes a procedural clip: its cycle, its legs' path and timing, the root's crouch
 * and bob, its waves and swings. Every change plays at once.
 * @param {any} clip
 */
function gaitInspector(clip) {
  const m = editor.model;
  const g = clip.gait;
  /** @param {(g: any) => void} change @param {string} key */
  const set = (change, key) => editor.edit("anim", () => change(g), `gait-${key}`);
  /** a slider over [min, max] for field `k` of `o` @param {any} o @param {string} k @param {number} min @param {number} max @param {string} key @param {boolean} [deg] */
  const field = (o, k, min, max, key, deg = false) => slider({ value: o[k] ?? 0, min, max, deg, onchange: (v) => set(() => (o[k] = Math.round(v * 1000) / 1000), key) });
  // lengths range over a few times the stride the preset chose (or the model's size)
  const size = Math.max(g.stride ?? 0, 1);
  const channels = editor.channels().map((c) => c.name);
  const instances = (m.assembly ?? []).map((/** @type {any} */ x) => x.name);
  const out = [
    section("Cycle", [
      row("duration", num({ value: clip.duration ?? 1, step: 0.05, min: 0.05, onchange: (v) => editor.edit("anim", () => (clip.duration = v), "gait-duration") }), "seconds a cycle takes; the clip loops"),
    ]),
  ];
  if (g.legs?.length)
    out.push(
      section("Legs", [
        row("stride", field(g, "stride", 0, 3 * size, "stride"), "how far each foot travels per step (model units)"),
        row("lift", field(g, "lift", 0, size, "lift"), "how high a foot swings"),
        row("duty", field(g, "duty", 0.05, 0.95, "duty"), "share of the cycle a foot is down: over 0.5 walks, under runs"),
        row("crouch", field(g, "crouch", 0, size, "crouch"), "how far the body sinks while moving: the knees bend"),
        row("bob", field(g, "bob", 0, size / 2, "bob"), "how far it dips more as each foot touches down"),
        ...g.legs.map((/** @type {any} */ l, /** @type {number} */ k) => row(`${l.ik} phase`, field(l, "phase", 0, 1, `phase${k}`), "when in the cycle this foot touches down")),
      ]),
    );
  if (g.waves?.length)
    out.push(
      section(
        "Waves",
        g.waves.map((/** @type {any} */ w, /** @type {number} */ k) =>
          h(
            "div",
            { class: "joint-item" },
            row("chain", [select({ value: w.from, options: instances, onchange: (v) => set(() => (w.from = v), `wf${k}`) }), select({ value: w.to, options: instances, onchange: (v) => set(() => (w.to = v), `wt${k}`) })], "from the head down to the tail"),
            row("axis", select({ value: w.axis ?? "X", options: ["X", "Y", "Z"], onchange: (v) => set(() => (w.axis = v), `wa${k}`) }), "Y: side to side (a snake); X: up and down (a fish's tail, a caterpillar)"),
            row("amount", field(w, "amount", 0, 1.2, `wm${k}`, true), "how far the body heads off to each side at the head (each joint turns only by the difference from the segment before, so turns do not pile up down the chain)"),
            row("length", field(w, "length", 0, 3, `wl${k}`), "wavelengths along the chain: more makes tighter S curves"),
            row("growth", field(w, "taper", -1, 3, `wp${k}`), "how the swing changes toward the tail: 0 the same all along, above 0 bigger (a whipping tail), -1 dying out at the tail"),
          ),
        ),
      ),
    );
  out.push(
    section(
      "Swings",
      [
        ...(g.swings ?? []).map((/** @type {any} */ w, /** @type {number} */ k) =>
          h(
            "div",
            { class: "joint-item" },
            row("channel", [select({ value: w.channel, options: channels, onchange: (v) => set(() => (w.channel = v), `sc${k}`) }), btn(icon("x"), () => set(() => (g.swings.splice(k, 1), g.swings.length || delete g.swings), `sx${k}`), { kind: "icon", title: "Remove this swing" })]),
            row("amount", field(w, "amount", -1, 1, `sm${k}`), "how far it swings (radians for a turn)"),
            row("rate", field(w, "rate", 0, 4, `sr${k}`), "times a cycle: 1 an arm's swing, 2 a bob"),
            row("phase", field(w, "phase", 0, 1, `sp${k}`), "when in the cycle it peaks"),
          ),
        ),
      ],
      {
        actions: [
          btn(icon("plus"), () => set(() => (g.swings ??= []).push({ channel: channels.find((n) => n === "root_turn_z") ?? channels[0], amount: 0.05, rate: 1 }), "swing-add"), {
            kind: "icon",
            title: "Swing a channel with the cycle: a sway, arms or a hull against the legs",
          }),
        ],
      },
    ),
  );
  return out;
}
