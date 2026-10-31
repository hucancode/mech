// @ts-check
// The Animation tab: clips and poses, and the selected key or pose. The timeline is in the dock.
import { btn, h, list, num, row, section, select, text } from "../dom.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { BLENDS, clone, EASES, renamePose, uniqueName } from "../model.js";
import { channelValues } from "./channelValues.js";

export function animSidebar() {
  const a = editor.anim;
  /** @param {boolean} copy */
  const addClip = (copy) =>
    editor.edit("anim", () => {
      a.clips ??= [];
      const src = copy ? a.clips[editor.clip] : undefined;
      const c = src ? clone(src) : { name: "clip", duration: 1, keys: a.poses?.length ? [{ pose: a.poses[0].name }] : [] };
      c.name = uniqueName(c.name, (n) => a.clips.some((/** @type {any} */ x) => x.name === n));
      a.clips.push(c);
      editor.clip = a.clips.length - 1;
      editor.keys = [];
      editor.showPose = false;
    });
  const removeClip = () => {
    if (!confirm(`Delete clip ${a.clips[editor.clip].name}?`)) return;
    editor.edit("anim", () => {
      a.clips.splice(editor.clip, 1);
      editor.clip = Math.max(0, editor.clip - 1);
      editor.keys = [];
    });
  };
  /** @param {boolean} copy */
  const addPose = (copy) =>
    editor.edit("anim", () => {
      a.poses ??= [];
      const src = copy ? a.poses[editor.pose] : undefined;
      const p = src ? clone(src) : { name: "pose", values: {} };
      p.name = uniqueName(p.name, (n) => a.poses.some((/** @type {any} */ x) => x.name === n));
      a.poses.push(p);
      editor.pose = a.poses.length - 1;
      editor.showPose = true;
    });
  const removePose = () => {
    const p = a.poses[editor.pose];
    const used = (a.clips ?? []).some((/** @type {any} */ c) => c.keys?.some((/** @type {any} */ k) => k.pose === p.name));
    if (!confirm(`Delete pose ${p.name}?${used ? " Keys that use it will hold nothing." : ""}`)) return;
    editor.edit("anim", () => {
      a.poses.splice(editor.pose, 1);
      editor.pose = -1;
      editor.showPose = false;
    });
  };
  const clip = editor.clipData;
  return [
    section(
      "Clips",
      [
        list(
          a.clips ?? [],
          (c) => [
            h("span", { class: "name", style: { flex: "1" } }, c.name),
            h("span", { class: "tag" }, `${+(c.duration ?? 0).toFixed(2)}s`),
            h("span", { class: "tag count-key", title: `${c.keys?.length ?? 0} key frames` }, icon("key", 12), c.keys?.length ?? 0),
          ],
          (i) => i === editor.clip && !editor.showPose,
          (i) =>
            editor.select(() => {
              editor.clip = i;
              editor.keys = [];
              editor.time = 0;
              editor.showPose = false;
            }),
        ),
        clip && h("div", { style: { marginTop: "8px" } }, row("name", text({ value: clip.name, onchange: (v) => editor.edit("anim", () => (clip.name = v)) }))),
      ],
      {
        actions: [
          btn(icon("plus"), () => addClip(false), { kind: "icon", title: "Add a clip" }),
          btn(icon("copy"), () => addClip(true), { kind: "icon", title: "Duplicate the clip", disabled: !clip }),
          btn(icon("trash"), removeClip, { kind: "icon", title: "Delete the clip", disabled: !clip }),
        ],
      },
    ),
    section(
      "Poses",
      list(
        a.poses ?? [],
        (p) => [h("span", { class: "name" }, p.name), h("span", { class: "tag", title: "channels it sets" }, Object.keys(p.values ?? {}).length)],
        (i) => i === editor.pose && editor.showPose,
        (i) =>
          editor.select(() => {
            editor.pose = i;
            editor.showPose = true;
            editor.playing = false;
          }),
      ),
      {
        actions: [
          btn(icon("plus"), () => addPose(false), { kind: "icon", title: "Add a pose" }),
          btn(icon("copy"), () => addPose(true), { kind: "icon", title: "Duplicate the pose", disabled: editor.pose < 0 }),
          btn(icon("trash"), removePose, { kind: "icon", title: "Delete the pose", disabled: editor.pose < 0 }),
        ],
      },
    ),
  ];
}

