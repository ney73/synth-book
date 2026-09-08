"use strict";

(() => {
  const BASE_URL = "https://novelneko.fr";
  const WEBNOVEL_URL = `${BASE_URL}/webnovels/`;
  const CATALOG_URL = `${WEBNOVEL_URL}webnovel.json`;
  const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
  const MAX_TEXT_BYTES = 4 * 1024 * 1024;
  const MAX_CHAPTERS = 10000;
  const PAGE_SIZE = 24;
  const HEADERS = {
    Accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.7",
    Referer: WEBNOVEL_URL,
  };
  const UNSAFE_MARKERS = [
    "adult", "adulte", "adult-only", "ecchi", "erotica", "erotique", "explicit",
    "harem", "hentai", "locked", "lock", "mature", "nsfw", "paid", "payant",
    "premium", "porn", "r18", "smut", "sexual", "verrouille", "verrouillage",
    "yaoi", "yuri",
  ];
  const RESTRICTED_TEXT = /(?:paid|payant|premium|locked|verrouill|login required|requires login|requires payment|unavailable|indisponible)/i;
  const cache = new Map();
  const inFlight = new Map();
  let catalogPromise = null;

  function decodeEntities(value) {
    const named = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
    return String(value || "")
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#([0-9]+);/g, (_, number) => String.fromCodePoint(parseInt(number, 10)))
      .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] || match);
  }

  function stripHTML(value) {
    return decodeEntities(String(value || "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, " "))
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function normalized(value) {
    return decodeEntities(value)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[+_]/g, " ")
      .replace(/[^a-z0-9-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function hasUnsafeMarker(values) {
    const haystack = (Array.isArray(values) ? values : [values]).map(normalized).join(" ");
    return UNSAFE_MARKERS.some((marker) => {
      const token = normalized(marker);
      return new RegExp(`(?:^|\\s)${escapeRegExp(token)}(?:$|\\s)`, "i").test(haystack);
    });
  }

  function ensureAllowedURL(value, base = WEBNOVEL_URL) {
    const input = String(value || "").trim();
    if (!input) throw new Error("NovelNeko returned an empty URL.");
    let url;
    try { url = new URL(input, base); } catch (_) { throw new Error("NovelNeko returned an invalid URL."); }
    if (url.protocol !== "https:" || url.hostname !== "novelneko.fr") {
      throw new Error("NovelNeko returned a URL outside the module allowlist.");
    }
    return url.toString();
  }

  function optionalURL(value, base = WEBNOVEL_URL) {
    if (!String(value || "").trim()) return "";
    try { return ensureAllowedURL(value, base); } catch (_) { return ""; }
  }

  function slugFromId(value) {
    const input = String(value || "").trim();
    if (!input) throw new Error("NovelNeko identifier is empty.");
    let slug = input;
    if (/^https?:\/\//i.test(input)) {
      const url = new URL(ensureAllowedURL(input));
      const match = url.pathname.match(/^\/webnovels\/([^/]+)(?:\/|$)/i);
      if (!match) throw new Error("Invalid NovelNeko web-novel URL.");
      slug = decodeURIComponent(match[1]);
    } else {
      slug = input.replace(/^\/+|\/+$/g, "").replace(/^webnovels\//i, "").split("/")[0];
    }
    if (!/^[\p{L}\p{N}][\p{L}\p{N}-]{0,199}$/u.test(slug)) throw new Error("Invalid NovelNeko web-novel identifier.");
    return slug;
  }

  function novelURL(value) {
    return `${WEBNOVEL_URL}${encodeURIComponent(slugFromId(value))}/`;
  }

  function attribute(tag, name) {
    const match = String(tag || "").match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
    return match ? decodeEntities(match[2].trim()) : "";
  }

  function responseBody(response) {
    if (response && typeof response.text === "function") return response.text();
    return Promise.resolve(response && typeof response.body === "string" ? response.body : "");
  }

  async function request(url, options = {}) {
    const target = ensureAllowedURL(url, options.base || WEBNOVEL_URL);
    if (cache.has(target)) return cache.get(target);
    if (inFlight.has(target)) return inFlight.get(target);
    const load = (async () => {
      if (typeof globalThis.fetchv2 !== "function") throw new Error("NovelNeko requires the fetchv2 bridge.");
      const response = await globalThis.fetchv2(
        target,
        { ...HEADERS, ...(options.headers || {}) },
        "GET",
        null,
        {
          followRedirects: true,
          maxBytesHint: options.maxBytesHint || MAX_RESPONSE_BYTES,
          responseClass: options.responseClass || "html",
        },
      );
      const status = Number(response && response.status);
      if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
        throw new Error(`NovelNeko request failed with HTTP ${status || "error"}.`);
      }
      if (response.bodyDropped) throw new Error("NovelNeko response exceeded the module size limit.");
      if (response.finalUrl) ensureAllowedURL(response.finalUrl, target);
      const body = await responseBody(response);
      if (!body) throw new Error("NovelNeko returned an empty response.");
      if (options.responseClass === "text" && /(?:^|;)\s*text\/html(?:;|$)/i.test(String(response.contentType || ""))) {
        throw new Error("NovelNeko returned HTML instead of chapter text.");
      }
      if (options.responseClass === "text" && /^\s*(?:<!doctype\s+html|<html\b)/i.test(body)) {
        throw new Error("NovelNeko returned HTML instead of chapter text.");
      }
      if (options.cache !== false) cache.set(target, body);
      return body;
    })();
    inFlight.set(target, load);
    try { return await load; } finally { inFlight.delete(target); }
  }

  function parseCatalog(body) {
    let entries;
    try { entries = JSON.parse(body); } catch (_) { throw new Error("NovelNeko catalog was not valid JSON."); }
    if (!Array.isArray(entries)) throw new Error("NovelNeko catalog was not an array.");
    const seen = new Set();
    return entries.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      try {
        const slug = slugFromId(entry.link);
        const id = novelURL(slug);
        const title = decodeEntities(String(entry.title || "")).trim();
        if (!title || seen.has(slug) || hasUnsafeMarker([title, entry.subtitle])) return [];
        seen.add(slug);
        return [{ id, href: id, slug, title, subtitle: decodeEntities(String(entry.subtitle || "")).trim(), image: optionalURL(entry.image, id) }];
      } catch (_) { return []; }
    });
  }

  async function getCatalog() {
    if (!catalogPromise) catalogPromise = request(CATALOG_URL, { responseClass: "json" }).then(parseCatalog);
    return catalogPromise;
  }

  function labelledValue(html, label) {
    const match = String(html || "").match(new RegExp(`<div\\b[^>]*>\\s*<strong\\b[^>]*>\\s*${label}\\s*:?\\s*<\\/strong>\\s*([\\s\\S]*?)<\\/div>`, "i"));
    return stripHTML(match ? match[1] : "");
  }

  function parseDetailsHTML(html, href, catalogEntry) {
    const source = String(html || "");
    const title = stripHTML(source.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]);
    const genres = [...(source.match(/<div\b[^>]*class=(['"])[^'"]*\bgenres\b[^'"]*\1[^>]*>([\s\S]*?)<\/div>/i)?.[2] || "").matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map((match) => stripHTML(match[1])).filter(Boolean);
    const synopsis = stripHTML(source.match(/<div\b[^>]*class=(['"])[^'"]*\bsynopsis-box\b[^'"]*\1[^>]*>([\s\S]*?)<\/div>/i)?.[2]).replace(/^Synopsis\s*:\s*/i, "").trim();
    const coverTag = source.match(/<img\b[^>]*class=(['"])[^'"]*\bcover\b[^'"]*\1[^>]*>/i)?.[0] || "";
    const status = labelledValue(source, "Statut");
    const translator = labelledValue(source, "Traducteur");
    const type = labelledValue(source, "Type");
    const author = labelledValue(source, "Auteur");
    const publicationDate = labelledValue(source, "Date de parution");
    const countText = stripHTML(source.match(/<div\b[^>]*class=(['"])[^'"]*\bchapter-count\b[^'"]*\1[^>]*>([\s\S]*?)<\/div>/i)?.[2]);
    const chapterCount = Number((countText.match(/[0-9][0-9\s.,]*/) || [""])[0].replace(/[\s.,]/g, ""));
    if (!title || !genres.length || !author || !status || !type || !synopsis || !Number.isInteger(chapterCount) || chapterCount < 1 || chapterCount > MAX_CHAPTERS) throw new Error("NovelNeko safety metadata is missing; title rejected.");
    if (normalized(type) !== "web novel") throw new Error("NovelNeko entry type is not Web Novel.");
    if (hasUnsafeMarker([title, ...genres, synopsis, author, status, translator, type, publicationDate])) throw new Error("NovelNeko title is unavailable under the strict safety filter.");
    const id = novelURL(href);
    return { id, href: id, slug: slugFromId(href), title, image: ensureAllowedURL(attribute(coverTag, "src"), href), description: synopsis, synopsis, author, translator, status, type, publicationDate, genres: [...new Set(genres)], chapterCount, language: "fr", subtitle: catalogEntry?.subtitle || "" };
  }

  const detailLoads = new Map();
  async function detailsForEntry(entry) {
    if (!detailLoads.has(entry.slug)) detailLoads.set(entry.slug, request(entry.href).then((html) => parseDetailsHTML(html, entry.href, entry)));
    return detailLoads.get(entry.slug);
  }

  function searchMatch(entry, query) {
    const needle = normalized(query);
    return !needle || normalized(`${entry.title} ${entry.subtitle}`).includes(needle);
  }

  async function mapConcurrent(values, limit, worker) {
    const result = new Array(values.length);
    let next = 0;
    async function run() { while (next < values.length) { const index = next++; result[index] = await worker(values[index], index); } }
    await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
    return result;
  }

  async function safeEntries(query) {
    const candidates = (await getCatalog()).filter((entry) => searchMatch(entry, query));
    return (await mapConcurrent(candidates, 3, async (entry) => { try { return await detailsForEntry(entry); } catch (_) { return null; } })).filter(Boolean);
  }

  async function searchResults(query, page = 1) {
    const items = await safeEntries(String(query || "").replace(/^__feed:[^ ]*\s*/i, ""));
    const currentPage = Math.max(1, Math.floor(Number(page) || 1));
    const start = (currentPage - 1) * PAGE_SIZE;
    return { items: items.slice(start, start + PAGE_SIZE), hasMore: start + PAGE_SIZE < items.length };
  }

  async function extractDetails(id) {
    const slug = slugFromId(id);
    const entry = (await getCatalog()).find((item) => item.slug === slug) || { id: novelURL(slug), href: novelURL(slug), slug, title: "", subtitle: "" };
    return detailsForEntry(entry);
  }

  function chapterURL(slug, number) { return `${novelURL(slug)}lecture.html?chapitre=${number}`; }

  async function extractChapters(id) {
    const details = await extractDetails(id);
    return Array.from({ length: details.chapterCount }, (_, index) => { const number = index + 1; const href = chapterURL(details.slug, number); return { id: href, href, title: `Chapitre ${String(number).padStart(3, "0")}`, number, language: "fr" }; });
  }

  function parseChapterReference(id) {
    let url;
    try { url = new URL(ensureAllowedURL(id)); } catch (_) { throw new Error("Invalid NovelNeko chapter URL."); }
    const match = url.pathname.match(/^\/webnovels\/([^/]+)\/lecture\.html$/i);
    const number = Number(url.searchParams.get("chapitre"));
    if (!match || !Number.isInteger(number) || number < 1 || number > MAX_CHAPTERS) throw new Error("Invalid NovelNeko chapter number.");
    return { url: url.toString(), slug: decodeURIComponent(match[1]), number };
  }

  function chapterCandidates(readerHTML, reference) {
    const block = String(readerHTML || "").match(/possibleFiles\s*=\s*\[([\s\S]*?)\]/i)?.[1] || "";
    const templates = [...block.matchAll(/[`'\"]([^`'\"]+)[`'\"]/g)].map((match) => match[1]);
    const fallback = ["chapters/chapitre_${chapitreStr}_fr.txt", "chapters/chapitre_${chapitreStr}.txt", "chapters/chapitre-${chapitreStr}.txt", "chapters/${chapitreStr}.txt"];
    const padded = String(reference.number).padStart(3, "0");
    const paths = (templates.length ? templates : fallback).map((template) => template.replaceAll("${chapitreStr}", padded).replaceAll("${chapitre}", String(reference.number)));
    const seen = new Set();
    return paths.flatMap((path) => { try { const url = ensureAllowedURL(path, reference.url); if (!new URL(url).pathname.startsWith(`/webnovels/${encodeURIComponent(reference.slug)}/`)) return []; if (!url.toLowerCase().endsWith(".txt") || seen.has(url)) return []; seen.add(url); return [url]; } catch (_) { return []; } });
  }

  function chapterTitle(readerHTML, number) {
    const title = stripHTML(String(readerHTML || "").match(/<h1\b[^>]*id=(['"])titreChapitre\1[^>]*>([\s\S]*?)<\/h1>/i)?.[2]);
    return title || `Chapitre ${String(number).padStart(3, "0")}`;
  }

  function normalizeChapterText(text) {
    const content = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
    if (!content || /^\s*(?:<!doctype\s+html|<html\b|<title>404)/i.test(content)) throw new Error("NovelNeko chapter file was not valid text.");
    if (RESTRICTED_TEXT.test(content)) throw new Error("NovelNeko chapter text is unavailable because it is paid or locked.");
    if (typeof TextEncoder !== "undefined" && new TextEncoder().encode(content).byteLength > MAX_TEXT_BYTES) throw new Error("NovelNeko chapter text exceeded the module size limit.");
    return content;
  }

  async function extractText(id) {
    const reference = parseChapterReference(id);
    const details = await extractDetails(reference.slug);
    if (reference.number > details.chapterCount) throw new Error("NovelNeko chapter number is outside the public chapter range.");
    const readerHTML = await request(reference.url);
    let lastError = null;
    for (const candidate of chapterCandidates(readerHTML, reference)) { try { const content = normalizeChapterText(await request(candidate, { responseClass: "text", maxBytesHint: MAX_TEXT_BYTES, cache: false })); return { id: reference.url, title: chapterTitle(readerHTML, reference.number), content }; } catch (error) { lastError = error; } }
    throw lastError || new Error("NovelNeko chapter text was unavailable.");
  }

  async function discoveryHome() { const result = await searchResults("", 1); return { sections: [{ id: "webnovels", title: "Web-Novels", items: result.items }] }; }
  async function discoveryFeed(feedID, page = 1) { if (String(feedID || "").toLowerCase() !== "webnovels") return { items: [], hasMore: false }; return searchResults("", page); }

  const moduleAPI = { searchResults, extractDetails, extractChapters, extractText, discoveryHome, discoveryFeed };
  globalThis.SynthetiqModule = moduleAPI;
  Object.assign(globalThis, moduleAPI);
})();
