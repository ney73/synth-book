import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.join(root, "index.js"), "utf8");

const safeDetails = `<!doctype html><html><body>
  <div class="cover-wrapper"><img class="cover" src="cover.jpg"></div>
  <div><strong>Statut :</strong> Terminé</div>
  <div><strong>Traducteur :</strong> Example Translator</div>
  <div><strong>Type :</strong> Web Novel</div>
  <div><strong>Auteur :</strong> Example Author</div>
  <div><strong>Date de parution :</strong> 2025</div>
  <h1>Fixture Chronicle</h1>
  <div class="chapter-count">2 chapitres</div>
  <div class="genres"><span>Action</span><span>Fantasy</span></div>
  <div class="synopsis-box"><strong>Synopsis :</strong><br><br>Une histoire publique et sûre.</div>
</body></html>`;

const unsafeDetails = safeDetails.replace("Fixture Chronicle", "Fixture Harem Chronicle").replace("Action", "Harem");
const reader = `<h1 id="titreChapitre">Fixture Chronicle - Chapitre 001</h1>
<script>const possibleFiles = [
  \`chapters/chapitre_\${chapitreStr}_fr.txt\`,
  \`chapters/chapitre_\${chapitreStr}.txt\`
];</script>`;
const catalog = JSON.stringify([
  { title: "Fixture Chronicle", image: "fixture-safe/cover.jpg", link: "fixture-safe/", subtitle: "2 chapitres" },
  { title: "Fixture Harem Chronicle", image: "fixture-unsafe/cover.jpg", link: "fixture-unsafe/", subtitle: "2 chapitres" },
]);

function response(url, body, status = 200, contentType = "text/html") {
  return {
    status,
    ok: status >= 200 && status < 300,
    body,
    contentType,
    finalUrl: url,
    bodyDropped: false,
    text: async () => body,
  };
}

function load(fetchv2) {
  const context = vm.createContext({ URL, TextEncoder, TextDecoder, fetchv2 });
  context.globalThis = context;
  new vm.Script(source, { filename: path.join(root, "index.js") }).runInContext(context);
  return context.SynthetiqModule;
}

test("NovelNeko supports search, details, ordered chapters, and text fallback", async () => {
  const calls = [];
  const module = load(async (url, headers, method, body, options) => {
    calls.push({ url, headers, method, body, options });
    if (url.endsWith("/webnovel.json")) return response(url, catalog, 200, "application/json");
    if (url.includes("fixture-safe/lecture.html")) return response(url, reader);
    if (url.includes("chapitre_001_fr.txt")) return response(url, "<html>404</html>", 404, "text/html");
    if (url.includes("chapitre_001.txt")) return response(url, "Le contenu du chapitre est disponible et non vide.", 200, "text/plain");
    if (url.includes("fixture-safe/")) return response(url, safeDetails);
    throw new Error(`Unexpected URL: ${url}`);
  });

  const search = await module.searchResults("Fixture", 1);
  assert.equal(search.items.length, 1);
  assert.equal(search.items[0].title, "Fixture Chronicle");
  assert.equal(search.items[0].language, "fr");
  assert.match(search.items[0].image, /novelneko\.fr\/webnovels\/fixture-safe\/cover\.jpg$/);

  const details = await module.extractDetails(search.items[0].id);
  assert.equal(details.author, "Example Author");
  assert.deepEqual(Array.from(details.genres), ["Action", "Fantasy"]);
  assert.equal(details.chapterCount, 2);

  const chapters = await module.extractChapters(details.id);
  assert.deepEqual(Array.from(chapters, (chapter) => chapter.number), [1, 2]);
  assert.match(chapters[0].id, /lecture\.html\?chapitre=1$/);

  const text = await module.extractText(chapters[0].id);
  assert.equal(text.title, "Fixture Chronicle - Chapitre 001");
  assert.match(text.content, /contenu du chapitre/i);
  assert.equal(calls[0].method, "GET");
  assert.ok(calls.some((call) => call.url.endsWith("chapitre_001_fr.txt")));
  assert.ok(calls.some((call) => call.url.endsWith("chapitre_001.txt")));
  assert.ok(calls.every((call) => call.url.startsWith("https://novelneko.fr/")));
});

test("NovelNeko fails closed for unsafe content and off-host identifiers", async () => {
  const module = load(async (url) => {
    if (url.endsWith("/webnovel.json")) return response(url, catalog, 200, "application/json");
    if (url.includes("fixture-unsafe/")) return response(url, unsafeDetails);
    throw new Error(`Unexpected URL: ${url}`);
  });

  await assert.rejects(() => module.extractDetails("https://novelneko.fr/webnovels/fixture-unsafe/"), /strict safety filter/i);
  await assert.rejects(() => module.extractDetails("https://evil.example/webnovels/fixture-safe/"), /outside the module allowlist|Invalid NovelNeko/i);
  await assert.rejects(() => module.extractText("https://novelneko.fr/webnovels/fixture-safe/lecture.html?chapitre=0"), /Invalid NovelNeko chapter number/i);
});