export function animInspector() {
  const a = editor.anim;
  if (editor.showPose && a.poses?.[editor.pose]) {
    const p = a.poses[editor.pose];
    const i = editor.pose;
    return [
      section("Pose", [
        row("name", text({ value: p.name, onchange: (v) => editor.edit("anim", () => (renamePose(a, p.name, v), (p.name = v))) })),
      ]),
      section(
        "Values",
        channelValues(p.values, {
          onset: (n, v) => editor.edit("anim", () => ((p.values ??= {})[n] = v), `pose-${i}-${n}`),
          onremove: (n) => editor.edit("anim", () => delete p.values?.[n]),
        }),
      ),
    ];
  }
  const keys = editor.clipData?.keys ?? [];
  if (editor.keys.length === 1 && keys[editor.keys[0]]) {
    const k = editor.keys[0];
    const key = keys[k];
    /** @param {(x: any) => void} change @param {string} [coalesce] */
    const set = (change, coalesce) => editor.edit("anim", () => change(key), coalesce);
    // promote turns the key into a pose: its channels (on top of the pose it named) become a new
    // named pose, and the key plays that pose
    const promote = () => {
      const name = prompt("Name of the new pose", uniqueName("pose", (n) => (a.poses ?? []).some((/** @type {any} */ p) => p.name === n)))?.trim();
      if (!name) return;
      if ((a.poses ?? []).some((/** @type {any} */ p) => p.name === name)) return alert(`A pose named ${name} exists.`);
      editor.edit("anim", () => {
        const base = (a.poses ?? []).find((/** @type {any} */ p) => p.name === key.pose);
        a.poses ??= [];
        a.poses.push({ name, values: { ...(base?.values ?? {}), ...(key.values ?? {}) } });
        key.pose = name;
        delete key.values;
      });
    };
    // demote copies the pose into the key (under the key's own values) and drops the reference:
    // the clip plays the same, and no longer follows the pose
    const demote = () =>
      set((x) => {
        const p = (a.poses ?? []).find((/** @type {any} */ q) => q.name === x.pose);
        x.values = { ...(p?.values ?? {}), ...(x.values ?? {}) };
        delete x.pose;
      });
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
        row("blend", select({ value: key.blend ?? "REPLACE", options: BLENDS, onchange: (v) => set((x) => (x.blend = v)) })),
        row("priority", num({ value: key.priority ?? 0, step: 1, digits: 0, onchange: (v) => set((x) => (x.priority = Math.round(v)), "priority") }), "keys apply from the lowest priority up"),
        row("pose", select({ value: key.pose, none: "(none)", options: (a.poses ?? []).map((/** @type {any} */ p) => p.name), onchange: (v) => set((x) => (v ? (x.pose = v) : delete x.pose)) })),
      ]),
      sharedPose(key, demote),
      section(
        "Key values (this clip only)",
        channelValues(key.values, {
          onset: (n, v) => set((x) => ((x.values ??= {})[n] = v), `key-${k}-${n}`),
          onremove: (n) => set((x) => delete x.values?.[n]),
        }),
        { actions: [btn(icon("promote"), promote, { kind: "icon", title: "Promote to a pose: make this key's channels a named pose, and have the key play it", disabled: !Object.keys(key.values ?? {}).length }), btn(icon("capture"), capture, { kind: "icon", title: "Capture: set this key's channels to what the view shows now", disabled: !Object.keys(key.values ?? {}).length })] },
      ),
    ];
  }
  return [];
}

/**
 * sharedPose is the pose a key plays, edited in place: a change is to the pose itself, so every
 * key that plays it, in every clip, changes with it.
 * @param {any} key
 * @param {() => void} demote
 */
function sharedPose(key, demote) {
  const a = editor.anim;
  const i = (a.poses ?? []).findIndex((/** @type {any} */ p) => p.name === key.pose);
  if (i < 0) return null;
  const p = a.poses[i];
  const users = (a.clips ?? []).flatMap((/** @type {any} */ c) => (c.keys ?? []).filter((/** @type {any} */ k) => k.pose === p.name).map(() => c.name));
  const clips = new Set(users).size;
  return section(
    `Pose ${p.name} (shared)`,
    channelValues(p.values, {
      onset: (n, v) => editor.edit("anim", () => ((p.values ??= {})[n] = v), `pose-${i}-${n}`),
      onremove: (n) => editor.edit("anim", () => delete p.values?.[n]),
    }),
    {
      actions: [
        h("span", { class: "tag", title: `Edits here change the pose: ${users.length} keys in ${clips} clips play it` }, `${users.length}×`),
        btn(icon("demote"), demote, { kind: "icon", title: "Demote to key values: copy the pose into this key, which stops following the pose" }),
      ],
    },
  );
}
