/**
 * Novel Neko - Synthetiq Books Source Module
 * ID: novelneko-v1
 * Language: fr
 * Content-Type: text
 */

const BASE_URL = "https://novelneko.fr";

function sanitizeUrl(urlStr) {
  if (!urlStr) return "";
  if (urlStr.startsWith("//")) return "https:" + urlStr;
  if (urlStr.startsWith("/")) return BASE_URL + urlStr;
  return urlStr;
}

function cleanHtmlText(htmlStr) {
  if (!htmlStr) return "";
  return htmlStr
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\n\s*\n/g, "\n\n")
    .trim();
}

async function fetchPage(pathOrUrl) {
  const targetUrl = sanitizeUrl(pathOrUrl);
  const response = await globalThis.fetchv2(targetUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SynthetiqBooks/1.0",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8"
    }
  });

  if (!response || response.status !== 200) {
    throw new Error(`Failed to load URL: ${targetUrl} (Status: ${response ? response.status : 'No response'})`);
  }

  return await response.text();
}

function extractNovelsFromHtml(htmlText) {
  const items = [];
  const articleRegex = /<article[^>]*>([\s\S]*?)<\/article>/gi;
  let match;

  while ((match = articleRegex.exec(htmlText)) !== null) {
    const articleContent = match[1];
    
    const linkMatch = /href=["'](https?:\/\/novelneko\.fr\/projet\/[^"']+)["']/i.exec(articleContent) ||
                      /href=["'](\/projet\/[^"']+)["']/i.exec(articleContent);
    const titleMatch = /<h[234][^>]*>(?:<a[^>]*>)?([^<]+)(?:<\/a>)?<\/h[234]>/i.exec(articleContent);
    const imgMatch = /src=["']([^"']+\.(?:jpg|jpeg|png|webp))["']/i.exec(articleContent);

    if (linkMatch && titleMatch) {
      const href = sanitizeUrl(linkMatch[1]);
      const id = href.replace(/^https?:\/\/novelneko\.fr/i, "");
      
      items.push({
        id: id,
        title: titleMatch[1].trim(),
        href: href,
        cover: imgMatch ? sanitizeUrl(imgMatch[1]) : ""
      });
    }
  }

  return items;
}

async function discoveryHome() {
  const html = await fetchPage("/projets/");
  const items = extractNovelsFromHtml(html);

  return [
    {
      id: "all-novels",
      title: "Tous les Projets",
      items: items.slice(0, 20)
    }
  ];
}

async function discoveryFeed(feedID, page = 1) {
  const pagePath = page > 1 ? `/projets/page/${page}/` : `/projets/`;
  const html = await fetchPage(pagePath);
  const items = extractNovelsFromHtml(html);

  return {
    items: items,
    hasMore: items.length >= 10
  };
}

async function searchResults(query, page = 1) {
  const searchPath = `/?s=${encodeURIComponent(query)}&paged=${page}`;
  const html = await fetchPage(searchPath);
  const items = extractNovelsFromHtml(html);

  return {
    items: items,
    hasMore: items.length >= 10
  };
}

async function extractDetails(itemID) {
  const html = await fetchPage(itemID);

  const titleMatch = /<h1[^>]*class=["'][^"']*entry-title[^"']*["'][^>]*>([^<]+)<\/h1>/i.exec(html) ||
                     /<h1[^>]*>([^<]+)<\/h1>/i.exec(html);
  
  const coverMatch = /<div[^>]*class=["'][^"']*project-cover[^"']*["'][^>]*>[\s\S]*?src=["']([^"']+)["']/i.exec(html) ||
                     /<img[^>]*src=["']([^"']+\.(?:jpg|jpeg|png|webp))["'][^>]*class=["'][^"']*wp-post-image[^"']*["']/i.exec(html);

  const descMatch = /<div[^>]*class=["'][^"']*(?:entry-content|synopsis)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(html);
  
  const authorMatch = /Auteur\s*:\s*<\/strong>\s*([^<]+)/i.exec(html) ||
                      /Auteur\s*:\s*([^<,\n]+)/i.exec(html);

  const statusMatch = /Statut\s*:\s*<\/strong>\s*([^<]+)/i.exec(html) ||
                      /Statut\s*:\s*([^<,\n]+)/i.exec(html);

  return {
    id: itemID,
    title: titleMatch ? titleMatch[1].trim() : "Titre inconnu",
    cover: coverMatch ? sanitizeUrl(coverMatch[1]) : "",
    description: descMatch ? cleanHtmlText(descMatch[1]) : "",
    author: authorMatch ? authorMatch[1].trim() : "Inconnu",
    status: statusMatch ? statusMatch[1].trim() : "En cours",
    tags: ["Light Novel", "Traduction Fr"]
  };
}

async function extractChapters(itemID) {
  const html = await fetchPage(itemID);
  const chapters = [];

  const chapterRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  let index = 1;

  while ((match = chapterRegex.exec(html)) !== null) {
    const href = sanitizeUrl(match[1]);
    const text = cleanHtmlText(match[2]);

    if (href.includes(itemID) || href.match(/chapitre|chapter|volume/i)) {
      if (text && text.length > 0 && !href.endsWith("/projets/")) {
        const sectionId = href.replace(/^https?:\/\/novelneko\.fr/i, "");
        
        if (!chapters.some(ch => ch.id === sectionId)) {
          chapters.push({
            id: sectionId,
            title: text,
            url: href,
            number: index++
          });
        }
      }
    }
  }

  return chapters;
}

async function extractText(sectionID) {
  const html = await fetchPage(sectionID);

  const titleMatch = /<h1[^>]*class=["'][^"']*entry-title[^"']*["'][^>]*>([^<]+)<\/h1>/i.exec(html) ||
                     /<h1[^>]*>([^<]+)<\/h1>/i.exec(html);

  const contentMatch = /<div[^>]*class=["'][^"']*entry-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(html);

  const sanitizedContent = contentMatch ? cleanHtmlText(contentMatch[1]) : "Contenu indisponible.";

  return {
    id: sectionID,
    title: titleMatch ? titleMatch[1].trim() : "Chapitre",
    content: sanitizedContent
  };
}

globalThis.SynthetiqModule = {
  discoveryHome,
  discoveryFeed,
  searchResults,
  extractDetails,
  extractChapters,
  extractText
};
