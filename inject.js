// MAIN-world script: patches fetch / XMLHttpRequest in the page's own realm
// so we can see subtitle segment responses (WebVTT / TTML) before the player
// renders them. Captured bodies are forwarded to the content script via
// window.postMessage — the content script parses and pre-translates.
//
// Isolated-world content scripts cannot patch page-world fetch, which is why
// this runs in MAIN world via a <script src=...> tag.

(() => {
  if (window.__llmSubtitleCaptureLoaded) return;
  window.__llmSubtitleCaptureLoaded = true;

  const TAG = "__llm-subtitle-capture";

  function urlString(input) {
    try {
      if (typeof input === "string") return input;
      if (input && typeof input.url === "string") return input.url;
      if (input instanceof URL) return input.href;
    } catch (_) {}
    return "";
  }

  function urlLooksLikeSubtitle(url) {
    if (!url) return false;
    if (/\.(vtt|ttml|ttml2|dfxp|srt)(\?|#|$)/i.test(url)) return true;
    if (/subtitle|caption|timedtext|\/cc\//i.test(url)) return true;
    return false;
  }

  function contentTypeLooksLikeSubtitle(ct) {
    if (!ct) return false;
    return /text\/vtt|application\/ttml|application\/ttaf|application\/xml|text\/xml/i.test(
      ct
    );
  }

  // Inspect the first ~1KB of a response body. We only accept plain text
  // WebVTT / TTML — MP4-wrapped subtitles (fMP4 segments) have binary headers
  // and can't be parsed here, so we skip those.
  function bodyLooksLikeSubtitle(text) {
    if (!text || text.length < 10) return false;
    const head = text.slice(0, 1000);
    if (head.startsWith("WEBVTT")) return true;
    if (/<tt[\s>]/i.test(head)) return true;
    if (/<ttml/i.test(head)) return true;
    if (/<\?xml[^>]*>\s*<tt[\s>]/i.test(head)) return true;
    // YouTube formats
    if (/<\?xml[^>]*>\s*<transcript/i.test(head)) return true; // srv1 XML
    if (head.startsWith("<transcript")) return true;
    if (/^\s*\{\s*"(wireMagic|events)"/.test(head)) return true; // json3
    return false;
  }

  function forward(url, text, contentType) {
    try {
      window.postMessage(
        { source: TAG, url, text, contentType },
        location.origin
      );
    } catch (_) {
      try {
        window.postMessage({ source: TAG, url, text, contentType }, "*");
      } catch (_) {}
    }
  }

  // ---- fetch patch ----
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async function (...args) {
      const resp = await origFetch.apply(this, args);
      try {
        const url = urlString(args[0]);
        const ct = resp.headers.get("content-type") || "";
        if (urlLooksLikeSubtitle(url) || contentTypeLooksLikeSubtitle(ct)) {
          resp
            .clone()
            .text()
            .then((text) => {
              if (bodyLooksLikeSubtitle(text)) forward(url, text, ct);
            })
            .catch(() => {});
        }
      } catch (_) {}
      return resp;
    };
  }

  // ---- XMLHttpRequest patch ----
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__llmUrl = typeof url === "string" ? url : urlString(url);
    } catch (_) {}
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", function () {
      try {
        const url = this.__llmUrl || "";
        const ct = this.getResponseHeader("content-type") || "";
        if (!(urlLooksLikeSubtitle(url) || contentTypeLooksLikeSubtitle(ct))) return;
        let text = "";
        try {
          text = this.responseType === "" || this.responseType === "text"
            ? this.responseText
            : "";
        } catch (_) {}
        if (bodyLooksLikeSubtitle(text)) forward(url, text, ct);
      } catch (_) {}
    });
    return origSend.apply(this, arguments);
  };
})();
