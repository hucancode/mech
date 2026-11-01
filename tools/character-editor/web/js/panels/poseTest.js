// @ts-check
// The pose test: a slider for every driver, to try the joints while building.
// It poses the viewer only; nothing is saved.
import { btn, h } from "../dom.js";
import { dockSpanButtons } from "../layout.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { driverValues } from "./driverValues.js";

export function poseTest() {
  const bar = h("div", { class: "dock-bar" });
  const items = () => [
    h("span", { class: "dock-title" }, "Pose test"),
    h("span", { class: "grow" }),
    dockSpanButtons(() => bar.replaceChildren(...items().flat())),
    btn(icon("reset"), () => editor.select(() => (editor.test = {})), { kind: "icon", title: "Back to the rest pose (the pose test is never saved)" }),
  ];
  bar.replaceChildren(...items().flat());
  return [
    bar,
    h(
      "div",
      { class: "dock-scroll" },
      h(
        "div",
        { class: "columns" },
        driverValues(editor.test, {
          full: true,
          onset: (n, v) => {
            editor.test[n] = v;
            editor.show();
          },
        }),
      ),
    ),
  ];
}
