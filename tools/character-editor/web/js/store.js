// @ts-check
// Where characters live for the editor. Saving keeps a character in the browser (localStorage);
// the repo's assets/ are read-only starting points; files come in by import and go out by export.
// A character is one file (assets/characters/<name>.json): its model and animation, written by the engine's own writer.

const PREFIX = "character-editor.character.";

/** @typedef {string} CharacterText a character file's text */

/** The names of the characters saved in this browser. */
export function localNames() {
  const names = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(PREFIX)) names.push(key.slice(PREFIX.length));
  }
  return names.sort();
}

/** @param {string} name @returns {CharacterText | null} */
export function loadLocal(name) {
  try {
    const text = localStorage.getItem(PREFIX + name);
    return text;
  } catch {
    return null;
  }
}

/** @param {string} name @param {CharacterText} text */
export function saveLocal(name, text) {
  localStorage.setItem(PREFIX + name, text);
}

/** @param {string} name */
export function removeLocal(name) {
  localStorage.removeItem(PREFIX + name);
}

/** exportFile downloads a character as <name>.json. @param {string} name @param {CharacterText} text */
export function exportFile(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `${name}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * pickFile lets the user choose a character file (<name>.json) and reads it.
 * @returns {Promise<{model: any, anim: any, name: string} | null>}
 */
export function pickFile() {
  return new Promise((resolve, reject) => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: ".json,application/json" });
    input.addEventListener("change", async () => {
      try {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        const data = JSON.parse(await file.text());
        if (!data.model || typeof data.model !== "object") throw new Error(`${file.name} is not a character file (no "model").`);
        const name = file.name.replace(/(\.character)?\.json$/i, "") || data.model.name || "character";
        resolve({ model: data.model, anim: data.animation ?? {}, name });
      } catch (e) {
        reject(e);
      }
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/** A new character: one part, one material, no clips. @param {string} name */
export function blankCharacter(name) {
  return {
    model: {
      name,
      scale: 0.3,
      ground: true,
      materials: [{ name: "paint", color: [0.7, 0.72, 0.76], metallic: 0.2, roughness: 0.5 }],
      hardware: { female: "paint", male: "paint", metal: "paint" },
      parts: [{ name: "body", shapes: [{ material: "paint", size: [1, 1, 1] }] }],
    },
    anim: {},
  };
}
