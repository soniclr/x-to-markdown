// Injected into page MAIN world to intercept XHR/fetch for video URLs.
// Communicates with content script via window.postMessage.
(function () {
  "use strict";

  const VIDEO_URL_RE = /video\.twimg\.com\/.*\.mp4/;
  const TWEET_API_RE = /TweetDetail|TweetResultByRestId/;

  // Store: tweetId -> best mp4 URL (highest bitrate)
  const videoMap = {};

  // ── Intercept fetch ──
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";

    if (TWEET_API_RE.test(url)) {
      try {
        const clone = response.clone();
        clone.json().then((data) => extractVideoUrls(data)).catch(() => {});
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
          extractVideoUrls(data);
        } catch (_e) { /* ignore */ }
      });
    }
    return originalSend.apply(this, args);
  };

  // ── Extract mp4 URLs from API response ──
  function extractVideoUrls(data) {
    try {
      walkObject(data);
    } catch (_e) { /* ignore */ }
  }

  function walkObject(obj) {
    if (!obj || typeof obj !== "object") return;

    // Look for tweet result objects with video info
    if (obj.rest_id && obj.legacy) {
      const tweetId = obj.rest_id;
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
      // Remove tracking params, keep only the base mp4 URL
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
  });
})();
