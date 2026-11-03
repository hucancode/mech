// @ts-check
// The Animation tab: the clips, and their motions (procedural: a pose held, a walk, a wave, a
// strike, each a shape over time added onto some channels; src/mech/animation.odin). A motion's
// shape and timing are drawn in the dock's curve editor (panels/curves.js); what it moves, here:
// its moves, each channel amounts moving together, `delay` cycles late.
import { btn, CARET, h, list, num, row, section, text } from "../dom.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { clone, flatValues, packValues, uniqueName } from "../model.js";
import { motionLabel } from "../shapes.js";
import { driverValues } from "./driverValues.js";

export function animSidebar() {
  const a = editor.anim;
  /** @param {boolean} copy */
  const addClip = (copy) =>
    editor.edit("anim", () => {
      a.clips ??= [];
      const src = copy ? a.clips[editor.clip] : undefined;
      const c = src ? clone(src) : { name: "clip", duration: 1 };
      c.name = uniqueName(c.name, (n) => a.clips.some((/** @type {any} */ x) => x.name === n));
      a.clips.push(c);
      editor.clip = a.clips.length - 1;
    });
  const removeClip = () => {
    if (!confirm(`Delete clip ${a.clips[editor.clip].name}?`)) return;
    editor.edit("anim", () => {
      a.clips.splice(editor.clip, 1);
      editor.clip = Math.max(0, editor.clip - 1);
    });
  };
  const clip = editor.clipData;
  return [
    section(
      "Clips",
      [
        list(
          a.clips ?? [],
          (c) => [h("span", { class: "name", style: { flex: "1" } }, c.name), h("span", { class: "tag" }, `${+(c.duration ?? 0).toFixed(2)}s`)],
          (i) => i === editor.clip,
          (i) => editor.pickClip(i),
        ),
        clip && h("div", { style: { marginTop: "8px" } }, row("name", text({ value: clip.name, onchange: (v) => editor.edit("anim", () => (clip.name = v)) }))),
      ],
      {
        actions: [
          btn(icon("plus"), () => addClip(false), { kind: "icon", title: "Add an empty clip" }),
          btn(icon("copy"), () => addClip(true), { kind: "icon", title: "Duplicate the clip", disabled: !clip }),
          btn(icon("trash"), removeClip, { kind: "icon", title: "Delete the clip", disabled: !clip }),
        ],
      },
    ),
    clip && motionsSection(clip),
  ];
}

export function animInspector() {
  return editor.clipData ? motionsInspector(editor.clipData) : [];
}

/** a click that adds to what is picked (shift, cmd or ctrl) @param {MouseEvent} e */
const adds = (e) => e.shiftKey || e.metaKey || e.ctrlKey;

/**
 * motionsSection lists the clip's motions (the engine's Motion), in the sidebar: click picks one
 * (the dock and the inspector show it), shift- or cmd-click picks several. Isolate plays only those
 * picked; merge appends the others' moves to the last picked, and removes them.
 * @param {any} clip
 */
function motionsSection(clip) {
  const motions = clip.motions ?? [];
  const picked = editor.pickedMotions();
  /** @param {() => void} change */
  const set = (change) => editor.edit("anim", change);
  /** after an edit, motion `i` alone is picked @param {number} i */
  const only = (i) => ((editor.motion = i), (editor.picked = [i]), (editor.moves = []), (editor.openMoves = []));
  // a new motion holds a pose: drag the view's handles to set it, or give it a shape in the dock
  const add = () =>
    set(() => {
      (clip.motions ??= []).push({ moves: [{ by: {} }] });
      only(clip.motions.length - 1);
      editor.openMoves = [0];
    });
  const merge = () => {
    const into = /** @type {number} */ (picked.at(-1));
    const from = picked.slice(0, -1).sort((p, q) => p - q);
    set(() => {
      const target = clip.motions[into];
      for (const k of from) target.moves = [...(target.moves ?? []), ...(clip.motions[k].moves ?? [])];
      clip.motions = clip.motions.filter((/** @type {any} */ _, /** @type {number} */ k) => !from.includes(k));
      only(into - from.filter((k) => k < into).length);
    });
  };
  const remove = () =>
    set(() => {
      clip.motions = motions.filter((/** @type {any} */ _, /** @type {number} */ k) => !picked.includes(k));
      only(Math.max(0, Math.min(...picked) - 1));
      if (!clip.motions.length) delete clip.motions;
    });
  const into = picked.length > 1 ? picked.at(-1) : -1;
  return section(
    "Motions",
    [
      motions.length === 0 && h("div", { class: "muted", style: { padding: "4px 0" } }, "A shape over time added onto some channels: a pose held, a step, a swing, a strike. Add one with +, then pose it with the view's handles."),
      list(
        motions,
        (m, i) => [h("span", { class: "name", style: { flex: "1" } }, motionLabel(m)), i === into && h("span", { class: "tag", title: "Merge appends the other picked motions' moves to this one" }, "into")],
        (i) => picked.includes(i),
        (i, e) => editor.pickMotion(i, adds(e)),
      ),
    ],
    {
      actions: [
        btn(icon("eye"), () => editor.setIsolate(!editor.isolate), { kind: "icon", on: editor.isolate, title: "Isolate: play only the picked motions (shift-click to pick several)", disabled: !motions.length }),
        btn(icon("merge"), merge, { kind: "icon", title: "Merge: append the other picked motions' moves to the last one picked, and remove them", disabled: picked.length < 2 }),
        btn(icon("plus"), add, { kind: "icon", title: "Add a motion holding a pose: set it with the view's handles, shape it in the dock" }),
        btn(icon("trash"), remove, { kind: "icon", title: "Remove the picked motions", disabled: !picked.length }),
      ],
    },
  );
}

