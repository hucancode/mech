// @ts-check
// Channel values, a row each, in the engine's order (the "channels" query), each its kind's control
// (mech.ChannelKind): a turn or a slide a slider over its range, a weight 0 to 1, a rotation or a
// position x, y, z. `full` lists every channel (at rest where the values leave it out); otherwise
// only those the values hold, each removable, with a dropdown to add one at rest. Values are by
// channel, shaped as it is: a number, or [x, y, z]. Turns and rotations show in degrees.
import { btn, h, select, slider, vec3 } from "../dom.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { channelRange, zeroValue } from "../model.js";

/** the kinds whose values are angles */
const ANGLES = ["HINGE", "BALL"];

/**
 * @param {Record<string, any> | undefined} values by channel (a move's, a pose's amounts: its `by`)
 * @param {{full?: boolean, onset: (values: Record<string, import("../model.js").Value>) => void, onremove?: (names: string[]) => void}} o
 */
export function channelValues(values, o) {
  const all = editor.channels();
  /** @type {Map<string, any>} every channel by name, in the engine's order */
  const channels = new Map(all.map((c) => [c.name, c]));
  const held = (/** @type {any} */ c) => values && c.name in values;
  const out = [];
  const channelRow = (/** @type {any} */ c) => {
    const deg = ANGLES.includes(c.kind);
    const now = values?.[c.name] ?? zeroValue(c);
    const field =
      c.size === 3
        ? vec3({ value: now, deg, step: deg ? 5 : 0.05, onchange: (v) => o.onset({ [c.name]: v }) })
        : (() => {
            const [lo, hi] = channelRange(c);
            return slider({ value: now, min: lo, max: hi, deg, onchange: (v) => o.onset({ [c.name]: v }) });
          })();
    return h(
      "div",
      { class: "channel", style: o.onremove ? undefined : { gridTemplateColumns: "110px 1fr" } },
      h("span", { class: "name", title: `${c.name}: ${c.kind.toLowerCase()}` }, c.name),
      field,
      o.onremove && btn(icon("x", 14), () => o.onremove?.([c.name]), { kind: "icon", title: "Remove" }),
    );
  };
  out.push(...(o.full ? all : all.filter(held)).map(channelRow));
  for (const name of Object.keys(values ?? {}).filter((n) => !channels.has(n))) {
    out.push(h("div", { class: "channel missing" }, h("span", { class: "name" }, name), h("span", null, "not in the model"), o.onremove && btn(icon("x", 14), () => o.onremove?.([name]), { kind: "icon", title: "Remove" })));
  }
  if (!o.full) {
    const addable = all.filter((c) => !held(c));
    if (addable.length) {
      out.push(
        select({
          value: "",
          none: "+ channel",
          cls: "add-channel",
          options: addable.map((c) => c.name),
          onchange: (name) => {
            const c = channels.get(name);
            if (c) o.onset({ [name]: zeroValue(c) });
          },
        }),
      );
    }
  }
  return out;
}
