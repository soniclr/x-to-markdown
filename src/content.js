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

  let cachedDirHandle = null;

  init();

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
      const tweetData = extractTweetData(article);
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
      const tweetData = extractTweetData(article);
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

  function extractTweetData(article) {
    const statusLink = findStatusLink(article);
    const url = normalizeUrl(
      statusLink?.href || statusLink?.getAttribute("href") || ""
    );
    const tweetIdMatch = url.match(/status\/(\d+)/);

    return {
      url,
      tweetId: tweetIdMatch ? tweetIdMatch[1] : "",
      authorHandle: extractHandle(article),
      authorName: extractAuthorName(article),
      text: extractText(article),
      publishedAt: extractPublishedTime(article),
      capturedAt: new Date().toISOString(),
      metrics: extractMetrics(article),
      mediaUrls: extractMediaUrls(article),
      quotedTweet: extractQuotedTweet(article),
    };
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

  function extractMediaUrls(article) {
    const urls = [];
    const images = article.querySelectorAll('[data-testid="tweetPhoto"] img[src]');
    for (const img of images) {
      const src = img.getAttribute("src") || "";
      if (src && !src.includes("emoji") && !src.includes("profile_images")) {
        urls.push({ type: "image", url: cleanImageUrl(src) });
      }
    }
    const videos = article.querySelectorAll("video[src], video source[src]");
    for (const vid of videos) {
      const src = vid.getAttribute("src") || "";
      if (src) urls.push({ type: "video", url: src });
    }
    const videoPoster = article.querySelector("video[poster]");
    if (videoPoster) {
      const poster = videoPoster.getAttribute("poster");
      if (poster) urls.push({ type: "video_thumbnail", url: poster });
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
        const response = await fetch(media.remoteUrl, { mode: "cors" });
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
      } catch (_err) {
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
