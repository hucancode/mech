// @ts-check
// The Animation tab: the clips, and their motions (procedural: a pose held, a walk, a wave, a
// strike, each a shape over time added onto some channels; src/mech/animation.odin). A motion's
// shape and timing are drawn in the dock's curve editor (panels/curves.js); what it moves, here:
// its moves, each channel amounts moving together, `delay` cycles late, with their twins on the
// other side of the body (`twin`) when they say. The animation's arcs (paths a move can put a
// position on) are a list of their own: picked, one is edited in the view. So are its poses (named
// sets of amounts a move adds by name, times a number: a fist).
import { btn, CARET, h, list, num, row, section, select, text, vec3 } from "../dom.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { amountsOf, arcsOf, arcUsers, clone, deleteArc, deletePose, insertArcPoint, poseFromMove, poseNames, posesOf, poseUsers, removeArcPoint, renameArc, renamePose, setArcClosed, setArcCorner, uniqueName } from "../model.js";
import { arcHandle, pickedArcPoint } from "../gizmo.js";
import { motionLabel } from "../shapes.js";
import { channelValues } from "./channelValues.js";

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
    arcsSection(),
    posesSection(),
  ];
}

export function animInspector() {
  return [...(editor.arc && arcNamed(editor.arc) ? [arcInspector(arcNamed(editor.arc))] : []), ...(editor.clipData ? motionsInspector(editor.clipData) : [])];
}

/** the animation's arc named `name` @param {string} name @returns {any} */
const arcNamed = (name) => editor.anim.arcs?.find((/** @type {any} */ x) => x.name === name);

/** the positions an arc can move (the "channels" query's POSITION channels: IK targets, the root) @returns {string[]} */
const positions = () => editor.channels().filter((c) => c.kind === "POSITION").map((c) => c.name);

/** editArc picks arc `name` to edit (in the view and the inspector), "" for none @param {string} name */
function editArc(name) {
  editor.select(() => {
    editor.arc = editor.arc === name ? "" : name;
    editor.handle = "";
    if (editor.arc) {
      // shown where a move puts it, else on the first position
      editor.arcOn = arcUsers(editor.anim, name)[0]?.on ?? editor.arcOn ?? "";
      if (!positions().includes(editor.arcOn)) editor.arcOn = positions()[0] ?? "";
    }
  });
}

/** a new arc's name, free @param {string} base */
const freeArcName = (base) => uniqueName(base, (n) => !!arcNamed(n));

/**
 * newArc adds an open arc of two points to the animation, a little up and ahead from where its
 * position is at rest, and returns its name. @param {string} [base]
 */
function newArc(base = "arc") {
  const name = freeArcName(base);
  (editor.anim.arcs ??= []).push({ name, points: [[0, 0, 0], [0, 0.5, 0.5]] });
  return name;
}

/**
 * arcsSection lists the animation's arcs: paths in space a move can put a position on (an IK
 * target, the root), shared by every clip. Click one to edit it (again, or Esc, to stop); + adds
 * one, the bin deletes it and what names it.
 */
function arcsSection() {
  const arcs = editor.anim.arcs ?? [];
  const add = () => {
    let name = "";
    editor.edit("anim", () => (name = newArc()));
    editArc(name);
  };
  const remove = () => {
    const users = arcUsers(editor.anim, editor.arc);
    const where = users.map((u) => `${editor.anim.clips[u.clip].name} motion ${u.motion + 1} move ${u.move + 1}`).join(", ");
    if (users.length && !confirm(`Delete arc ${editor.arc}? ${where} use${users.length === 1 ? "s" : ""} it.`)) return;
    editor.edit("anim", () => {
      deleteArc(editor.anim, editor.arc);
      editor.arc = editor.handle = "";
    });
  };
  return section(
    "Arcs",
    [
      arcs.length === 0 && h("div", { class: "muted", style: { padding: "4px 0" } }, "Paths in space a move can put an IK target or the root on: a fist's strike, a lunge. Add one with +."),
      list(
        arcs,
        (x) => [h("span", { class: "name", style: { flex: "1" } }, x.name), h("span", { class: "tag", title: "points; moves naming it" }, `${x.points.length} pts · ${arcUsers(editor.anim, x.name).length} uses`)],
        (i) => arcs[i].name === editor.arc,
        (i) => editArc(arcs[i].name),
      ),
    ],
    {
      actions: [
        btn(icon("plus"), add, { kind: "icon", title: "Add an arc: an open path of two points, to edit in the view" }),
        btn(icon("trash"), remove, { kind: "icon", title: "Delete the arc being edited, and the moves' values naming it", disabled: !arcNamed(editor.arc) }),
      ],
    },
  );
}

