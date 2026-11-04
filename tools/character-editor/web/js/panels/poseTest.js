// @ts-check
// The pose test: a slider for every channel, to try the joints while building, from the rest pose
// (the model's `pose`: what every clip starts from and adds onto). It poses the viewer only, until
// "Set rest pose" saves what it shows as the rest pose.
import { btn, h } from "../dom.js";
import { dockSpanButtons } from "../layout.js";
import { icon } from "../icons.js";
import { editor } from "../editor.js";
import { moveValues, oneSide, zipValue } from "../model.js";
import { channelValues } from "./channelValues.js";

/** the twins of every channel (the engine's "twins" query) @returns {import("../model.js").Twins} */
const twins = () => editor.ask({ q: "twins" }) ?? {};

/** the pose test's values: the rest pose (both sides: it is symmetric), with what was tried on top @returns {Record<string, import("../model.js").Value>} */
const tried = () => ({ ...moveValues({ twin: "WITH", by: editor.model.pose }, twins()), ...editor.test });

/** setRestPose saves the pose test as the model's rest pose (its non-zero channels), one side of each pair: the rest pose is symmetric */
function setRestPose() {
  const values = Object.fromEntries(
    Object.entries(tried())
      .filter(([, v]) => [v].flat().some((x) => Math.abs(x) > 1e-6))
      .map(([n, v]) => [n, zipValue(v, 0, (x) => Math.round(x * 1e4) / 1e4)]),
  );
  const { by, asymmetric } = oneSide(values, twins());
  editor.edit("model", () => {
    if (Object.keys(by).length) editor.model.pose = by;
    else delete editor.model.pose;
    editor.test = {};
  });
  editor.flash(asymmetric ? "Saved as the rest pose, the left side for both: a stance is symmetric (asymmetry is a clip's)" : "Saved as the rest pose: every clip starts from it");
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
        channelValues(tried(), {
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
