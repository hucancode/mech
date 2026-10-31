// @ts-check
// The editor server's file API (server.mjs): the characters in assets/ and their files, read-only.

/** @typedef {{name: string, file: string}} CharacterFiles a character in assets/characters/ and its file name */

/** @returns {Promise<CharacterFiles[]>} */
export async function listCharacters() {
  const res = await fetch("/api/characters");
  if (!res.ok) throw new Error(`listing characters: ${res.status}`);
  return res.json();
}

/** @param {string} name */
export async function readFile(name) {
  const res = await fetch(`/api/file?name=${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`${name}: ${res.status} ${await res.text()}`);
  return res.text();
}