/**
 * arcInspector: the arc being edited: its name (renamed through the moves naming it), the
 * position it shows on when no move shown uses it, its points (the one picked in the view, else
 * the last: typed in, a point added after it, removed), the moves using it (click to go there),
 * and assigning it to the picked move.
 * @param {any} arc
 */
function arcInspector(arc) {
  /** @param {() => void} change @param {string} [key] */
  const set = (change, key) => editor.edit("anim", change, key && `arc-${key}`);
  const points = arc.points;
  const p = pickedArcPoint();
  const i = Math.min(Math.max(p && p.name === arc.name ? p.i : points.length - 1, 0), points.length - 1);
  const pick = (/** @type {number} */ j) => (editor.handle = arcHandle(arc.name, j));
  const users = arcUsers(editor.anim, arc.name);
  const mo = editor.clipData?.motions?.[editor.motion];
  const mv = mo?.moves?.[editor.pickedMoves()[0] ?? 0];
  const assign = (/** @type {string} */ on) =>
    set(() => {
      mv.by = { ...(mv.by ?? {}), [on]: arc.name };
      editor.arcOn = on;
    });
  return section(
    `Arc ${arc.name}`,
    [
      row("name", text({ value: arc.name, onchange: (v) => v && v !== arc.name && !arcNamed(v) && set(() => (renameArc(editor.anim, arc.name, v), (editor.arc = v), (editor.handle = ""))) }), "the moves naming it are renamed with it"),
      row("shown on", select({ value: editor.arcOn, options: positions(), onchange: (v) => editor.select(() => (editor.arcOn = v)) }), "the position it is drawn on when no move of the motion shown puts one on it: its points are offsets from where that is at rest"),
      row(
        "points",
        [
          h("span", { class: "muted", style: { flex: "1" } }, `point ${i + 1} of ${points.length}`),
          btn("+", () => set(() => (insertArcPoint(editor.anim, arc, i) && editor.flash("Motions whose shape other moves follow too keep their shape: check their timing on the arc"), pick(i + 1))), { kind: "icon", title: "Add a point after this one, halfway to the next (or on past the last); the moves on the arc keep their timing" }),
          btn("−", () => set(() => (removeArcPoint(editor.anim, arc, i), pick(Math.max(i - 1, 0)))), { kind: "icon", title: "Remove this point (an arc keeps two); the moves on the arc keep their timing", disabled: points.length <= 2 }),
        ],
        "a move's shape says how far along (0 the first point, 1 the end, k / segments point k). Pick a point in the view to move it",
      ),
      row(
        "closed",
        h("input", { type: "checkbox", checked: !!arc.closed, onchange: (/** @type {Event} */ e) => set(() => setArcClosed(editor.anim, arc, /** @type {HTMLInputElement} */ (e.target).checked)) }),
        "on from its last point back to its first, smooth through it unless it is a corner (a foot's loop); open, it ends at its last point",
      ),
      row(
        "corner",
        h("input", { type: "checkbox", checked: (arc.corners ?? []).includes(i), onchange: (/** @type {Event} */ e) => set(() => setArcCorner(arc, i, /** @type {HTMLInputElement} */ (e.target).checked)) }),
        "a sharp point: the path turns hard there, and runs straight at a steady speed to a corner next to it (a foot on the ground, a piston's stroke, a punch driven straight)",
      ),
      row("point", vec3({ value: points[i], step: 0.01, digits: 3, onchange: (v) => set(() => (points[i] = v), `${arc.name}-${i}`) }), "an offset from where the position is at rest, in model units, as its own values are"),
      row(
        "used by",
        users.length
          ? users.map((u) =>
              btn(`${editor.anim.clips[u.clip].name} ${u.motion + 1}.${u.move + 1} ${u.on}`, () => editor.select(() => ((editor.clip = u.clip), (editor.motion = u.motion), (editor.picked = [u.motion]), (editor.moves = [u.move]), (editor.arcOn = u.on))), { title: "Go to the move: clip, motion.move, the position it moves" }),
            )
          : h("span", { class: "muted" }, "no move yet"),
      ),
      mv && row("", select({ value: "", none: "+ assign to the picked move", options: positions().filter((n) => n in (mv.by ?? {}) === false), onchange: (v) => v && assign(v) }), "put a position on this arc in the move picked (Motions): its shape moves it along"),
    ],
    { actions: [btn(icon("x"), () => editArc(arc.name), { kind: "icon", title: "Stop editing (Esc)" })] },
  );
}

