const DEFAULT_SETTINGS = {
  includeFrontmatter: true,
  includeMetrics: true,
  includeMedia: true,
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...existing });
  await chrome.storage.local.set({ lastSave: null });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SAVE_TWEET") {
    handleSaveTweet(message.payload, sender)
      .then((result) => sendResponse(result))
      .catch((err) =>
        sendResponse({ success: false, error: err.message || "unknown error" })
      );
    return true;
  }

  if (message?.type === "BUILD_MARKDOWN") {
    const markdown = buildMarkdown(
      message.payload,
      message.settings,
      message.mediaUrlMap || {}
    );
    sendResponse({ markdown });
    return false;
  }
});

async function handleSaveTweet(payload, sender) {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const slug = buildFilename(payload);
  const filename = slug + ".md";

  // Build media download plan
  const mediaDownloads = [];
  if (settings.includeMedia && payload.mediaUrls?.length > 0) {
    const seen = new Set();
    let imgIndex = 0;
    let vidIndex = 0;
    for (const media of payload.mediaUrls) {
      if (seen.has(media.url)) continue;
      seen.add(media.url);

      if (media.type === "video") {
        vidIndex++;
        const ext = guessVideoExt(media.url);
        const localName = `${vidIndex}${ext}`;
        mediaDownloads.push({
          remoteUrl: media.url,
          type: media.type,
          localPath: `assets/videos/${slug}/${localName}`,
          dir: `assets/videos/${slug}`,
          localName,
        });
      } else {
        imgIndex++;
        const ext = guessImageExt(media.url);
        const localName = `${imgIndex}${ext}`;
        mediaDownloads.push({
          remoteUrl: media.url,
          type: media.type,
          localPath: `assets/img/${slug}/${localName}`,
          dir: `assets/img/${slug}`,
          localName,
        });
      }
    }
  }

  const tabId = sender?.tab?.id;
  if (!tabId) {
    return { success: false, error: "无法获取当前标签页" };
  }

  // Send payload + settings + media plan to content script
  // Content script will: download media → build markdown → write files
  let result;
  try {
    result = await chrome.tabs.sendMessage(tabId, {
      type: "SAVE_TO_FOLDER",
      payload,
      settings,
      filename,
      mediaDownloads,
    });
  } catch (err) {
    return { success: false, error: "写入失败: " + err.message };
  }

  if (!result) {
    return { success: false, error: "empty response" };
  }

  if (result.success) {
    const lastSave = {
      url: payload.url,
      title: filename,
      timestamp: Date.now(),
    };
    await chrome.storage.local.set({ lastSave });
  }

  return result;
}

function guessImageExt(url) {
  try {
    const pathname = new URL(url).pathname;
    if (pathname.includes(".png")) return ".png";
    if (pathname.includes(".gif")) return ".gif";
    if (pathname.includes(".webp")) return ".webp";
  } catch (_e) { /* ignore */ }
  return ".jpg";
}

function guessVideoExt(url) {
  try {
    const pathname = new URL(url).pathname;
    if (pathname.includes(".webm")) return ".webm";
  } catch (_e) { /* ignore */ }
  return ".mp4";
}

// ── Markdown building (exported for content script via message) ──

function buildMarkdown(payload, settings, mediaUrlMap) {
  const sections = [];

  if (settings.includeFrontmatter) {
    sections.push(buildFrontmatter(payload));
  }

  if (payload.isArticle) {
    // Long-form article: use article title as heading, render blocks inline
    sections.push(buildArticleHeading(payload));
    sections.push(buildInfoBlock(payload, settings));
    sections.push(buildArticleBody(payload.contentBlocks, mediaUrlMap));
  } else {
    sections.push(buildHeading(payload));
    sections.push(buildInfoBlock(payload, settings));
    sections.push(buildBody(payload));

    if (settings.includeMedia && payload.mediaUrls?.length > 0) {
      sections.push(buildMediaSection(payload.mediaUrls, mediaUrlMap));
    }
  }

  if (payload.quotedTweet) {
    sections.push(buildQuoteSection(payload.quotedTweet));
  }

  return sections.filter(Boolean).join("\n\n") + "\n";
}

function buildFrontmatter(payload) {
  const published = formatDate(payload.publishedAt);
  const now = formatDate(new Date().toISOString());
  const author = formatAuthorTag(payload.authorName, payload.authorHandle);

  const lines = [
    "---",
    "tags: []",
    `url: ${payload.url}`,
    `author: ${author}`,
    `published: ${published}`,
    `source: X (Twitter)`,
    payload.isArticle ? "type: article" : "type: tweet",
    `saved_at: ${now}`,
    "---",
  ];

  return lines.join("\n");
}

function buildHeading(payload) {
  const title = sanitizeTitle(payload.text || payload.tweetId || "x-post");
  return `# ${title}`;
}

