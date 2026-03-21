// Injected into page MAIN world to intercept XHR/fetch for video URLs and article content.
// Communicates with content script via window.postMessage.
(function () {
  "use strict";

  const VIDEO_URL_RE = /video\.twimg\.com\/.*\.mp4/;
  const TWEET_API_RE = /TweetDetail|TweetResultByRestId/;

  // Store: tweetId -> best mp4 URL (highest bitrate)
  const videoMap = {};
  // Store: tweetId -> note/article data
  const articleMap = {};

  // ── Intercept fetch ──
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";

    if (TWEET_API_RE.test(url)) {
      try {
        const clone = response.clone();
        clone.json().then((data) => extractTweetData(data)).catch(() => {});
      } catch (_e) { /* ignore */ }
    }

    return response;
  };

  // ── Intercept XMLHttpRequest ──
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._xtmUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this._xtmUrl && TWEET_API_RE.test(this._xtmUrl)) {
      this.addEventListener("load", function () {
        try {
          const data = JSON.parse(this.responseText);
          extractTweetData(data);
        } catch (_e) { /* ignore */ }
      });
    }
    return originalSend.apply(this, args);
  };

  // ── Extract data from API response ──
  function extractTweetData(data) {
    try {
      walkObject(data);
    } catch (_e) { /* ignore */ }
  }

  function walkObject(obj) {
    if (!obj || typeof obj !== "object") return;

    // Look for tweet result objects with video info or article/note data
    if (obj.rest_id && obj.legacy) {
      const tweetId = obj.rest_id;

      // Extract video URLs
      const mediaEntities =
        obj.legacy?.extended_entities?.media ||
        obj.legacy?.entities?.media ||
        [];

      for (const media of mediaEntities) {
        if (media.type === "video" || media.type === "animated_gif") {
          const variants = media.video_info?.variants || [];
          const mp4s = variants
            .filter((v) => v.content_type === "video/mp4" && v.url)
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

          if (mp4s.length > 0) {
            const bestUrl = cleanVideoUrl(mp4s[0].url);
            videoMap[tweetId] = bestUrl;
            window.postMessage({
              type: "XTM_VIDEO_FOUND",
              tweetId,
              videoUrl: bestUrl,
            }, "*");
          }
        }
      }

      // Extract Note (long-form tweet) content
      const noteResult = obj.note_tweet?.note_tweet_results?.result;
      if (noteResult) {
        // Build enriched media entities with all possible ID formats
        const enrichedMedia = mediaEntities.map((entity) => {
          const ids = [];
          if (entity.id_str) ids.push(entity.id_str);
          if (entity.id) ids.push(String(entity.id));
          if (entity.media_key) ids.push(entity.media_key);
          // media_key is often "3_{id_str}" — register the numeric part too
          if (entity.media_key && entity.media_key.includes("_")) {
            ids.push(entity.media_key.split("_").pop());
          }
          return { ...entity, _allIds: ids };
        });

        const noteData = {
          text: noteResult.text || "",
          richTextTags: noteResult.richtext?.richtext_tags || [],
          inlineMedia: noteResult.media?.inline_media || [],
          mediaEntities: enrichedMedia,
        };
        articleMap[tweetId] = { type: "note", data: noteData };
        window.postMessage({
          type: "XTM_ARTICLE_FOUND",
          tweetId,
          articleType: "note",
          articleData: noteData,
        }, "*");
      }

      // Extract Article (full long-form article) content
      const articleResult = obj.article?.article_results?.result;
      if (articleResult) {
        const articleData = {
          title: articleResult.title || "",
          previewText: articleResult.preview_text || "",
          contentState: articleResult.content_state || null,
          coverMedia: articleResult.cover_media || null,
          mediaEntities: articleResult.media_entities || [],
        };
        articleMap[tweetId] = { type: "article", data: articleData };
        window.postMessage({
          type: "XTM_ARTICLE_FOUND",
          tweetId,
          articleType: "article",
          articleData: articleData,
        }, "*");
      }
    }

    // Recurse
    if (Array.isArray(obj)) {
      for (const item of obj) walkObject(item);
    } else {
      for (const value of Object.values(obj)) {
        if (value && typeof value === "object") walkObject(value);
      }
    }
  }

  function cleanVideoUrl(url) {
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch (_e) {
      return url;
    }
  }

  // Content script can request stored video URL
  window.addEventListener("message", (event) => {
    if (event.data?.type === "XTM_GET_VIDEO" && event.data?.tweetId) {
      window.postMessage({
        type: "XTM_VIDEO_RESULT",
        tweetId: event.data.tweetId,
        videoUrl: videoMap[event.data.tweetId] || null,
      }, "*");
    }
    if (event.data?.type === "XTM_GET_ARTICLE" && event.data?.tweetId) {
      window.postMessage({
        type: "XTM_ARTICLE_RESULT",
        tweetId: event.data.tweetId,
        articleInfo: articleMap[event.data.tweetId] || null,
      }, "*");
    }
  });
})();