/** the animation's pose named `name` @param {string} name @returns {any} */
const poseNamed = (name) => editor.anim.poses?.find((/** @type {any} */ x) => x.name === name);

/** whether `name` is free for a pose: no pose has it, and no channel (a channel's name wins) @param {string} name */
const poseFree = (name) => !!name && !poseNamed(name) && !editor.channels().some((c) => c.name === name);

/**
 * posesSection lists the animation's poses: named sets of amounts a move adds by name, times a
 * number (a fist, a guard), shared by every clip. Pick one to edit its amounts and name; the bin
 * deletes it and what adds it. A pose is made from a move ("make pose" on the move).
 */
function posesSection() {
  const poses = editor.anim.poses ?? [];
  const p = poseNamed(editor.pose ?? "");
  /** @param {() => void} change @param {string} [key] */
  const set = (change, key) => editor.edit("anim", change, key && `pose-${key}`);
  const remove = () => {
    const users = poseUsers(editor.anim, p.name);
    if (users.length && !confirm(`Delete pose ${p.name}? ${users.length} move${users.length === 1 ? "" : "s"} add${users.length === 1 ? "s" : ""} it.`)) return;
    set(() => {
      deletePose(editor.anim, p.name);
      editor.pose = "";
    });
  };
  return section(
    "Poses",
    [
      poses.length === 0 && h("div", { class: "muted", style: { padding: "4px 0" } }, "Named sets of amounts a move adds by name, times a number: a fist, a guard. Make one from a move's amounts (make pose)."),
      list(
        poses,
        (x) => [h("span", { class: "name", style: { flex: "1" } }, x.name), h("span", { class: "tag", title: "amounts; moves adding it" }, `${Object.keys(x.by ?? {}).length} ch · ${poseUsers(editor.anim, x.name).length} uses`)],
        (i) => poses[i].name === p?.name,
        (i) => editor.select(() => (editor.pose = editor.pose === poses[i].name ? "" : poses[i].name)),
      ),
      p && h("div", { style: { marginTop: "8px" } }, row("name", text({ value: p.name, onchange: (v) => v !== p.name && poseFree(v) && set(() => (renamePose(editor.anim, p.name, v), (editor.pose = v))) }), "the moves adding it are renamed with it")),
      ...(p
        ? channelValues(p.by, {
            onset: (vs) => set(() => (p.by = { ...(p.by ?? {}), ...vs }), `${p.name}-${Object.keys(vs).join()}`),
            onremove: (names) => set(() => (p.by = Object.fromEntries(Object.entries(p.by ?? {}).filter(([c]) => !names.includes(c))))),
          })
        : []),
    ],
    { actions: [btn(icon("trash"), remove, { kind: "icon", title: "Delete the pose picked, and the moves' values adding it", disabled: !p })] },
  );
}

/**
 * poseRows: the poses the move adds (mech.Pose, the animation's), each how much of it (✕ takes it
 * off), "+ pose" to add one, and "make pose" to make the move's amounts a new pose it adds instead.
 * @param {any} mv @param {(change: () => void, key?: string) => void} set
 */
