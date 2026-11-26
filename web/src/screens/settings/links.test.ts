// Every link into Settings names a section Settings really has, so it lands there.
const files = import.meta.glob<string>(["../../**/*.tsx", "../../**/*.ts", "!../../**/*.test.tsx", "!../../**/*.test.ts"], { query: "?raw", import: "default", eager: true });

const settings = files["../Settings.tsx"] ?? "";
const sections = new Set([...settings.matchAll(/\{ id: "([a-z-]+)", label:/g)].map((m) => m[1]));

test("Settings lists its sections", () => {
  expect([...sections]).toEqual(["makers", "providers", "voice", "library", "phone", "reminders", "appearance", "advanced"]);
});

test("every /settings#… link in the app names one of them", () => {
  const links: { file: string; hash: string }[] = [];
  for (const [file, text] of Object.entries(files)) {
    for (const m of text.matchAll(/\/settings(?:\?[^#"'`\s]*)?#([a-z-]+)/g)) links.push({ file, hash: m[1]! });
    // Links from inside Settings give only the hash.
    if (!file.startsWith("../../")) {
      for (const m of text.matchAll(/hash: "#([a-z-]+)"/g)) links.push({ file, hash: m[1]! });
    }
  }
  expect(links.length).toBeGreaterThan(5);
  expect(links.filter((l) => !sections.has(l.hash))).toEqual([]);
});
