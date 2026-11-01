// @ts-check
// Driver values grouped by body part, a slider each; the root's channels with them, and each three
// that go together (an IK target's x, y, z, the root's move and turn) as one vector. `full` lists
// every driver (0 where the values leave it out); otherwise only those the values hold, each
// removable, with a dropdown to add one at the value the viewer shows now. Values are as the
// drivers take them (degrees shown for drivers that turn joints, and the root's turn).
import { btn, CARET, h, select, slider, vec3 } from "../dom.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { angularDrivers, driverRange, groupDrivers, vectors } from "../model.js";

/** @type {Set<string>} groups the user folded */
const folded = new Set();

/**
 * @param {Record<string, number> | undefined} values
 * @param {{full?: boolean, onset: (name: string, v: number) => void, onremove?: (name: string) => void}} o
 */
export function driverValues(values, o) {
  const drivers = editor.model.drivers ?? [];
  const root = editor.rootChannels();
  const angular = new Set([...angularDrivers(editor.model), ...root.turn]);
  /** @type {Map<string, any>} every channel by name: the drivers, then the root's */
  const channels = new Map([...drivers, ...[...root.move, ...root.turn].map((name) => ({ name }))].map((c) => [c.name, c]));
  const entries = vectors([...channels.keys()]);
  const held = (/** @type {import("../model.js").Entry} */ e) => e.names.some((n) => values && n in values);
  const shown = o.full ? entries : entries.filter(held);
  const out = [];
  for (const [group, list] of groupDrivers(shown)) {
    const body = h(
      "div",
      { style: folded.has(group) ? { display: "none" } : undefined },
      list.map((/** @type {import("../model.js").Entry} */ e) => {
        const deg = angular.has(e.names[0]);
        let field;
        if (e.names.length === 3) {
          const now = e.names.map((n) => values?.[n] ?? 0);
          // only what changed is set: a vector the values hold part of keeps the rest out
          field = vec3({ value: now, deg, step: deg ? 5 : 0.05, onchange: (v) => e.names.forEach((n, k) => v[k] !== now[k] && o.onset(n, v[k])) });
        } else {
          const [lo, hi] = driverRange(channels.get(e.name));
          field = slider({ value: values?.[e.name] ?? 0, min: lo, max: hi, deg, onchange: (v) => o.onset(e.name, v) });
        }
        return h(
          "div",
          { class: "channel", style: o.onremove ? undefined : { gridTemplateColumns: "110px 1fr" } },
          h("span", { class: "name", title: e.names.join(", ") }, e.name),
          field,
          o.onremove && btn(icon("x", 14), () => e.names.forEach((n) => values && n in values && o.onremove?.(n)), { kind: "icon", title: "Remove from this key" }),
        );
      }),
    );
    const caret = h("span", { class: `caret ${folded.has(group) ? "" : "open"}` }, CARET);
    const title = h("button", { class: "group-title" }, caret, group, h("span", { class: "count" }, list.length));
    title.addEventListener("click", () => {
      folded.has(group) ? folded.delete(group) : folded.add(group);
      body.style.display = folded.has(group) ? "none" : "";
      caret.classList.toggle("open", !folded.has(group));
    });
    out.push(h("div", { class: "group" }, title, body));
  }
  for (const name of Object.keys(values ?? {}).filter((n) => !channels.has(n))) {
    out.push(h("div", { class: "channel missing" }, h("span", { class: "name" }, name), h("span", null, "not in the model"), o.onremove && btn(icon("x", 14), () => o.onremove?.(name), { kind: "icon", title: "Remove" })));
  }
  if (!o.full) {
    const addable = entries.filter((e) => !held(e));
    if (addable.length) {
      const add = select({
        value: "",
        none: "+ driver",
        options: groupDrivers(addable).map(([g, list]) => /** @type {[string, string[]]} */ ([g, list.map((e) => e.name)])),
        onchange: (name) => {
          const e = addable.find((x) => x.name === name);
          const now = editor.shown();
          e?.names.forEach((n) => o.onset(n, Math.round((now[n] ?? 0) * 100) / 100));
        },
      });
      add.classList.add("add-channel");
      out.push(add);
    }
  }
  return out;
}