function poseRows(mv, set) {
  const names = poseNames(editor.anim);
  const on = posesOf(mv.by, names);
  const free = [...names].filter((n) => !(n in on));
  const make = () => {
    const name = prompt("Name the new pose (a fist, a guard):", uniqueName("pose", (n) => !poseFree(n)));
    if (!name) return;
    if (!poseFree(name)) return editor.flash(`${name} is taken: a pose or a channel has it`);
    set(() => poseFromMove(editor.anim, mv, name));
  };
  return [
    ...Object.entries(on).map(([name, v]) =>
      row(
        `${name} pose`,
        [num({ value: v, step: 0.05, digits: 3, onchange: (x) => set(() => (mv.by[name] = Math.round(x * 1e4) / 1e4), `pose-${name}`) }), btn(icon("x", 14), () => set(() => delete mv.by[name]), { kind: "icon", title: "Stop adding the pose" })],
        "how much of the pose's amounts the move adds (1 all of them, 0.5 half), its twin and delay applying to them",
      ),
    ),
    row(
      "",
      [
        free.length > 0 && select({ value: "", none: "+ pose", options: free, onchange: (n) => n && set(() => (mv.by = { ...(mv.by ?? {}), [n]: 1 })) }),
        btn("make pose", make, { title: "Make the move's amounts a new pose, which the move then adds (reuse it in other moves)", disabled: Object.keys(amountsOf(mv.by, names)).length === 0 }),
      ],
      "poses: named sets of amounts (Poses, in the sidebar)",
    ),
  ];
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
 * arcRows: the positions the move puts on arcs (mech.Arc, the animation's): which arc each
 * follows (switch it; ✕ takes it off; ✎ edits the arc in the view), and "+ arc" to put another
 * position on one (the arc being edited, or a new one).
 * @param {any} mv @param {(change: () => void, key?: string) => void} set
 */
function arcRows(mv, set) {
  const on = arcsOf(mv.by);
  const names = (editor.anim.arcs ?? []).map((/** @type {any} */ x) => x.name);
  const free = positions().filter((n) => !(n in (mv.by ?? {})));
  const add = (/** @type {string} */ pos) => {
    let name = editor.arc && arcNamed(editor.arc) ? editor.arc : "";
    set(() => {
      if (!name) name = newArc(`${pos}_arc`);
      mv.by = { ...(mv.by ?? {}), [pos]: name };
      editor.arcOn = pos;
    });
    if (editor.arc !== name) editArc(name);
  };
  return [
    ...Object.entries(on).map(([pos, name]) =>
      row(
        `${pos} arc`,
        [
          select({ value: name, options: names, onchange: (v) => set(() => (mv.by[pos] = v)) }),
          btn("✎", () => editArc(name), { kind: "icon", title: "Edit this arc in the view", on: editor.arc === name }),
          btn(icon("x", 14), () => set(() => delete mv.by[pos]), { kind: "icon", title: "Take the position off the arc" }),
        ],
        arcNamed(name) ? "the position follows this arc: its shape's value is how far along" : "the animation has no arc of this name: the engine skips it",
      ),
    ),
    free.length && row("", select({ value: "", none: editor.arc ? `+ arc ${editor.arc}` : "+ arc (new)", options: free, onchange: (v) => v && add(v) }), "put a position (an IK target, the root) on an arc: the one being edited, else a new one"),
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
          row(
            "spread",
            num({ value: mv.spread ?? 0, step: 0.05, digits: 3, onchange: (v) => set(() => ((v = Math.round(v * 1e4) / 1e4), v ? (mv.spread = v) : delete mv.spread), `spread${k}-${n}`) }),
            "cycles from its first channel to its last, one after another in the model's order (down a chain): a wave down a spine, an arm firing shoulder, elbow, wrist",
          ),
          row(
            "twin",
            select({ value: mv.twin, none: "none", options: ["WITH", "OPPOSITE"], onchange: (v) => set(() => (v ? (mv.twin = v) : delete mv.twin), `twin${k}-${n}`) }),
            "the other side of the body too, by the same amounts: WITH at the same time (both hands opening), OPPOSITE half a cycle later (the other foot, the other arm swinging back)",
          ),
          ...(open
            ? channelValues(amountsOf(mv.by, poseNames(editor.anim)), {
                onset: (vs) => set(() => (mv.by = { ...(mv.by ?? {}), ...vs }), `move${k}-${n}-${Object.keys(vs).join()}`),
                onremove: (names) => set(() => (mv.by = Object.fromEntries(Object.entries(mv.by ?? {}).filter(([c]) => !names.includes(c))))),
              })
            : []),
          ...(open ? poseRows(mv, set) : []),
          ...(open ? arcRows(mv, set) : []),
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