/**
 * motionsInspector shows the clip's length and the motion shown: its rate and what it moves (its
 * moves' amounts and delays). Its shape is drawn in the dock; the motions are listed in the
 * sidebar. Every change plays at once.
 * @param {any} clip
 */
function motionsInspector(clip) {
  const motions = clip.motions ?? [];
  const k = Math.min(editor.motion, Math.max(motions.length - 1, 0));
  const mo = motions[k];
  /** @param {() => void} change @param {string} [key] */
  const set = (change, key) => editor.edit("anim", change, key && `motion-${key}`);
  return [
    section("Clip", [row("duration", num({ value: clip.duration ?? 1, step: 0.05, min: 0.05, onchange: (v) => set(() => (clip.duration = v), "duration") }), "seconds; a motion's rate counts its cycles over it")]),
    mo && motionPanel(clip, mo, k, set),
  ];
}

/**
 * the motion shown: its rate, then its moves (channels moving together, each `delay` cycles
 * late), picked by clicking their heads (shift- or cmd-click for several). Split moves the picked
 * moves into a motion of their own, shaped as this one.
 * @param {any} clip @param {any} mo @param {number} k @param {(change: () => void, key?: string) => void} set
 */
function motionPanel(clip, mo, k, set) {
  const moves = mo.moves ?? [];
  const picked = editor.pickedMoves();
  const split = () =>
    set(() => {
      const { moves: all, ...rest } = mo;
      clip.motions.splice(k + 1, 0, { ...clone(rest), moves: picked.map((n) => all[n]) });
      mo.moves = all.filter((/** @type {any} */ _, /** @type {number} */ n) => !picked.includes(n));
      editor.motion = k + 1;
      editor.picked = [k + 1];
      editor.moves = [];
      editor.openMoves = [];
    });
  const removeMoves = () =>
    set(() => {
      mo.moves = moves.filter((/** @type {any} */ _, /** @type {number} */ n) => !picked.includes(n));
      editor.moves = [];
      editor.openMoves = [];
    });
  const addMove = () =>
    set(() => {
      (mo.moves ??= []).push({ by: {} });
      // a new move opens, to add its channels
      editor.openMoves = [...editor.openMoves, mo.moves.length - 1];
    });
  return section(
    "Motion",
    [
      row(
        "rate",
        num({ value: mo.rate ?? 1, step: 1, min: 1, digits: 0, onchange: (v) => set(() => ((v = Math.max(1, Math.round(v))), v === 1 ? delete mo.rate : (mo.rate = v)), `rate${k}`) }),
        "whole cycles of its shape over the clip, so a loop never jumps: 1 a step or a swing, 2 a biped's bob (one a step)",
      ),
      ...moves.map((/** @type {any} */ mv, /** @type {number} */ n) => {
        // folded, a move shows its channels' names; unfolded (the caret), their amounts to edit
        const open = editor.openMoves.includes(n);
        const names = Object.keys(mv.by ?? {});
        return h(
          "div",
          { class: `joint-item ${picked.includes(n) ? "on" : ""}` },
          h(
            "button",
            { class: `item ${picked.includes(n) ? "on" : ""}`, title: "Pick this move (shift- or cmd-click: pick several, to split them off). The view's handles pose the move picked", onclick: (/** @type {MouseEvent} */ e) => editor.pickMove(n, adds(e)) },
            h(
              "span",
              { class: "name", style: { display: "flex", alignItems: "center", gap: "6px", flex: "1", minWidth: "0" } },
              h("span", { class: `caret ${open ? "open" : ""}`, title: open ? "Fold: show its channels' names only" : "Unfold: edit its amounts", onclick: (/** @type {MouseEvent} */ e) => (e.stopPropagation(), editor.toggleMove(n)) }, CARET),
              h("span", { style: { flex: "none" } }, `move ${n + 1}`),
              // folded, its channels' names follow the title, cut off where the line ends (all in the tooltip)
              !open && h("span", { class: "muted name", style: { flex: "1", minWidth: "0" }, title: names.join(", ") }, names.length ? names.join(", ") : "no channels yet"),
            ),
          ),
          row(
            "delay",
            num({ value: mv.delay ?? 0, step: 0.05, digits: 3, onchange: (v) => set(() => ((v = Math.round(v * 1e4) / 1e4), v ? (mv.delay = v) : delete mv.delay), `delay${k}-${n}`) }),
            "cycles late: the other foot half a cycle, a strike's next link a little; or drag its lane in the dock",
          ),
          ...(open
            ? driverValues(flatValues(mv.by), {
                onset: (vs) => set(() => (mv.by = packValues({ ...flatValues(mv.by), ...vs })), `move${k}-${n}-${Object.keys(vs).join()}`),
                onremove: (names) => set(() => (mv.by = packValues(Object.fromEntries(Object.entries(flatValues(mv.by)).filter(([c]) => !names.includes(c)))))),
              })
            : []),
        );
      }),
    ],
    {
      actions: [
        btn(icon("split"), split, { kind: "icon", title: "Split: move the picked moves into a motion of their own, shaped as this one", disabled: !picked.length || picked.length === moves.length }),
        btn(icon("x"), removeMoves, { kind: "icon", title: "Remove the picked moves", disabled: !picked.length }),
        btn(icon("plus"), addMove, { kind: "icon", title: "Add a move: channels moving together, at a delay of their own" }),
      ],
    },
  );
}