function buildArticleHeading(payload) {
  const title = payload.articleTitle || sanitizeTitle(
    payload.contentBlocks?.find((b) => b.type === "text")?.content || payload.tweetId || "x-article"
  );
  return `# ${title}`;
}

function buildArticleBody(contentBlocks, mediaUrlMap) {
  if (!contentBlocks || contentBlocks.length === 0) {
    return "## Content\n\n*(empty article)*";
  }

  const lines = ["## Content", ""];

  for (const block of contentBlocks) {
    if (block.type === "text") {
      lines.push(block.content);
      lines.push(""); // blank line between blocks
    } else if (block.type === "image") {
      const displayUrl = mediaUrlMap?.[block.url] || block.url;
      lines.push(`![image](${displayUrl})`);
      lines.push("");
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildInfoBlock(payload, settings) {
  const authorDisplay = payload.authorName
    ? `${payload.authorName} (@${payload.authorHandle})`
    : `@${payload.authorHandle}`;

  const lines = [
    "> [!info] Post Info",
    `> **Author**: ${authorDisplay}`,
    `> **Link**: ${payload.url}`,
    `> **Published**: ${formatDateTime(payload.publishedAt)}`,
  ];

  if (settings.includeMetrics) {
    const m = payload.metrics || {};
    const parts = [];
    if (m.likes && m.likes !== "0") parts.push(`Likes: ${m.likes}`);
    if (m.reposts && m.reposts !== "0") parts.push(`Reposts: ${m.reposts}`);
    if (m.replies && m.replies !== "0") parts.push(`Replies: ${m.replies}`);
    if (m.views && m.views !== "0") parts.push(`Views: ${m.views}`);
    if (m.bookmarks && m.bookmarks !== "0")
      parts.push(`Bookmarks: ${m.bookmarks}`);
    if (parts.length > 0) {
      lines.push(`> **Metrics**: ${parts.join(" | ")}`);
    }
  }

  return lines.join("\n");
}

function buildBody(payload) {
  const text = (payload.text || "").trim();
  if (!text) {
    return "## Content\n\n*(empty post)*";
  }
  return `## Content\n\n${text}`;
}

// mediaUrlMap: { remoteUrl -> localPath } for successfully downloaded media
function buildMediaSection(mediaUrls, mediaUrlMap) {
  const lines = ["## Media", ""];
  const seen = new Set();

  for (const media of mediaUrls) {
    if (seen.has(media.url)) {
      continue;
    }
    seen.add(media.url);

    const displayUrl = mediaUrlMap?.[media.url] || media.url;

    if (media.type === "image") {
      lines.push(`![image](${displayUrl})`);
    } else if (media.type === "video") {
      lines.push(`[Video](${displayUrl})`);
    } else if (media.type === "video_thumbnail") {
      lines.push(`![video thumbnail](${displayUrl})`);
    }
  }

  return lines.join("\n");
}

function buildQuoteSection(qt) {
  const lines = ["## Quoted Post", ""];
  if (qt.author) {
    lines.push(`> **${qt.author}**`);
  }
  if (qt.text) {
    const indented = qt.text
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    lines.push(indented);
  }
  if (qt.url) {
    lines.push(`> [Original](${qt.url})`);
  }
  return lines.join("\n");
}

function buildFilename(payload) {
  const titleSource = payload.isArticle
    ? (payload.articleTitle || payload.contentBlocks?.find((b) => b.type === "text")?.content || payload.tweetId || "x-article")
    : (payload.text || payload.tweetId || "x-post");
  const title = sanitizeTitle(titleSource);
  const dateStr = formatDate(payload.publishedAt || new Date().toISOString());
  const handle = payload.authorHandle || "unknown";
  return sanitizeFilename(`${dateStr}-${handle}-${title}`);
}

function sanitizeTitle(text) {
  const firstLine = text.split("\n")[0];
  const cleaned = firstLine.slice(0, 60).trim();
  return cleaned || "untitled";
}

function sanitizeFilename(name) {
  return name
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
}

function formatDate(isoString) {
  if (!isoString) {
    return new Date().toISOString().slice(0, 10);
  }
  try {
    return new Date(isoString).toISOString().slice(0, 10);
  } catch (_e) {
    return isoString.slice(0, 10);
  }
}

function formatDateTime(isoString) {
  if (!isoString) {
    return "unknown";
  }
  try {
    const d = new Date(isoString);
    return d.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch (_e) {
    return isoString;
  }
}

function formatAuthorTag(name, handle) {
  const cleanName = (name || "").trim();
  const cleanHandle = (handle || "").trim().replace(/^@/, "");
  if (cleanName && cleanHandle) {
    return `"${cleanName} (@${cleanHandle})"`;
  }
  if (cleanHandle) {
    return `"@${cleanHandle}"`;
  }
  if (cleanName) {
    return `"${cleanName}"`;
  }
  return '""';
}
