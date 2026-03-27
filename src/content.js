(function () {
  "use strict";

  const FAB_ID = "xtm-fab";
  const TOAST_ROOT_ID = "xtm-toast-root";
  const POSITION_KEY = "xtm-fab-position";
  const PROCESSED_ATTR = "data-xtm-processed";
  const SCAN_INTERVAL_MS = 1500;
  const DB_NAME = "xtm-folder-db";
  const STORE_NAME = "handles";
  const HANDLE_KEY = "saveDir";
  const ARTICLE_FETCH_TIMEOUT_MS = 350;

  let cachedDirHandle = null;
  const videoUrlCache = {}; // tweetId -> mp4 URL
  const articleDataCache = {}; // tweetId -> { type: "note"|"article", data: {...} }
  const pendingArticleWaiters = new Map(); // tweetId -> [{ resolve, timer }]

  init();

  // Listen for video URLs and article data from injector.js (MAIN world)
  window.addEventListener("message", (event) => {
    if (event.data?.type === "XTM_VIDEO_FOUND") {
      videoUrlCache[event.data.tweetId] = event.data.videoUrl;
    }
    if (event.data?.type === "XTM_ARTICLE_FOUND") {
      cacheArticleData(event.data.tweetId, {
        type: event.data.articleType,
        data: event.data.articleData,
      });
    }
    if (event.data?.type === "XTM_ARTICLE_RESULT" && event.data?.articleInfo) {
      cacheArticleData(event.data.tweetId, event.data.articleInfo);
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "FOLDER_UPDATED") {
      showToast(`保存文件夹已设置: ${message.name}`, "success");
      return;
    }

    if (message?.type === "PICK_FOLDER") {
      pickAndStoreFolder()
        .then((result) => sendResponse(result))
        .catch((err) =>
          sendResponse({ success: false, error: err.message })
        );
      return true;
    }

    if (message?.type === "SAVE_TO_FOLDER") {
      handleSaveToFolder(message)
        .then((result) => sendResponse(result))
        .catch((err) =>
          sendResponse({ success: false, error: err.message })
        );
      return true;
    }
  });

  function init() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", onReady);
    } else {
      onReady();
    }
  }

  function onReady() {
    createFab();
    scanAndInjectButtons();
    setInterval(scanAndInjectButtons, SCAN_INTERVAL_MS);
    const observer = new MutationObserver(debounce(scanAndInjectButtons, 300));
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Per-tweet inline save buttons ──

  function scanAndInjectButtons() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const article of articles) {
      if (article.getAttribute(PROCESSED_ATTR)) {
        continue;
      }
      injectInlineButton(article);
      article.setAttribute(PROCESSED_ATTR, "1");
    }
  }

  function injectInlineButton(article) {
    const group = article.querySelector('[role="group"]');
    if (!group) {
      return;
    }

    const btn = document.createElement("button");
    btn.className = "xtm-inline-btn";
    btn.title = "保存为 Markdown";
    btn.setAttribute("aria-label", "Save as Markdown");
    btn.innerHTML = getInlineIcon();
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      handleSave(article, btn);
    });

    group.appendChild(btn);
  }

  function getInlineIcon() {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
      <polyline points="17 21 17 13 7 13 7 21"/>
      <polyline points="7 3 7 8 15 8"/>
    </svg>`;
  }

  // ── Global floating action button ──

  function createFab() {
    if (document.getElementById(FAB_ID)) {
      return;
    }

    const fab = document.createElement("div");
    fab.id = FAB_ID;
    fab.innerHTML = `<button class="xtm-fab-btn" title="保存当前推文为 Markdown">
      ${getFabIcon()}
    </button>`;
    document.documentElement.appendChild(fab);

    const savedPos = loadPosition();
    fab.style.right = savedPos.right + "px";
    fab.style.top = savedPos.top + "px";

    const btn = fab.querySelector(".xtm-fab-btn");
    btn.addEventListener("click", handleFabClick);
    setupDrag(fab);
  }

  function getFabIcon() {
    return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
      <polyline points="17 21 17 13 7 13 7 21"/>
      <polyline points="7 3 7 8 15 8"/>
    </svg>`;
  }

  function setupDrag(fab) {
    let isDragging = false;
    let wasDragged = false;
    let startX = 0;
    let startY = 0;
    let startRight = 0;
    let startTop = 0;

    fab.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      isDragging = true;
      wasDragged = false;
      startX = e.clientX;
      startY = e.clientY;
      startRight = parseInt(fab.style.right) || 20;
      startTop = parseInt(fab.style.top) || 200;
      fab.classList.add("xtm-fab-dragging");
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        wasDragged = true;
      }
      const newRight = Math.max(0, Math.min(window.innerWidth - 56, startRight - dx));
      const newTop = Math.max(0, Math.min(window.innerHeight - 56, startTop + dy));
      fab.style.right = newRight + "px";
      fab.style.top = newTop + "px";
    });

    document.addEventListener("mouseup", () => {
      if (!isDragging) return;
      isDragging = false;
      fab.classList.remove("xtm-fab-dragging");
      if (wasDragged) {
        savePosition({
          right: parseInt(fab.style.right),
          top: parseInt(fab.style.top),
        });
      }
    });

    fab.addEventListener("click", (e) => {
      if (wasDragged) {
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);
  }

  function loadPosition() {
    try {
      const saved = localStorage.getItem(POSITION_KEY);
      if (saved) {
        const pos = JSON.parse(saved);
        return {
          right: Math.max(0, Math.min(window.innerWidth - 56, pos.right || 20)),
          top: Math.max(0, Math.min(window.innerHeight - 56, pos.top || 200)),
        };
      }
    } catch (_e) { /* ignore */ }
    return { right: 20, top: 200 };
  }

  function savePosition(pos) {
    try {
      localStorage.setItem(POSITION_KEY, JSON.stringify(pos));
    } catch (_e) { /* ignore */ }
  }

  async function handleFabClick() {
    const fab = document.getElementById(FAB_ID);
    const btn = fab?.querySelector(".xtm-fab-btn");
    if (!btn || btn.classList.contains("xtm-fab-saving")) {
      return;
    }

    const article = findVisibleTweet();
    if (!article) {
      showToast("未找到可保存的推文，请滚动到推文可见区域", "error");
      return;
    }

    btn.classList.add("xtm-fab-saving");
    try {
      const tweetData = await extractTweetData(article);
      if (!tweetData.url) {
        showToast("无法识别帖子链接", "error");
        return;
      }
      const response = await sendToBackground({ type: "SAVE_TWEET", payload: tweetData });
      if (response.success) {
        btn.classList.add("xtm-fab-saved");
        showToast(response.message || "已保存", "success");
        setTimeout(() => btn.classList.remove("xtm-fab-saved"), 3000);
      } else {
        showToast(response.error || "保存失败", "error");
      }
    } catch (err) {
      showToast("保存出错: " + (err.message || "未知错误"), "error");
    } finally {
      btn.classList.remove("xtm-fab-saving");
    }
  }

  function findVisibleTweet() {
    // On detail pages (/status/), prefer the main tweet over replies
    const pathMatch = window.location.pathname.match(/\/([^/]+)\/status\/(\d+)/);
    if (pathMatch) {
      const statusId = pathMatch[2];
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      for (const article of articles) {
        const link = findStatusLink(article);
        const href = link?.getAttribute("href") || "";
        if (href.includes(`/status/${statusId}`)) {
          return article;
        }
      }
    }

    // Fallback: find the tweet closest to viewport center
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    const viewportCenter = window.innerHeight / 2;
    let best = null;
    let bestDist = Infinity;
    for (const article of articles) {
      const rect = article.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        continue;
      }
      const center = rect.top + rect.height / 2;
      const dist = Math.abs(center - viewportCenter);
      if (dist < bestDist) {
        bestDist = dist;
        best = article;
      }
    }
    return best;
  }

  // ── Shared save handler ──

  async function handleSave(article, btn) {
    if (btn.classList.contains("xtm-saving")) {
      return;
    }
    btn.classList.add("xtm-saving");

    try {
      const tweetData = await extractTweetData(article);
      if (!tweetData.url) {
        showToast("无法识别帖子链接", "error");
        return;
      }
      const response = await sendToBackground({ type: "SAVE_TWEET", payload: tweetData });
      if (response.success) {
        btn.classList.add("xtm-saved");
        showToast(response.message || "已保存", "success");
      } else {
        showToast(response.error || "保存失败", "error");
      }
    } catch (err) {
      showToast("保存出错: " + (err.message || "未知错误"), "error");
    } finally {
      btn.classList.remove("xtm-saving");
    }
  }

  // ── Tweet data extraction ──

  async function extractTweetData(article) {
    // On detail pages, use URL for tweetId (more reliable than DOM link)
    const pathMatch = window.location.pathname.match(/\/([^/]+)\/status\/(\d+)/);
    let url = "";
    let tweetId = "";

    if (pathMatch) {
      // Detail page — use URL directly
      url = `https://x.com/${pathMatch[1]}/status/${pathMatch[2]}`;
      tweetId = pathMatch[2];
    } else {
      // Timeline/feed — use link inside article
      const statusLink = findStatusLink(article);
      url = normalizeUrl(statusLink?.href || statusLink?.getAttribute("href") || "");
      const match = url.match(/status\/(\d+)/);
      tweetId = match ? match[1] : "";
    }

    // Check if we have API-sourced article/note data for this tweet.
    let cachedArticle = tweetId ? articleDataCache[tweetId] : null;

    // Always extract DOM images — these are reliable, working URLs
    const domMediaUrls = extractMediaUrls(article, tweetId);

    const data = {
      url,
      tweetId,
      authorHandle: pathMatch ? pathMatch[1] : extractHandle(article),
      authorName: extractAuthorName(article),
      text: extractText(article),
      publishedAt: extractPublishedTime(article),
      capturedAt: new Date().toISOString(),
      metrics: extractMetrics(article),
      mediaUrls: domMediaUrls,
      quotedTweet: extractQuotedTweet(article),
    };

    // Only request injector cache when body text is empty (likely long-form content card),
    // to avoid slowing down normal tweet saves.
    if (!cachedArticle && tweetId && !data.text && pathMatch) {
      cachedArticle = await requestArticleDataFromInjector(tweetId);
    }

    // If no API cache and text is empty, fall back to DOM extraction in strict DOM order.
    // This path now includes code blocks to avoid missing long-form technical content.
    if (!cachedArticle && !data.text && pathMatch) {
      const contentBlocks = extractDomArticleBlocks(article);
      if (contentBlocks.length > 0) {
        const textParts = contentBlocks.filter((b) => b.type === "text");
        data.text = textParts.map((b) => b.content).join("\n\n");
        data.isArticle = true;
        data.articleTitle = data.text.split("\n")[0]?.slice(0, 100) || "";
        data.contentBlocks = contentBlocks;
        const blockImages = contentBlocks
          .filter((b) => b.type === "image")
          .map((b) => ({ type: "image", url: b.url }));
        const nonImageMedia = domMediaUrls.filter((m) => m.type !== "image");
        data.mediaUrls = [...blockImages, ...nonImageMedia];
      }
    }

    if (cachedArticle?.type === "note") {
      // For Notes: use API text + DOM images
      // API gives us text + inline_media positions, DOM gives us actual image URLs
      const domImages = domMediaUrls
        .filter((m) => m.type === "image")
        .map((m) => m.url);
      const noteBlocks = buildNoteBlocks(cachedArticle.data, domImages);
      if (noteBlocks.length > 0) {
        data.isArticle = true;
        data.articleTitle = noteBlocks.find((b) => b.type === "text")?.content?.split("\n")[0]?.slice(0, 100) || "";
        data.contentBlocks = noteBlocks;
        // Collect ALL image URLs from content blocks for downloading
        const blockImages = noteBlocks
          .filter((b) => b.type === "image")
          .map((b) => ({ type: "image", url: b.url }));
        // Merge: block images + any video/video_thumbnail from DOM
        const nonImageMedia = domMediaUrls.filter((m) => m.type !== "image");
        data.mediaUrls = [...blockImages, ...nonImageMedia];
      }
    } else if (cachedArticle?.type === "article") {
      const domImages = domMediaUrls
        .filter((m) => m.type === "image")
        .map((m) => m.url);
      const articleBlocks = buildArticleBlocks(cachedArticle.data, domImages);
      if (articleBlocks.length > 0) {
        data.isArticle = true;
        data.articleTitle = cachedArticle.data.title || "";
        data.contentBlocks = articleBlocks;
        data.text = "";
        // Collect image URLs from content blocks for downloading
        const blockImages = articleBlocks
          .filter((b) => b.type === "image")
          .map((b) => ({ type: "image", url: b.url }));
        const nonImageMedia = domMediaUrls.filter((m) => m.type !== "image");
        data.mediaUrls = [...blockImages, ...nonImageMedia];
      }
    }

    return data;
  }

  // ── Note (long-form tweet) content block building ──

  function buildNoteBlocks(noteData, domImages) {
    const blocks = [];
    const text = noteData.text || "";
    if (!text) return blocks;

    const inlineMedia = noteData.inlineMedia || [];
    const mediaEntities = noteData.mediaEntities || [];

    // DEBUG: 临时调试日志，排查图片偏移问题
    // domImages: array of image URLs extracted from the DOM (reliable, downloadable)

    // Try to build image URL list from API media entities first
    const apiImageUrls = mediaEntities
      .filter((e) => (e.type === "photo" || !e.type) && (e.media_url_https || e.media_url))
      .map((e) => cleanImageUrl(e.media_url_https || e.media_url));

    // Use DOM images as primary source — they always work
    // Fall back to API images only if DOM has none
    const imageUrls = (domImages && domImages.length > 0) ? domImages : apiImageUrls;

    if (inlineMedia.length === 0 || imageUrls.length === 0) {
      // No inline media positions or no images — put all text first, then images at the end
      blocks.push({ type: "text", content: text });
      for (const url of imageUrls) {
        blocks.push({ type: "image", url });
      }
      return blocks;
    }

    // 题图 = domImages 中的第一张（从 tweetPhoto 容器提取），不在 inlineMedia 中
    // inlineMedia 中的每一项都是正文中的内联图片
    // 所以：题图放最前面，inlineMedia[i] 对应 imageUrls[i+1]
    blocks.push({ type: "image", url: imageUrls[0] });

    const contentImages = imageUrls.slice(1);

    // Sort inline media by index (character position in text)
    const sortedMedia = [...inlineMedia].sort((a, b) => a.index - b.index);

    let lastIndex = 0;
    for (let i = 0; i < sortedMedia.length; i++) {
      const insertAt = sortedMedia[i].index;

      if (insertAt > lastIndex) {
        const textChunk = text.slice(lastIndex, insertAt).trim();
        if (textChunk) {
          blocks.push({ type: "text", content: textChunk });
        }
      }
      lastIndex = insertAt;

      const mediaUrl = contentImages[i] || "";
      if (mediaUrl) {
        blocks.push({ type: "image", url: mediaUrl });
      }
    }

    // Remaining text after last inline media
    if (lastIndex < text.length) {
      const remaining = text.slice(lastIndex).trim();
      if (remaining) {
        blocks.push({ type: "text", content: remaining });
      }
    }

    // Any remaining images that weren't matched to inline positions
    for (let i = sortedMedia.length; i < contentImages.length; i++) {
      blocks.push({ type: "image", url: contentImages[i] });
    }

    return blocks;
  }

  // ── Article (X Articles with Draft.js content_state) content block building ──

  function buildArticleBlocks(articleData, domImages) {
    const blocks = [];
    const contentState = articleData.contentState;

    if (!contentState?.blocks) {
      // Fallback to plain text if no content_state
      const plainText = articleData.previewText || "";
      if (plainText) {
        blocks.push({ type: "text", content: plainText });
      }
      // Append DOM images if available
      if (domImages) {
        for (const url of domImages) {
          blocks.push({ type: "image", url });
        }
      }
      return blocks;
    }

    const entityMap = contentState.entityMap || {};

    // Build media URL map from article media_entities
    const mediaUrlMap = {};
    for (const entity of (articleData.mediaEntities || [])) {
      const key = entity.media_id || entity.media_key || entity.id_str;
      const url = entity.media_info?.original_img_url ||
        entity.media_url_https || entity.media_url || "";
      if (key && url) {
        mediaUrlMap[key] = cleanImageUrl(url);
      }
    }

    // Track how many atomic/image blocks we find from API
    let apiImageCount = 0;
    // Track atomic block positions for DOM image insertion
    const atomicPositions = [];

    for (let i = 0; i < contentState.blocks.length; i++) {
      const block = contentState.blocks[i];
      const blockType = block.type || "unstyled";

      if (blockType === "atomic") {
        // Atomic blocks contain media/embeds via entity ranges
        let handledAtomic = false;
        let foundImage = false;
        for (const range of (block.entityRanges || [])) {
          const entity = entityMap[String(range.key)];
          if (!entity) continue;
          const eType = entity.type || entity.value?.type || "";
          const eData = entity.data || entity.value?.data || entity.value || {};

          if (eType === "MEDIA" || eType === "IMAGE") {
            // Find image URL from media items or direct URL
            const mediaItems = eData.mediaItems || [];
            if (mediaItems.length > 0) {
              for (const item of mediaItems) {
                const url = item.media_info?.original_img_url ||
                  item.media_url_https || mediaUrlMap[item.media_id] || "";
                if (url) {
                  blocks.push({ type: "image", url: cleanImageUrl(url) });
                  apiImageCount++;
                  handledAtomic = true;
                  foundImage = true;
                }
              }
            } else if (eData.url) {
              blocks.push({ type: "image", url: cleanImageUrl(eData.url) });
              apiImageCount++;
              handledAtomic = true;
              foundImage = true;
            }
          } else if (eType === "CODE" || eType === "CODE_BLOCK" || eType === "PRE") {
            const codeText = extractCodeTextFromEntityData(eData);
            if (codeText) {
              blocks.push({ type: "text", content: toCodeFence(codeText) });
              handledAtomic = true;
            }
          } else if (eType === "TWEET") {
            const tweetUrl = eData.tweetId
              ? `https://x.com/i/status/${eData.tweetId}`
              : "";
            if (tweetUrl) {
              blocks.push({ type: "text", content: `[Embedded Tweet](${tweetUrl})` });
              handledAtomic = true;
            }
          } else if (eType === "LINK") {
            const linkUrl = eData.url || "";
            if (linkUrl) {
              blocks.push({ type: "text", content: `[${linkUrl}](${linkUrl})` });
              handledAtomic = true;
            }
          }
        }
        // Record position for DOM image fallback
        if (!handledAtomic && !foundImage) {
          atomicPositions.push(blocks.length);
        }
        continue;
      }

      // Group consecutive code-block items into a single fenced code block
      if (blockType === "code-block" || blockType === "code" || blockType === "pre") {
        const codeLines = [block.text || ""];
        while (i + 1 < contentState.blocks.length &&
               ["code-block", "code", "pre"].includes(contentState.blocks[i + 1].type || "unstyled")) {
          i++;
          codeLines.push(contentState.blocks[i].text || "");
        }
        blocks.push({ type: "text", content: toCodeFence(codeLines.join("\n")) });
        continue;
      }

      // Text-based blocks — apply inline styles and entity links
      const rawText = block.text || "";
      if (!rawText.trim()) {
        // Empty block = paragraph break, skip
        continue;
      }

      const text = applyInlineFormatting(rawText, block.inlineStyleRanges || [], block.entityRanges || [], entityMap);

      // Apply block-level formatting
      let content = text;
      if (blockType === "header-one") {
        content = `# ${text}`;
      } else if (blockType === "header-two") {
        content = `## ${text}`;
      } else if (blockType === "header-three") {
        content = `### ${text}`;
      } else if (blockType.startsWith("header-")) {
        const level = blockType.replace("header-", "");
        const levelMap = { four: 4, five: 5, six: 6 };
        const n = levelMap[level] || 4;
        content = `${"#".repeat(n)} ${text}`;
      } else if (blockType === "blockquote") {
        content = `> ${text}`;
      } else if (blockType === "unordered-list-item") {
        content = `- ${text}`;
      } else if (blockType === "ordered-list-item") {
        content = `1. ${text}`;
      }

      blocks.push({ type: "text", content });
    }

    // If API didn't resolve any images but we have DOM images, use DOM as fallback
    // domImages[0] is the cover image (from tweetPhoto container), rest are inline content images
    if (apiImageCount === 0 && domImages && domImages.length > 0) {
      // Insert cover image at the very beginning
      blocks.splice(0, 0, { type: "image", url: domImages[0] });

      // Remaining images (content images) map to atomic block positions
      const contentImages = domImages.slice(1);

      if (atomicPositions.length > 0 && contentImages.length > 0) {
        // atomicPositions were recorded before the cover insert, so shift by 1
        const insertCount = Math.min(atomicPositions.length, contentImages.length);
        for (let i = insertCount - 1; i >= 0; i--) {
          blocks.splice(atomicPositions[i] + 1, 0, { type: "image", url: contentImages[i] });
        }
        // Append remaining images that don't have atomic positions
        for (let i = insertCount; i < contentImages.length; i++) {
          blocks.push({ type: "image", url: contentImages[i] });
        }
      } else {
        // No atomic blocks — append content images at end
        for (const url of contentImages) {
          blocks.push({ type: "image", url });
        }
      }
    }

    return blocks;
  }

  // ── Apply Draft.js inline styles and entity links to text ──

  function applyInlineFormatting(text, inlineStyleRanges, entityRanges, entityMap) {
    if ((!inlineStyleRanges || inlineStyleRanges.length === 0) &&
        (!entityRanges || entityRanges.length === 0)) {
      return text;
    }

    // Build a per-character annotation array
    const len = text.length;
    const chars = new Array(len);
    for (let i = 0; i < len; i++) {
      chars[i] = { styles: new Set(), entity: null };
    }

    for (const range of inlineStyleRanges) {
      const start = range.offset;
      const end = Math.min(start + range.length, len);
      for (let i = start; i < end; i++) {
        chars[i].styles.add(range.style);
      }
    }

    for (const range of entityRanges) {
      const start = range.offset;
      const end = Math.min(start + range.length, len);
      const entity = entityMap[String(range.key)];
      if (!entity) continue;
      for (let i = start; i < end; i++) {
        chars[i].entity = entity;
      }
    }

    // Group consecutive characters with the same formatting
    const segments = [];
    let segStart = 0;
    for (let i = 1; i <= len; i++) {
      if (i < len &&
          sameStyles(chars[i].styles, chars[segStart].styles) &&
          chars[i].entity === chars[segStart].entity) {
        continue;
      }
      segments.push({
        text: text.slice(segStart, i),
        styles: chars[segStart].styles,
        entity: chars[segStart].entity,
      });
      segStart = i;
    }

    // Render each segment
    const parts = [];
    for (const seg of segments) {
      let s = seg.text;

      // Apply inline styles (CODE first, since it shouldn't nest bold/italic)
      if (seg.styles.has("CODE")) {
        s = "`" + s + "`";
      } else {
        if (seg.styles.has("BOLD")) {
          s = "**" + s + "**";
        }
        if (seg.styles.has("ITALIC")) {
          s = "_" + s + "_";
        }
        if (seg.styles.has("STRIKETHROUGH")) {
          s = "~~" + s + "~~";
        }
      }

      // Apply entity link
      if (seg.entity) {
        const eType = seg.entity.type || seg.entity.value?.type || "";
        const eData = seg.entity.data || seg.entity.value?.data || seg.entity.value || {};
        if (eType === "LINK" && eData.url) {
          s = `[${s}](${eData.url})`;
        }
      }

      parts.push(s);
    }

    return parts.join("");
  }

  function sameStyles(a, b) {
    if (a.size !== b.size) return false;
    for (const s of a) {
      if (!b.has(s)) return false;
    }
    return true;
  }

  function cacheArticleData(tweetId, articleInfo) {
    if (!tweetId || !articleInfo?.type || !articleInfo?.data) {
      return;
    }
    articleDataCache[tweetId] = articleInfo;

    const waiters = pendingArticleWaiters.get(tweetId);
    if (!waiters || waiters.length === 0) {
      return;
    }
    pendingArticleWaiters.delete(tweetId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(articleInfo);
    }
  }

  function waitForArticleData(tweetId, timeoutMs) {
    if (!tweetId) {
      return Promise.resolve(null);
    }
    if (articleDataCache[tweetId]) {
      return Promise.resolve(articleDataCache[tweetId]);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const waiters = pendingArticleWaiters.get(tweetId) || [];
        const filtered = waiters.filter((w) => w.resolve !== resolve);
        if (filtered.length > 0) {
          pendingArticleWaiters.set(tweetId, filtered);
        } else {
          pendingArticleWaiters.delete(tweetId);
        }
        resolve(articleDataCache[tweetId] || null);
      }, timeoutMs);

      const waiters = pendingArticleWaiters.get(tweetId) || [];
      waiters.push({ resolve, timer });
      pendingArticleWaiters.set(tweetId, waiters);
    });
  }

  async function requestArticleDataFromInjector(tweetId) {
    if (!tweetId) {
      return null;
    }
    if (articleDataCache[tweetId]) {
      return articleDataCache[tweetId];
    }
    const waiting = waitForArticleData(tweetId, ARTICLE_FETCH_TIMEOUT_MS);
    window.postMessage({ type: "XTM_GET_ARTICLE", tweetId }, "*");
    return waiting;
  }

  function extractDomArticleBlocks(mainArticle) {
    const primaryCol = document.querySelector('[data-testid="primaryColumn"]') || document.body;
    const selector = [
      '[data-testid="tweetText"]',
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "blockquote",
      "ul > li",
      "ol > li",
      "pre",
      'img[src*="pbs.twimg.com/media/"]',
    ].join(", ");

    const blocks = [];
    const seenImages = new Set();

    for (const node of primaryCol.querySelectorAll(selector)) {
      if (!shouldIncludeLongformNode(node, mainArticle)) {
        continue;
      }
      if (node.tagName === "P" && node.closest("blockquote")) {
        continue;
      }

      if (node.tagName === "IMG") {
        const src = node.getAttribute("src") || "";
        if (!src || src.includes("emoji") || src.includes("profile_images")) {
          continue;
        }
        const clean = cleanImageUrl(src);
        if (!seenImages.has(clean)) {
          seenImages.add(clean);
          blocks.push({ type: "image", url: clean });
        }
        continue;
      }

      if (node.tagName === "PRE") {
        const codeText = (node.innerText || node.textContent || "").replace(/\r\n/g, "\n");
        if (codeText.trim()) {
          blocks.push({ type: "text", content: toCodeFence(codeText.replace(/\n+$/, "")) });
        }
        continue;
      }

      const rawText = extractRichTextMarkdown(node).trim();
      if (!rawText) {
        continue;
      }

      let content = rawText;
      if (/^H[1-6]$/.test(node.tagName)) {
        const level = Number(node.tagName.slice(1)) || 1;
        content = `${"#".repeat(level)} ${rawText}`;
      } else if (node.tagName === "BLOCKQUOTE") {
        content = rawText
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
      } else if (node.tagName === "LI") {
        const listTag = node.parentElement?.tagName || "";
        const marker = listTag === "OL" ? "1. " : "- ";
        content = marker + rawText;
      }

      const last = blocks[blocks.length - 1];
      if (!(last && last.type === "text" && last.content === content)) {
        blocks.push({ type: "text", content });
      }
    }

    return blocks;
  }

  function shouldIncludeLongformNode(node, mainArticle) {
    if (node.closest('[data-testid="quoteTweet"]')) {
      return false;
    }

    const parentArticle = node.closest('article[data-testid="tweet"]');
    if (!parentArticle) {
      return true;
    }
    return parentArticle === mainArticle;
  }

  function extractRichTextMarkdown(rootNode) {
    const parts = [];
    for (const node of rootNode.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.textContent || "");
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }

      if (node.tagName === "BR") {
        parts.push("\n");
        continue;
      }

      if (node.tagName === "A") {
        const href = node.getAttribute("href") || "";
        const text = (node.textContent || "").trim() || href;
        if (href.startsWith("http")) {
          parts.push(`[${text}](${href})`);
        } else if (href.startsWith("/")) {
          parts.push(`[${text}](https://x.com${href})`);
        } else {
          parts.push(text);
        }
        continue;
      }

      parts.push(extractRichTextMarkdown(node));
    }
    return parts.join("").replace(/\u00a0/g, " ");
  }

  function extractCodeTextFromEntityData(data) {
    if (!data) {
      return "";
    }
    if (typeof data === "string") {
      return data;
    }
    if (Array.isArray(data)) {
      const textParts = data.filter((item) => typeof item === "string");
      if (textParts.length > 0) {
        return textParts.join("\n");
      }
      return "";
    }

    const keys = ["code", "text", "source", "content", "snippet", "body", "value"];
    for (const key of keys) {
      const value = data[key];
      if (!value) {
        continue;
      }
      const extracted = extractCodeTextFromEntityData(value);
      if (extracted) {
        return extracted;
      }
    }
    return "";
  }

  function toCodeFence(codeText) {
    const normalized = (codeText || "").replace(/\r\n/g, "\n");
    const ticks = normalized.match(/`+/g) || [];
    const longestTick = ticks.reduce((max, t) => Math.max(max, t.length), 0);
    const fence = "`".repeat(Math.max(3, longestTick + 1));
    return `${fence}\n${normalized}\n${fence}`;
  }

  function extractText(article) {
    const textEl = article.querySelector('[data-testid="tweetText"]');
    if (!textEl) {
      return "";
    }
    const parts = [];
    for (const node of textEl.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.textContent);
      } else if (node.tagName === "A") {
        const href = node.getAttribute("href") || "";
        const linkText = node.textContent || "";
        if (href.startsWith("http")) {
          parts.push(`[${linkText}](${href})`);
        } else if (href.startsWith("/")) {
          parts.push(`[${linkText}](https://x.com${href})`);
        } else {
          parts.push(linkText);
        }
      } else if (node.tagName === "IMG") {
        parts.push(node.getAttribute("alt") || "");
      } else {
        parts.push(node.textContent || "");
      }
    }
    return parts.join("").trim();
  }

  function extractAuthorName(article) {
    const userNameEl = article.querySelector('[data-testid="User-Name"]');
    if (!userNameEl) {
      return "";
    }
    const lines = userNameEl.innerText.split("\n").map((s) => s.trim()).filter(Boolean);
    for (const line of lines) {
      if (!line.startsWith("@")) {
        return line;
      }
    }
    return lines[0] || "";
  }

  function extractHandle(article) {
    const link = findStatusLink(article);
    const href = link?.getAttribute("href") || "";
    const match = href.match(/^\/([^/]+)\//);
    if (match) {
      return match[1];
    }
    const userNameEl = article.querySelector('[data-testid="User-Name"]');
    if (!userNameEl) {
      return "";
    }
    const lines = userNameEl.innerText.split("\n").map((s) => s.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.startsWith("@")) {
        return line.slice(1);
      }
    }
    return "";
  }

  function extractPublishedTime(article) {
    const timeEl = article.querySelector("time");
    return timeEl?.getAttribute("datetime") || "";
  }

  function extractMetrics(article) {
    const metrics = { replies: "0", reposts: "0", likes: "0", views: "0", bookmarks: "0" };
    const group = article.querySelector('[role="group"]');
    if (!group) return metrics;

    const testIdMap = { reply: "replies", retweet: "reposts", like: "likes", bookmark: "bookmarks" };
    for (const [testId, key] of Object.entries(testIdMap)) {
      const el = group.querySelector(`[data-testid="${testId}"]`);
      const label = el?.getAttribute("aria-label") || "";
      const match = label.match(/([\d,.]+(?:[KMB万亿])?)/i);
      if (match) metrics[key] = match[1];
    }

    const analyticsLink = article.querySelector('a[href*="/analytics"]');
    const viewLabel = analyticsLink?.getAttribute("aria-label") || "";
    const viewMatch = viewLabel.match(/([\d,.]+(?:[KMB万亿])?)/i);
    if (viewMatch) metrics.views = viewMatch[1];

    return metrics;
  }

  function extractMediaUrls(article, tweetId) {
    const urls = [];
    const seen = new Set();

    // 1. Standard tweet photos (wrapped in tweetPhoto container)
    const tweetPhotos = article.querySelectorAll('[data-testid="tweetPhoto"] img[src]');
    for (const img of tweetPhotos) {
      const src = img.getAttribute("src") || "";
      if (src && !src.includes("emoji") && !src.includes("profile_images")) {
        const clean = cleanImageUrl(src);
        if (!seen.has(clean)) {
          seen.add(clean);
          urls.push({ type: "image", url: clean });
        }
      }
    }

    // 2. Inline images in Note/long-form content (pbs.twimg.com images not in tweetPhoto)
    //    These appear directly in the article as <img> with pbs.twimg.com/media/ src
    const allImages = article.querySelectorAll('img[src*="pbs.twimg.com/media/"]');
    for (const img of allImages) {
      // Skip if inside quoted tweet
      if (img.closest('[data-testid="quoteTweet"]')) continue;
      const src = img.getAttribute("src") || "";
      if (src) {
        const clean = cleanImageUrl(src);
        if (!seen.has(clean)) {
          seen.add(clean);
          urls.push({ type: "image", url: clean });
        }
      }
    }

    // 3. Video: use intercepted mp4 URL if available, otherwise save poster
    const videoUrl = tweetId ? videoUrlCache[tweetId] : null;
    if (videoUrl) {
      urls.push({ type: "video", url: videoUrl });
    }
    const videoEls = article.querySelectorAll("video[poster]");
    for (const vid of videoEls) {
      const poster = vid.getAttribute("poster");
      if (poster) {
        urls.push({ type: "video_thumbnail", url: poster });
      }
    }
    return urls;
  }

  function extractQuotedTweet(article) {
    const quoteEl = article.querySelector('[data-testid="quoteTweet"]');
    if (!quoteEl) return null;
    const textEl = quoteEl.querySelector('[data-testid="tweetText"]');
    const text = textEl?.innerText?.trim() || "";
    const link = quoteEl.querySelector('a[href*="/status/"]');
    const url = normalizeUrl(link?.href || link?.getAttribute("href") || "");
    const userEl = quoteEl.querySelector('[data-testid="User-Name"]');
    const author = userEl?.innerText?.split("\n")?.[0]?.trim() || "";
    if (!url && !text) return null;
    return { url, text, author };
  }

  function cleanImageUrl(src) {
    try {
      const url = new URL(src);
      url.searchParams.set("name", "large");
      return url.toString();
    } catch (_e) {
      return src;
    }
  }

  function findStatusLink(article) {
    const candidates = article.querySelectorAll('a[href*="/status/"]');
    for (const candidate of candidates) {
      if (candidate.closest('[data-testid="quoteTweet"]')) continue;
      if (candidate.querySelector("time")) return candidate;
    }
    return candidates[0] || null;
  }

  function normalizeUrl(href) {
    if (!href) return "";
    const raw = href.startsWith("http") ? href : "https://x.com" + href;
    try {
      const url = new URL(raw);
      const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
      if (!match) return raw;
      return `https://x.com/${match[1]}/status/${match[2]}`;
    } catch (_e) {
      return raw;
    }
  }

  // ── File System Access API ──

  async function pickAndStoreFolder() {
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      await storeHandle(dirHandle);
      cachedDirHandle = dirHandle;
      chrome.storage.local.set({ folderName: dirHandle.name });
      return { success: true, name: dirHandle.name };
    } catch (err) {
      if (err.name === "AbortError") {
        return { success: false, error: "cancelled" };
      }
      return { success: false, error: err.message };
    }
  }

  async function handleSaveToFolder({ payload, settings, filename, mediaDownloads }) {
    const dirHandle = await ensureDirHandle();
    if (!dirHandle) {
      return { success: false, error: "未选择文件夹" };
    }

    const permission = await dirHandle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      const requested = await dirHandle.requestPermission({ mode: "readwrite" });
      if (requested !== "granted") {
        return { success: false, error: "未获得文件夹写入权限，请重新选择文件夹" };
      }
    }

    // 1. Download media first, collect success map
    const mediaUrlMap = {}; // remoteUrl -> localPath
    let failedCount = 0;
    if (mediaDownloads?.length > 0) {
      const results = await downloadMediaFiles(dirHandle, mediaDownloads);
      for (const r of results) {
        if (r.success) {
          mediaUrlMap[r.remoteUrl] = r.localPath;
        } else {
          failedCount++;
        }
      }
    }

    // 2. Ask background to build markdown with the success map
    const { markdown } = await sendToBackground({
      type: "BUILD_MARKDOWN",
      payload,
      settings,
      mediaUrlMap,
    });

    // 3. Write markdown file
    try {
      const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(markdown);
      await writable.close();

      const msg = failedCount > 0
        ? `已保存到 ${dirHandle.name}/${filename}（${failedCount} 个媒体下载失败）`
        : `已保存到 ${dirHandle.name}/${filename}`;

      return { success: true, message: msg };
    } catch (err) {
      return { success: false, error: "写入文件失败: " + err.message };
    }
  }

  async function ensureDirHandle() {
    let dirHandle = cachedDirHandle || await getStoredHandle();
    if (dirHandle) return dirHandle;

    try {
      dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      await storeHandle(dirHandle);
      cachedDirHandle = dirHandle;
      chrome.storage.local.set({ folderName: dirHandle.name });
      return dirHandle;
    } catch (err) {
      if (err.name === "AbortError") return null;
      throw err;
    }
  }

  async function getOrCreateDir(parentHandle, pathSegments) {
    let current = parentHandle;
    for (const segment of pathSegments) {
      current = await current.getDirectoryHandle(segment, { create: true });
    }
    return current;
  }

  async function downloadMediaFiles(dirHandle, mediaDownloads) {
    const results = [];

    for (const media of mediaDownloads) {
      try {
        const response = await fetch(media.remoteUrl);
        if (!response.ok) {
          results.push({ success: false, remoteUrl: media.remoteUrl });
          continue;
        }
        const blob = await response.blob();

        const dirSegments = media.dir.split("/");
        const subDir = await getOrCreateDir(dirHandle, dirSegments);

        const fileHandle = await subDir.getFileHandle(media.localName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();

        results.push({ success: true, remoteUrl: media.remoteUrl, localPath: media.localPath });
      } catch (err) {
        showToast(`媒体下载失败: ${err.message}`, "error");
        results.push({ success: false, remoteUrl: media.remoteUrl });
      }
    }

    return results;
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function storeHandle(handle) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getStoredHandle() {
    if (cachedDirHandle) {
      return cachedDirHandle;
    }
    try {
      const db = await openDB();
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const request = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
        request.onsuccess = () => {
          cachedDirHandle = request.result || null;
          resolve(cachedDirHandle);
        };
        request.onerror = () => resolve(null);
      });
    } catch (_e) {
      return null;
    }
  }

  // ── Utilities ──

  function sendToBackground(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            const err = chrome.runtime.lastError.message || "";
            if (err.includes("Extension context invalidated")) {
              showToast("插件已更新，请刷新页面", "info");
              reject(new Error("请刷新页面"));
              return;
            }
            reject(new Error(err));
            return;
          }
          resolve(response || { success: false, error: "empty response" });
        });
      } catch (err) {
        showToast("插件已更新，请刷新页面", "info");
        reject(new Error("请刷新页面"));
      }
    });
  }

  function getToastRoot() {
    let root = document.getElementById(TOAST_ROOT_ID);
    if (root) return root;
    root = document.createElement("div");
    root.id = TOAST_ROOT_ID;
    document.documentElement.appendChild(root);
    return root;
  }

  function showToast(message, type) {
    const root = getToastRoot();
    const toast = document.createElement("div");
    toast.className = "xtm-toast xtm-toast-" + type;
    toast.textContent = message;
    root.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("xtm-toast-visible"));
    setTimeout(() => {
      toast.classList.remove("xtm-toast-visible");
      setTimeout(() => toast.remove(), 250);
    }, 2500);
  }

  function debounce(fn, delayMs) {
    let timer = null;
    return function (...args) {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn.apply(this, args);
      }, delayMs);
    };
  }
})();
