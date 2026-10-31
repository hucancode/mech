// @ts-check
// Channel values grouped by body part, a slider each. `full` lists every channel a pose can set
// (0 where the values leave it out); otherwise only the channels the values hold, each removable,
// with a dropdown to add one at the value the viewer shows now. Values are in channel units.
import { btn, h, select, slider } from "../dom.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { angularChannels, channelRange, drivenChannels, groupChannels } from "../model.js";

/** @type {Set<string>} groups the user folded */
const folded = new Set();

/**
 * @param {Record<string, number> | undefined} values
 * @param {{full?: boolean, onset: (name: string, v: number) => void, onremove?: (name: string) => void}} o
 */
export function channelValues(values, o) {
  const channels = editor.model.channels ?? [];
  const driven = drivenChannels(editor.model);
  const angular = angularChannels(editor.model);
  const shown = o.full ? channels.filter((/** @type {any} */ c) => !driven.has(c.name)) : channels.filter((/** @type {any} */ c) => values && c.name in values);
  const out = [];
  for (const [group, list] of groupChannels(shown)) {
    const body = h(
      "div",
      { style: folded.has(group) ? { display: "none" } : undefined },
      list.map((c) => {
        const [lo, hi] = channelRange(c);
        return h(
          "div",
          { class: "channel", style: o.onremove ? undefined : { gridTemplateColumns: "110px 1fr" } },
          h("span", { class: "name", title: c.name }, c.name),
          slider({ value: values?.[c.name] ?? 0, min: lo, max: hi, deg: angular.has(c.name), onchange: (v) => o.onset(c.name, v) }),
          o.onremove && btn(icon("x", 14), () => o.onremove?.(c.name), { kind: "icon", title: "Remove from this key" }),
        );
      }),
    );
    const caret = h("span", { class: `caret ${folded.has(group) ? "" : "open"}` }, "▸");
    const title = h("button", { class: "group-title" }, caret, group, h("span", { class: "count" }, list.length));
    title.addEventListener("click", () => {
      folded.has(group) ? folded.delete(group) : folded.add(group);
      body.style.display = folded.has(group) ? "none" : "";
      caret.classList.toggle("open", !folded.has(group));
    });
    out.push(h("div", { class: "group" }, title, body));
  }
  for (const name of Object.keys(values ?? {}).filter((n) => !channels.some((/** @type {any} */ c) => c.name === n))) {
    out.push(h("div", { class: "channel missing" }, h("span", { class: "name" }, name), h("span", null, "not in the model"), o.onremove && btn(icon("x", 14), () => o.onremove?.(name), { kind: "icon", title: "Remove" })));
  }
  if (!o.full) {
    const addable = channels.filter((/** @type {any} */ c) => !driven.has(c.name) && !(values && c.name in values));
    if (addable.length) {
      const add = select({
        value: "",
        none: "+ channel",
        options: groupChannels(addable).map(([g, list]) => /** @type {[string, string[]]} */ ([g, list.map((c) => c.name)])),
        onchange: (name) => name && o.onset(name, Math.round((editor.shown()[name] ?? 0) * 100) / 100),
      });
      add.classList.add("add-channel");
      out.push(add);
    }
  }
  return out;
}
