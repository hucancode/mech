// @ts-check
// Channel values, a slider each, in the engine's order; the root's channels with them, and each three
// that go together (an IK target's x, y, z, the root's move and turn) as one vector. `full` lists
// every channel (0 where the values leave it out); otherwise only those the values hold, each
// removable (a vector whole), with a dropdown to add one at 0. A vector is set whole: a move holds
// an IK target's x, y, z as one value. Values are as the channels take them (degrees shown for
// those that turn joints, and the root's turn).
import { btn, h, select, slider, vec3 } from "../dom.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { driverRange, vectors } from "../model.js";

/**
 * @param {Record<string, number> | undefined} values one per channel (flatValues)
 * @param {{full?: boolean, onset: (values: Record<string, number>) => void, onremove?: (names: string[]) => void}} o
 */
export function driverValues(values, o) {
  const all = editor.channels();
  const angular = new Set(all.filter((c) => c.angle).map((c) => c.name));
  /** @type {Map<string, any>} every channel by name, in the engine's order */
  const channels = new Map(all.map((c) => [c.name, c]));
  const entries = vectors([...channels.keys()]);
  const held = (/** @type {import("../model.js").Entry} */ e) => e.names.some((n) => values && n in values);
  const shown = o.full ? entries : entries.filter(held);
  const out = [];
  const channelRow = (/** @type {import("../model.js").Entry} */ e) => {
    const deg = angular.has(e.names[0]);
    let field;
    if (e.names.length === 3) {
      const now = e.names.map((n) => values?.[n] ?? 0);
      field = vec3({ value: now, deg, step: deg ? 5 : 0.05, onchange: (v) => o.onset(Object.fromEntries(e.names.map((n, k) => [n, v[k]]))) });
    } else {
      const [lo, hi] = driverRange(channels.get(e.name));
      field = slider({ value: values?.[e.name] ?? 0, min: lo, max: hi, deg, onchange: (v) => o.onset({ [e.name]: v }) });
    }
    return h(
      "div",
      { class: "channel", style: o.onremove ? undefined : { gridTemplateColumns: "110px 1fr" } },
      h("span", { class: "name", title: e.names.join(", ") }, e.name),
      field,
      o.onremove && btn(icon("x", 14), () => o.onremove?.(e.names), { kind: "icon", title: "Remove" }),
    );
  };
  out.push(...shown.map(channelRow));
  for (const name of Object.keys(values ?? {}).filter((n) => !channels.has(n))) {
    out.push(h("div", { class: "channel missing" }, h("span", { class: "name" }, name), h("span", null, "not in the model"), o.onremove && btn(icon("x", 14), () => o.onremove?.([name]), { kind: "icon", title: "Remove" })));
  }
  if (!o.full) {
    const addable = entries.filter((e) => !held(e));
    if (addable.length) {
      const add = select({
        value: "",
        none: "+ channel",
        options: addable.map((e) => e.name),
        onchange: (name) => {
          const e = addable.find((x) => x.name === name);
          if (e) o.onset(Object.fromEntries(e.names.map((n) => [n, 0])));
        },
      });
      add.classList.add("add-channel");
      out.push(add);
    }
  }
  return out;
}
