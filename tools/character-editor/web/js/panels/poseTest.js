// @ts-check
// The pose test: a slider for every channel, to try the joints while building, from the rest pose
// (the model's `pose`: what every clip starts from and adds onto). It poses the viewer only, until
// "Set rest pose" saves what it shows as the rest pose.
import { btn, h } from "../dom.js";
import { dockSpanButtons } from "../layout.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { flatValues, packValues } from "../model.js";
import { driverValues } from "./driverValues.js";

/** the pose test's values: the rest pose, with what was tried on top @returns {Record<string, number>} */
const tried = () => ({ ...flatValues(editor.model.pose), ...editor.test });

/** setRestPose saves the pose test as the model's rest pose (its non-zero channels) */
function setRestPose() {
  const values = Object.fromEntries(Object.entries(tried()).filter(([, v]) => Math.abs(v) > 1e-6).map(([n, v]) => [n, Math.round(v * 1e4) / 1e4]));
  editor.edit("model", () => {
    if (Object.keys(values).length) editor.model.pose = packValues(values);
    else delete editor.model.pose;
    editor.test = {};
  });
  editor.flash("Saved as the rest pose: every clip starts from it");
}

export function poseTest() {
  const bar = h("div", { class: "dock-bar" });
  const items = () => [
    h("span", { class: "dock-title" }, "Pose test"),
    h("span", { class: "grow" }),
    dockSpanButtons(() => bar.replaceChildren(...items().flat())),
    btn("Set rest pose", setRestPose, { title: "Save what the pose test shows as the rest pose: the stance every clip starts from and adds onto (arms hanging, legs reaching)", disabled: !Object.keys(editor.test).length }),
    btn(icon("reset"), () => editor.select(() => (editor.test = {})), { kind: "icon", title: "Back to the rest pose" }),
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
        driverValues(tried(), {
          full: true,
          onset: (vs) => {
            Object.assign(editor.test, vs);
            editor.show();
          },
        }),
      ),
    ),
  ];
}
