// @ts-check
// The Animation tab: the clips, and the selected key. The timeline is in the dock.
import { btn, h, list, num, row, section, select, text } from "../dom.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { clone, EASES, uniqueName } from "../model.js";
import { driverValues } from "./driverValues.js";

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
          (i) => i === editor.clip,
          (i) =>
            editor.select(() => {
              editor.clip = i;
              editor.keys = [];
              editor.time = 0;
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
  ];
}

export function animInspector() {
  const keys = editor.clipData?.keys ?? [];
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
