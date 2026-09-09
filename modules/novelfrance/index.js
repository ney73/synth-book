/**
 * Module NovelFrance pour Synthetiq Books
 */

function validateUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    return parsed.protocol === "https:" && parsed.hostname === "novelfrance.fr";
  } catch {
    return false;
  }
}

function isContentSafe(item) {
  if (!item) return false;
  if (item.isAdult || item.isNSFW || item.is18Plus) return false;
  if (item.isPaid || item.isLocked || item.requiresCoins) return false;
  return true;
}

export async function searchResults(query, page = 1) {
  const url = `https://novelfrance.fr/webnovels/search?q=${encodeURIComponent(query)}&page=${page}`;
  const response = await fetchv2(url, { "User-Agent": "SynthetiqBooks/1.0" }, "GET", null, {});
  const data = JSON.parse(response.body);

  const filtered = (data.results || []).filter(item => {
    return isContentSafe(item) && validateUrl(item.url);
  });

  return {
    results: filtered.map(item => ({
      id: item.id,
      title: item.title,
      url: item.url,
      cover: item.cover
    })),
    hasMore: data.hasMore || false
  };
}

export async function extractDetails(novelUrl) {
  if (!validateUrl(novelUrl)) throw new Error("URL invalide ou non autorisée.");

  const response = await fetchv2(novelUrl, { "User-Agent": "SynthetiqBooks/1.0" }, "GET", null, {});
  const data = JSON.parse(response.body);

  if (!isContentSafe(data)) {
    throw new Error("Contenu restreint ou inaccessible.");
  }

  return {
    id: data.id,
    title: data.title,
    summary: data.description,
    author: data.author,
    cover: data.cover,
    genres: data.genres || []
  };
}

export async function extractChapters(novelUrl) {
  if (!validateUrl(novelUrl)) throw new Error("URL invalide.");

  const chaptersUrl = `${novelUrl.replace(/\/$/, "")}/chapters`;
  const response = await fetchv2(chaptersUrl, { "User-Agent": "SynthetiqBooks/1.0" }, "GET", null, {});
  const data = JSON.parse(response.body);

  const safeChapters = (data.chapters || []).filter(ch => !ch.isLocked && !ch.isPaid);

  return safeChapters.map(ch => ({
    id: ch.id,
    title: ch.title,
    url: ch.url,
    number: ch.number
  }));
}

export async function extractText(chapterUrl) {
  if (!validateUrl(chapterUrl)) throw new Error("URL invalide.");

  const response = await fetchv2(chapterUrl, { "User-Agent": "SynthetiqBooks/1.0" }, "GET", null, {});
  const data = JSON.parse(response.body);

  if (data.isLocked || data.isPaid) {
    throw new Error("Ce chapitre est réservé aux membres payants.");
  }

  return {
    title: data.title,
    content: data.content
  };
}

export async function discoveryHome() {
  const url = "https://novelfrance.fr/webnovels/discovery";
  const response = await fetchv2(url, { "User-Agent": "SynthetiqBooks/1.0" }, "GET", null, {});
  const data = JSON.parse(response.body);

  return {
    sections: (data.sections || []).map(section => ({
      title: section.title,
      items: (section.items || []).filter(isContentSafe)
    }))
  };
}

export async function discoveryFeed(sectionId, page = 1) {
  const url = `https://novelfrance.fr/webnovels/discovery/${sectionId}?page=${page}`;
  const response = await fetchv2(url, { "User-Agent": "SynthetiqBooks/1.0" }, "GET", null, {});
  const data = JSON.parse(response.body);

  return {
    items: (data.items || []).filter(isContentSafe),
    hasMore: data.hasMore || false
  };
}
