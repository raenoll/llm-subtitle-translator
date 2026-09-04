// Content script: observes native subtitles on the page, sends them to the
// background service worker for translation, and overlays translated text.
//
// Detection strategy (in order):
//   1. Platform-specific selectors (fast, precise when they match).
//   2. Generic fallback: find <video>, then any descendant of its player
//      container whose text is rendered near the bottom of the video rect.
//      This survives Disney+ / Prime classname changes across regions.
//   3. Shadow DOM traversal is performed at every step.

(() => {
  if (window.__llmSubtitleTranslatorLoaded) return;
  window.__llmSubtitleTranslatorLoaded = true;

  const HOST = location.hostname;
  const DEBUG_PREFIX = "[subtitle-translator]";

  // Recent log lines, kept in memory so the extension's own settings page can
  // show them. Nobody should have to open DevTools to see what went wrong.
  const LOG_BUFFER_MAX = 300;
  const logBuffer = [];

  function record(level, args) {
    const msg = args
      .map((a) => {
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a);
        } catch (_) {
          return String(a);
        }
      })
      .join(" ");
    logBuffer.push({ t: Date.now(), level, msg });
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  }

  // NOTE: these call console.* through globalThis on purpose. Writing
  // `console.log(DEBUG_PREFIX, …)` here makes the body look exactly like the
  // call sites, and a bulk rewrite of those call sites then turns these into
  // infinite recursion.
  function info(...args) {
    record("info", args);
    globalThis.console.log(DEBUG_PREFIX, ...args);
  }
  function warn(...args) {
    record("warn", args);
    globalThis.console.warn(DEBUG_PREFIX, ...args);
  }
  function err(...args) {
    record("error", args);
    globalThis.console.error(DEBUG_PREFIX, ...args);
  }

  const PLATFORMS = [
    {
      match: /(^|\.)netflix\.com$/,
      name: "netflix",
      containerSelectors: [".player-timedtext"],
    },
    {
      match: /(^|\.)(disneyplus|hotstar|starplus)\.com$/,
      name: "disneyplus",
      containerSelectors: [
        ".dss-subtitle-renderer-wrapper",
        ".dss-subtitle-renderer-cue-window",
        ".dss-subtitle-renderer-cue-container",
        ".btm-media-client-subtitle-window",
        "[class*='subtitle-renderer']",
        "[class*='SubtitleRenderer']",
      ],
    },
    {
      match: /(^|\.)(primevideo|amazon)\.com$/,
      name: "prime",
      containerSelectors: [
        ".atvwebplayersdk-captions-overlay",
        "[class*='captions-overlay']",
        "[class*='atvwebplayersdk-captions']",
      ],
    },
    {
      match: /(^|\.)youtube\.com$/,
      name: "youtube",
      containerSelectors: [".ytp-caption-window-container"],
    },
    {
      match: /(^|\.)(hbomax|max)\.com$/,
      name: "max",
      containerSelectors: [
        "[data-testid='player-subtitles']",
        "[class*='subtitle']",
      ],
    },
    {
      match: /(^|\.)(appletv\.com|tv\.apple\.com)$/,
      name: "appletv",
      containerSelectors: [
        "[class*='subtitle']",
        "[class*='caption']",
      ],
    },
    {
      // TVer uses video.js for most programs; subtitles land in
      // .vjs-text-track-display. Some shows use forced in-video captions
      // (no DOM) — those won't be translatable.
      match: /(^|\.)tver\.jp$/,
      name: "tver",
      containerSelectors: [
        ".vjs-text-track-display",
        ".vjs-text-track-cue",
        ".vjs-text-track-cue-text",
      ],
    },
  ];

  const platform = PLATFORMS.find((p) => p.match.test(HOST)) || {
    name: "generic",
    containerSelectors: [],
  };

  // Only activate on actual player pages. Netflix browse pages autoplay small
  // billboard previews; translating those is noisy and wastes API calls.
  function isPlayerPage() {
    const path = location.pathname;
    switch (platform.name) {
      case "netflix":
        return /\/watch\/\d+/.test(path);
      case "disneyplus":
        // Disney+ / Hotstar / StarPlus player routes
        return /\/(video|play|movies\/[^/]+\/[^/]+)\//.test(path) ||
          /\/video\//.test(path);
      case "youtube":
        return path === "/watch" || path.startsWith("/embed/");
      case "prime":
        // Prime Video's full-screen player uses these paths; browse pages
        // may autoplay small trailer loops on detail, so we require detail
        // + a known player marker.
        return /\/(detail|gp\/video\/detail|video\/player)\//.test(path);
      case "max":
        return /\/(video\/watch|player)\//.test(path);
      case "appletv":
        return /\/(movie|show|episode|watch)\//.test(path);
      case "tver":
        return /\/(episodes|live|lives|series)\//.test(path);
      default:
        return true;
    }
  }

  // Unconditional load banner so the user can verify injection from devtools.
  // Bump this when shipping a fix so the user can confirm the new code landed.
  const BUILD = "2026-04-26.2-youtube-pretranslate";
  info(
    `content script loaded (build ${BUILD}) on ${HOST} ` +
      `(platform=${platform.name}, frame=${window.top === window ? "top" : "sub"})`
  );

  // Inject the MAIN-world subtitle capture script as early as possible so it
  // can patch fetch/XHR before the player issues subtitle requests.
  (function injectCaptureScript() {
    try {
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL("inject.js");
      s.async = false;
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      warn("failed to inject capture script:", e);
    }
  })();

  // -------------- state --------------
  let settings = null;
  let overlay = null;
  let currentOriginal = "";
  let currentTranslated = "";
  const cache = new Map();
  const history = [];
  const HISTORY_MAX = 12;
  const pending = new Map();
  let lastTranslationAt = 0;
  const MIN_INTERVAL_MS = 150;
  // A dropped message callback leaves the promise unsettled forever, so its
  // pending entry never clears and THAT LINE never translates again — a
  // guaranteed missing subtitle. Bound it.
  const TRANSLATE_TIMEOUT_MS = 25000;
  let lastLoggedText = null;
  let cueSetAt = 0;
  const STALE_CUE_MS = 10000; // force-clear if the same cue persists this long
  // How long the last rendered line stays up after its cue ends. Subtitle
  // files leave small gaps between consecutive lines, and the DOM poll only
  // samples every 200ms, so hiding the instant a cue ends makes the overlay
  // blink at every boundary — with a backdrop box behind it, that reads as
  // harsh flicker. The native renderer just swaps its text and looks
  // continuous; holding briefly reproduces that. Long enough to bridge a gap
  // plus one poll tick, short enough that a real pause still clears promptly.
  const CUE_HOLD_MS = 400;
  let hideTimer = null;

  // --- Pre-translation library (populated by inject.js via postMessage) ---
  // cueLibrary: unique key ("start|end|text") -> { start, end, text, translation, translating }
  const cueLibrary = new Map();
  let cueList = []; // sorted by start time
  let lastCueCaptureAt = 0;

  function log(...args) {
    // Always recorded for the in-extension panel; only echoed to the console
    // when the debug setting is on.
    record("debug", args);
    if (settings?.debug) globalThis.console.log(DEBUG_PREFIX, ...args);
  }

  // Coarse language detection by script range. CJK-only text (no hiragana /
  // katakana / hangul) is ambiguous because Japanese and Chinese share the
  // kanji range — short lines like "東京" or "殺人事件" can belong to either.
  // Strategy: remember the language the current session has been confidently
  // identified as (via kana, hangul, Cyrillic, Latin, or an xml:lang from a
  // captured subtitle file), and fall back to it for ambiguous lines.
  const TRADITIONAL_MARKERS = /[繁體國學愛們會個時這萬對發頭來說麼這個話請過點時當開關長無師寫聽車馬龍樓嗎見讀書現實內對應動進經濟經過機構參與飛錢麵]/;
  let sessionLanguage = null; // reset on navigation

  function setSessionLanguage(lang) {
    if (lang && sessionLanguage !== lang) {
      sessionLanguage = lang;
      info("session language:", lang);
    }
  }

  function detectLang(text) {
    if (!text) return "other";
    // Strong signals — these uniquely identify a language.
    if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) {
      setSessionLanguage("日本語");
      return "日本語";
    }
    if (/[\uAC00-\uD7AF]/.test(text)) {
      setSessionLanguage("한국어");
      return "한국어";
    }
    if (/[\u0400-\u04FF]/.test(text)) {
      setSessionLanguage("Русский");
      return "Русский";
    }
    if (/[\u0370-\u03FF]/.test(text)) {
      setSessionLanguage("Ελληνικά");
      return "Ελληνικά";
    }
    // CJK-only — ambiguous between Chinese and Japanese.
    if (/[\u4E00-\u9FFF]/.test(text)) {
      // If the session has already been firmly identified as Japanese /
      // Korean (via an earlier line or the subtitle file's xml:lang), trust
      // that over a naive Chinese classification.
      if (sessionLanguage === "日本語") return "日本語";
      if (sessionLanguage === "한국어") return "한국어";
      return TRADITIONAL_MARKERS.test(text) ? "繁體中文" : "简体中文";
    }
    if (/[A-Za-z]/.test(text)) {
      // Latin is ambiguous between English / Spanish / French / German etc.;
      // we only set session when no prior stronger signal exists.
      if (!sessionLanguage) setSessionLanguage("English");
      return "English";
    }
    return "other";
  }

  // Convert a BCP-47 / ISO code (en, ja, ko, zh-TW, zh-CN, ru, el, etc.) into
  // the display names used in our skip-list UI.
  function langCodeToDisplay(code) {
    if (!code) return null;
    const c = code.toLowerCase();
    if (c.startsWith("ja")) return "日本語";
    if (c.startsWith("ko")) return "한국어";
    if (c.startsWith("ru")) return "Русский";
    if (c.startsWith("el")) return "Ελληνικά";
    if (
      c.startsWith("zh-tw") ||
      c.startsWith("zh-hk") ||
      c.startsWith("zh-hant")
    )
      return "繁體中文";
    if (c.startsWith("zh")) return "简体中文";
    if (c.startsWith("en")) return "English";
    return null;
  }

  function shouldSkipTranslation(text) {
    const list = settings?.skipLanguages || [];
    if (!list.length) return false;
    return list.includes(detectLang(text));
  }

  // -------------- overlay --------------
  function fullscreenTarget() {
    // When the page is in fullscreen, the browser only paints the fullscreen
    // element and its descendants. An overlay attached to <html> becomes
    // invisible until fullscreen exits. Move it inside the fullscreen root.
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      null
    );
  }

  function ensureOverlay() {
    const target = fullscreenTarget() || document.documentElement;
    if (
      overlay &&
      overlay.isConnected &&
      overlay.parentElement === target
    ) {
      return overlay;
    }
    // Sweep any orphan (stacked-bug leftovers or overlays attached to the
    // wrong parent after a fullscreen transition).
    document
      .querySelectorAll("#llm-subtitle-overlay")
      .forEach((el) => el.remove());
    overlay = document.createElement("div");
    overlay.id = "llm-subtitle-overlay";
    overlay.className = "llm-subtitle-overlay";
    overlay.innerHTML = `
      <div class="llm-subtitle-translated"></div>
      <div class="llm-subtitle-original"></div>
    `;
    target.appendChild(overlay);
    return overlay;
  }

  // Re-home the overlay whenever fullscreen state changes.
  function onFullscreenChange() {
    if (!overlay) return;
    const target = fullscreenTarget() || document.documentElement;
    if (overlay.parentElement !== target) {
      target.appendChild(overlay);
    }
  }
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  document.addEventListener("mozfullscreenchange", onFullscreenChange);

  // Keep the overlay aligned with the actual <video> element. In fullscreen
  // the video fills the viewport, so viewport-based positioning happens to
  // line up; in windowed mode the video is only part of the page and the
  // overlay would otherwise stick to the page bottom.
  function positionOverlayToVideo() {
    if (!overlay) return;
    const videos = getVideos();
    const v =
      videos.find((x) => !x.paused && x.readyState >= 2) || videos[0];
    if (!v) return;
    const vr = v.getBoundingClientRect();
    if (vr.width < 100 || vr.height < 100) return;
    const centerX = vr.left + vr.width / 2;
    // Position the overlay near the bottom of the video, inset ~8% of its
    // height (matches the default 8vh look used in fullscreen).
    const bottomOffset =
      window.innerHeight - vr.bottom + Math.max(16, vr.height * 0.08);
    overlay.style.setProperty("left", `${centerX}px`, "important");
    overlay.style.setProperty("bottom", `${bottomOffset}px`, "important");
    overlay.style.setProperty(
      "max-width",
      `${Math.min(vr.width * 0.92, window.innerWidth * 0.92)}px`,
      "important"
    );
  }

  function hideOverlayNow(ov, tEl, oEl) {
    clearTimeout(hideTimer);
    hideTimer = null;
    if (ov) ov.style.display = "none";
    if (tEl) tEl.textContent = "";
    if (oEl) oEl.textContent = "";
  }

  function renderOverlay() {
    if (!settings?.enabled) {
      hideOverlayNow(overlay);
      hideNativeSubtitles(false);
      return;
    }
    // Per-cue mode decision:
    //   - Skip-language cue  → stand down: show the platform's native
    //     subtitle as-is, keep our overlay hidden (Method B).
    //   - Otherwise          → hide native, render via our overlay (Method A).
    const isSkipping =
      currentOriginal && shouldSkipTranslation(currentOriginal);
    if (isSkipping) {
      hideOverlayNow(overlay);
      hideNativeSubtitles(false);
      return;
    }
    const ov = ensureOverlay();
    const tEl = ov.querySelector(".llm-subtitle-translated");
    const oEl = ov.querySelector(".llm-subtitle-original");
    const hasText = currentOriginal || currentTranslated;
    if (!hasText) {
      // Hold the last frame instead of blanking immediately — see CUE_HOLD_MS.
      // Everything below would clear the rows, so return before it runs and
      // leave what is on screen exactly as it is.
      if (ov.style.display !== "none" && !hideTimer) {
        hideTimer = setTimeout(() => {
          hideTimer = null;
          // Only if nothing arrived while we waited.
          if (!currentOriginal && !currentTranslated) {
            hideOverlayNow(ov, tEl, oEl);
          }
        }, CUE_HOLD_MS);
      }
      hideNativeSubtitles(true);
      positionOverlayToVideo();
      return;
    }
    // A new line arrived: cancel the pending hide so the box never blinks
    // between two consecutive cues, it just swaps its text.
    clearTimeout(hideTimer);
    hideTimer = null;
    ov.style.display = "flex";
    tEl.textContent = currentTranslated || "";
    oEl.textContent = settings.showOriginal ? currentOriginal || "" : "";
    // Apply user-configurable font to the translated row. The original row
    // inherits the family but stays proportionally smaller.
    const fam = settings.fontFamily?.trim();
    const baseSize = Number(settings.fontSize) || 0;
    // Scale relative to the video's rendered height (reference: 1080p).
    // A user who sets 32px at 1080p gets ~64px on a 4K fullscreen and ~21px
    // on a 720p windowed player. Clamped so tiny thumbnails / absurdly large
    // video walls don't produce unreadable extremes.
    let scale = 1;
    const videos = getVideos();
    const v =
      videos.find((x) => !x.paused && x.readyState >= 2) || videos[0];
    if (v) {
      const h = v.getBoundingClientRect().height;
      if (h > 0) scale = Math.max(0.5, Math.min(3.0, h / 1080));
    }
    const sz = baseSize * scale;
    // Backdrop behind both rows. Driven through a custom property so
    // content.css owns the shape (radius / padding) and JS only sets alpha.
    const bgAlpha =
      settings.textBgEnabled === false
        ? 0
        : Math.max(0, Math.min(100, Number(settings.textBgOpacity ?? 35))) / 100;
    ov.style.setProperty("--llm-sub-bg", `rgba(0, 0, 0, ${bgAlpha})`);
    // The font family is always the user's own. Inheriting the site's family
    // is pointless for CJK output: a Western caption font carries no CJK
    // glyphs, so translated text falls through it to a default face anyway.
    // Only the size is worth inheriting — it already reflects the viewer's
    // caption-size preference and the player's own scaling.
    const famOut = fam || "";
    let sizeOut = sz;
    if (settings.fontSizeSource === "platform") {
      const nat = readNativeFont();
      if (nat) {
        // Already in rendered px, so it takes no further scaling.
        sizeOut = nat.fontSize;
      } else if (!missingNativeFontLogged) {
        missingNativeFontLogged = true;
        log(
          "fontSizeSource=platform, but no native cue could be measured yet — " +
            "falling back to the custom size. Is the platform's own subtitle " +
            "track switched on?"
        );
      }
    }
    // Weight: the original row sits one step lighter than the translation,
    // mirroring how the sizes relate.
    const weight = Math.max(100, Math.min(700, Number(settings.fontWeight) || 400));
    tEl.style.fontFamily = famOut;
    tEl.style.fontSize = sizeOut > 0 ? `${sizeOut}px` : "";
    tEl.style.fontWeight = String(weight);
    oEl.style.fontFamily = famOut;
    oEl.style.fontSize = sizeOut > 0 ? `${Math.round(sizeOut * 0.65)}px` : "";
    oEl.style.fontWeight = String(Math.max(100, weight - 100));
    // Hide an empty row outright. A row with no text still paints its padding
    // and backdrop, which shows up as a stray black sliver while a cue waits
    // for its translation to come back.
    tEl.style.display = currentTranslated ? "block" : "none";
    // When translation equals original (e.g., skip-translation language hit),
    // hide the original row so the same line isn't shown twice.
    const duplicated =
      currentTranslated && currentTranslated === currentOriginal;
    oEl.style.display =
      settings.showOriginal && currentOriginal && !duplicated
        ? "block"
        : "none";
    // Always hide the native subtitle while enabled — our overlay is the
    // single source of truth.
    hideNativeSubtitles(true);
    // Align overlay to the actual video element (not the page viewport).
    positionOverlayToVideo();
  }

  function hideNativeSubtitles(on) {
    const styleId = "llm-subtitle-hide-native";
    let el = document.getElementById(styleId);
    if (!on) {
      if (el) el.remove();
      return;
    }
    if (el) return;
    el = document.createElement("style");
    el.id = styleId;
    const selectors = platform.containerSelectors.filter(Boolean).join(", ");
    // Use opacity so the native subtitle's background box disappears too
    // (Disney+ renders an opaque black box behind its cues).
    el.textContent = selectors
      ? `${selectors} { opacity: 0 !important; }`
      : "";
    document.documentElement.appendChild(el);
  }

  // -------------- DOM helpers --------------
  function* walkAllElements(root) {
    // Walks regular DOM + open shadow roots.
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;
      if (node.nodeType === 1) {
        yield node;
        if (node.shadowRoot) stack.push(node.shadowRoot);
      }
      const children = node.children || node.childNodes;
      if (children) {
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      }
    }
  }

  function getVideos() {
    const vs = [];
    for (const el of walkAllElements(document)) {
      if (el.tagName === "VIDEO") vs.push(el);
    }
    return vs;
  }

  // An element counts as "in the video region" only if its rect sits inside
  // (or right next to) a playing <video> element's rect. This is the key
  // filter that rejects Disney+ settings menus, audio/subtitle panels, and
  // any other UI chrome that happens to have a "subtitle"-ish class name.
  function isInsideVideoRegion(el, videos) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    for (const v of videos) {
      const vr = v.getBoundingClientRect();
      if (vr.width < 200 || vr.height < 150) continue;
      // Horizontal overlap: element must be roughly within the video's width
      if (r.right < vr.left + 10 || r.left > vr.right - 10) continue;
      // Vertical: anywhere inside the video, with small tolerance
      if (r.bottom < vr.top + 10 || r.top > vr.bottom + 20) continue;
      // Must be reasonably centered (subtitles sit mid-width, not at edges)
      const center = (r.left + r.right) / 2;
      const vCenter = (vr.left + vr.right) / 2;
      if (Math.abs(center - vCenter) > vr.width * 0.45) continue;
      return true;
    }
    return false;
  }

  // The visible, innermost native cue containers currently painted over the
  // video. Both the text extractor and the native-font reader work off this
  // list, so it's memoized for a fraction of the 200ms poll interval: callers
  // within one tick share a single DOM walk instead of each doing their own.
  let cueElsCache = { at: 0, els: [] };
  const CUE_ELS_TTL_MS = 100;

  function nativeCueElements() {
    const now = Date.now();
    if (now - cueElsCache.at < CUE_ELS_TTL_MS) return cueElsCache.els;
    const els = collectNativeCueElements();
    cueElsCache = { at: now, els };
    return els;
  }

  function collectNativeCueElements() {
    if (!platform.containerSelectors.length) return [];
    const joined = platform.containerSelectors.join(", ");
    const all = [];
    try {
      document.querySelectorAll(joined).forEach((el) => all.push(el));
    } catch (_) {}
    for (const el of walkAllElements(document)) {
      if (el.shadowRoot) {
        try {
          el.shadowRoot.querySelectorAll(joined).forEach((x) => all.push(x));
        } catch (_) {}
      }
    }
    // Prefer innermost matches only (drop any element that contains another match).
    const leaves = all.filter((el) =>
      !all.some((other) => other !== el && el.contains(other))
    );
    // Keep only leaves that are visible AND painted over a <video> region.
    const videos = getVideos();
    const visible = leaves.filter((el) => {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (parseFloat(style.opacity || "1") === 0) {
        // Our own hideNativeSubtitles uses opacity:0 — still allow that
        // only if the user-agent has opacity:0 because WE set it.
        if (!document.getElementById("llm-subtitle-hide-native")) return false;
      }
      return isInsideVideoRegion(el, videos);
    });
    return visible;
  }

  function findByPlatformSelectors() {
    const seenText = new Set();
    const texts = [];
    for (const el of nativeCueElements()) {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!t) continue;
      if (seenText.has(t)) continue;
      seenText.add(t);
      texts.push(t);
    }
    return texts.join("\n").trim();
  }

  // -------------- native cue font --------------
  // What the platform is actually rendering its own subtitles at. Readable
  // even while we're hiding them, because hideNativeSubtitles() uses opacity
  // rather than display — the cues keep their layout and computed styles.
  //
  // Reading this instead of our own px setting means the overlay inherits the
  // platform's caption-size preference and its own player-size scaling for
  // free, so no 1080p-relative scaling is applied on top.
  let nativeFont = null; // last good read: { fontFamily, fontSize }
  let missingNativeFontLogged = false;

  // The platform sets the cue font on the innermost span, not the container
  // the selectors match, so descend to the deepest node holding real text.
  function deepestTextBearer(root) {
    let best = null;
    let bestDepth = -1;
    const stack = [[root, 0]];
    while (stack.length) {
      const [node, depth] = stack.pop();
      const hasDirectText = [...node.childNodes].some(
        (n) => n.nodeType === 3 && n.nodeValue.trim()
      );
      if (hasDirectText && depth > bestDepth) {
        best = node;
        bestDepth = depth;
      }
      for (const child of node.children || []) stack.push([child, depth + 1]);
    }
    return best;
  }

  function readNativeFont() {
    for (const container of nativeCueElements()) {
      const el = deepestTextBearer(container);
      if (!el) continue;
      const cs = getComputedStyle(el);
      const size = parseFloat(cs.fontSize || "0");
      if (!(size > 0)) continue;
      const next = { fontFamily: cs.fontFamily || "", fontSize: size };
      if (
        !nativeFont ||
        nativeFont.fontFamily !== next.fontFamily ||
        nativeFont.fontSize !== next.fontSize
      ) {
        log(`native font measured: ${next.fontFamily} @ ${next.fontSize}px`);
      }
      nativeFont = next;
      missingNativeFontLogged = false;
      return nativeFont;
    }
    // Between cues the container is empty and there is nothing to measure.
    // Reuse the last good read rather than snapping to the fallback mid-line.
    return nativeFont;
  }

  // Generic detection: find text rendered over a video element.
  // Heuristics used:
  //   - must be inside a descendant of a <video>'s player container,
  //   - bounding rect overlaps the lower 65% of the video,
  //   - large-ish font size (>14px) or centered horizontally,
  //   - not a control / button / link / slider.
  function findGenericSubtitle() {
    const videos = [];
    for (const el of walkAllElements(document)) {
      if (el.tagName === "VIDEO") videos.push(el);
    }
    if (!videos.length) return "";

    const lines = [];
    for (const video of videos) {
      const vr = video.getBoundingClientRect();
      if (vr.width < 200 || vr.height < 150) continue;

      // Find the player container — climb a few levels up.
      let container = video.parentElement;
      for (let i = 0; i < 6 && container?.parentElement; i++) {
        container = container.parentElement;
      }
      if (!container) continue;

      const candidates = [];
      for (const el of walkAllElements(container)) {
        if (!el.getBoundingClientRect) continue;
        if (el === video) continue;
        // Skip structural / interactive nodes
        const tag = el.tagName;
        if (!tag) continue;
        if (["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "VIDEO", "SVG", "PATH"].includes(tag)) continue;
        if (el.closest && el.closest("button, a, input, [role='button'], [role='slider'], [role='menuitem']"))
          continue;

        const text = (el.innerText || el.textContent || "").trim();
        if (!text || text.length > 400) continue;
        // Subtitle lines rarely have huge nested word counts; filter heavy container nodes
        if (el.children && el.children.length > 6) continue;

        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;

        // Must overlap video bottom region
        const bottomStart = vr.top + vr.height * 0.35;
        if (r.bottom < bottomStart) continue;
        if (r.top > vr.bottom + 10) continue;
        if (r.left > vr.right || r.right < vr.left) continue;
        // Must be ~centered or at least not hugging a corner
        const center = (r.left + r.right) / 2;
        const vCenter = (vr.left + vr.right) / 2;
        if (Math.abs(center - vCenter) > vr.width * 0.4) continue;

        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") continue;
        if (parseFloat(style.opacity || "1") < 0.1) continue;
        const fontSize = parseFloat(style.fontSize || "0");
        if (fontSize && fontSize < 13) continue;

        // Has *direct* text (not only descendants) OR is the innermost text-bearer
        const hasDirectText = [...el.childNodes].some(
          (n) => n.nodeType === 3 && n.nodeValue.trim()
        );
        if (!hasDirectText && el.children.length !== 0) continue;

        candidates.push({ el, text, fontSize, top: r.top });
      }

      if (!candidates.length) continue;

      // Prefer the largest font candidates (subtitles are typically large)
      candidates.sort((a, b) => b.fontSize - a.fontSize);
      const topSize = candidates[0].fontSize || 20;
      const chosen = candidates
        .filter((c) => c.fontSize >= topSize - 2)
        .sort((a, b) => a.top - b.top);

      const seenText = new Set();
      for (const c of chosen) {
        if (seenText.has(c.text)) continue;
        seenText.add(c.text);
        lines.push(c.text);
      }
    }

    // Dedup consecutive repeats
    const unique = [];
    for (const t of lines) if (unique[unique.length - 1] !== t) unique.push(t);
    return unique.join("\n").trim();
  }

  function extractSubtitle() {
    // Strict mode: only use the per-platform subtitle selectors. The generic
    // "scan anything near the video" fallback was catching UI chrome like
    // the Netflix "Skip Intro" button, title overlays, up-next countdowns,
    // etc. — anything inside the player container with visible text.
    return findByPlatformSelectors();
  }

  // -------------- translation --------------
  function normalize(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  // Identity key for "is this the same cue?" and for the translation cache.
  //
  // The same cue does NOT normalize the same way from the two sources: the
  // subtitle FILE keeps its line breaks (parseTTML turns <br/> into "\n"), while
  // the DOM gives no separator at all, because <br> contributes nothing to
  // textContent and the player renders both lines inside one container. So
  // "（語り）\nイカフライレモンを作り" collapses to "（語り） イカフライレモンを作り"
  // but the DOM yields "（語り）イカフライレモンを作り".
  //
  // With whitespace merely collapsed those never match, which silently defeats
  // BOTH mechanisms: the timeline path fails its DOM sanity check and falls back
  // to live translation, and the cache key differs so pre-translated cues are
  // never found. Dropping whitespace entirely makes the two sources agree.
  function compareKey(text) {
    return (text || "").replace(/\s+/g, "");
  }

  async function translateText(text) {
    const key = compareKey(text);
    if (!key) return "";
    if (cache.has(key)) return cache.get(key);
    if (pending.has(key)) return pending.get(key);

    // Send the whole cue as ONE translation unit. Splitting on '\n' and then
    // joining batch entries with '\n---\n' confused some models: they'd
    // translate only the first line and echo the rest of the source text,
    // which our parser's byLine-fallback then accepted as "translations".
    const lines = [text];
    const t0 = Date.now();
    const promise = new Promise((resolve) => {
      const n = Math.max(0, settings?.contextLines ?? 0);
      const historySlice = n > 0 ? history.slice(-n) : [];
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        err(`translation timed out after ${TRANSLATE_TIMEOUT_MS}ms:`,
          JSON.stringify(text)
        );
        finish("");
      }, TRANSLATE_TIMEOUT_MS);
      chrome.runtime.sendMessage(
        {
          type: "translate",
          lines,
          history: historySlice,
        },
        (resp) => {
          const dt = Date.now() - t0;
          if (chrome.runtime.lastError) {
            err(`translation runtime error after ${dt}ms:`,
              chrome.runtime.lastError.message
            );
            finish("");
            return;
          }
          if (!resp?.ok) {
            err(`translation failed after ${dt}ms:`,
              resp?.error
            );
            finish("");
            return;
          }
          const joined = resp.translations.join("\n");
          info(`translated in ${dt}ms:`,
            JSON.stringify(text),
            "→",
            JSON.stringify(joined)
          );
          cache.set(key, joined);
          if (cache.size > 500) {
            const firstKey = cache.keys().next().value;
            cache.delete(firstKey);
          }
          lines.forEach((src, i) => {
            const tr = resp.translations[i];
            if (src && tr) {
              history.push({ source: src, translation: tr });
              if (history.length > HISTORY_MAX) history.shift();
            }
          });
          finish(joined);
        }
      );
    });
    pending.set(key, promise);
    promise.finally(() => pending.delete(key));
    return promise;
  }

  async function handleCueChange(text) {
    // Safety: if the same cue has been on screen way longer than any real
    // subtitle, clear it. Disney+ occasionally leaves stale cue DOM around.
    if (
      text === currentOriginal &&
      currentOriginal &&
      cueSetAt &&
      Date.now() - cueSetAt > STALE_CUE_MS
    ) {
      currentOriginal = "";
      currentTranslated = "";
      lastLoggedText = null;
      cueSetAt = 0;
      renderOverlay();
      return;
    }
    if (text === currentOriginal) return;
    if (text && text !== lastLoggedText) {
      lastLoggedText = text;
      domServed++;
      info("detected cue:", text);
    } else if (!text && currentOriginal) {
      info("cue cleared");
      lastLoggedText = null;
    }
    currentOriginal = text;
    cueSetAt = text ? Date.now() : 0;
    if (!text) {
      currentTranslated = "";
      renderOverlay();
      return;
    }
    // Source language is in the user's skip list — no API call, renderOverlay
    // will stand down (Method B: let the native subtitle show through).
    if (shouldSkipTranslation(text)) {
      info(`skipped (${detectLang(text)} in skip list); showing native`
      );
      currentTranslated = text;
      renderOverlay();
      return;
    }
    currentTranslated = "";
    renderOverlay();

    const now = Date.now();
    if (now - lastTranslationAt < MIN_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS));
    }
    lastTranslationAt = Date.now();

    const captured = text;
    const translation = await translateText(text);
    // Strict sync: only show the translation if the cue is still on screen.
    // If it already ended, discard — resurrecting a finished cue would leave
    // stale text on top of the next line. The cache has been filled either
    // way, so the same text reappearing later shows instantly.
    if (captured === currentOriginal) {
      currentTranslated = translation;
      renderOverlay();
    }
  }

  // -------------- pre-translation via network interception --------------

  function parseTimeVTT(s) {
    const m = s.match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)/);
    if (!m) return NaN;
    return (
      (parseInt(m[1] || "0") * 3600) +
      parseInt(m[2]) * 60 +
      parseInt(m[3]) +
      parseInt(m[4]) / Math.pow(10, String(m[4]).length)
    );
  }

  function parseWebVTT(text) {
    const out = [];
    const blocks = text.replace(/\r\n/g, "\n").split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.split("\n").filter(Boolean);
      const tli = lines.findIndex((l) => /-->/.test(l));
      if (tli === -1) continue;
      const m = lines[tli].match(/(\S+)\s*-->\s*(\S+)/);
      if (!m) continue;
      const start = parseTimeVTT(m[1]);
      const end = parseTimeVTT(m[2]);
      if (!isFinite(start) || !isFinite(end)) continue;
      // Strip cue tags, then decode the five escapes WebVTT actually defines
      // (plus the bidi marks) — otherwise "&amp;" reaches the overlay verbatim
      // and gets sent to the model as noise. TTML and json3 arrive already
      // decoded via DOMParser / JSON.parse.
      const content = lines
        .slice(tli + 1)
        .join("\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ")
        .replace(/&[lr]rm;/g, "")
        .replace(/&amp;/g, "&")
        .trim();
      if (content) out.push({ start, end, text: content });
    }
    return out;
  }

  function parseTTMLTime(s) {
    if (!s) return NaN;
    const hms = s.match(/^(\d+):(\d+):(\d+)(?:\.(\d+))?$/);
    if (hms) {
      return (
        parseInt(hms[1]) * 3600 +
        parseInt(hms[2]) * 60 +
        parseInt(hms[3]) +
        (hms[4] ? parseInt(hms[4]) / Math.pow(10, hms[4].length) : 0)
      );
    }
    const sec = s.match(/^([\d.]+)s$/);
    if (sec) return parseFloat(sec[1]);
    const n = parseFloat(s);
    return isNaN(n) ? NaN : n;
  }

  function parseTTML(text) {
    const out = [];
    let doc;
    try {
      doc = new DOMParser().parseFromString(text, "text/xml");
    } catch (_) {
      return out;
    }
    const ps = doc.getElementsByTagName("p");
    for (const p of ps) {
      const begin = p.getAttribute("begin") || p.getAttribute("b");
      const end = p.getAttribute("end") || p.getAttribute("e");
      const start = parseTTMLTime(begin);
      const stop = parseTTMLTime(end);
      if (!isFinite(start) || !isFinite(stop)) continue;
      // Preserve line breaks from <br/>
      const clone = p.cloneNode(true);
      clone.querySelectorAll && clone.querySelectorAll("br").forEach((br) => {
        br.replaceWith("\n");
      });
      const content = (clone.textContent || "").trim();
      if (content) out.push({ start, end: stop, text: content });
    }
    return out;
  }

  // YouTube srv1 XML: <transcript><text start="..." dur="...">...</text></transcript>
  function parseYouTubeXML(text) {
    const out = [];
    let doc;
    try {
      doc = new DOMParser().parseFromString(text, "text/xml");
    } catch (_) {
      return out;
    }
    const els = doc.getElementsByTagName("text");
    for (const el of els) {
      const start = parseFloat(el.getAttribute("start") || "");
      const dur = parseFloat(el.getAttribute("dur") || "0");
      if (!isFinite(start)) continue;
      const txt = (el.textContent || "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
      if (txt) out.push({ start, end: start + (dur || 2), text: txt });
    }
    return out;
  }

  // YouTube json3: { events: [{ tStartMs, dDurationMs, segs: [{utf8}] }, ...] }
  function parseYouTubeJSON3(text) {
    const out = [];
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return out;
    }
    const events = data?.events || [];
    for (const ev of events) {
      const start = (ev.tStartMs || 0) / 1000;
      const dur = (ev.dDurationMs || 0) / 1000;
      const segs = ev.segs || [];
      const txt = segs
        .map((s) => s.utf8 || "")
        .join("")
        .trim();
      // YouTube emits timing-keyframe events with empty text — skip them.
      if (txt && dur > 0) out.push({ start, end: start + dur, text: txt });
    }
    return out;
  }

  function ingestParsedCues(cues) {
    if (!cues.length) return 0;
    let added = 0;
    for (const c of cues) {
      const key = `${c.start.toFixed(3)}|${c.end.toFixed(3)}|${c.text.slice(0, 32)}`;
      if (cueLibrary.has(key)) continue;
      cueLibrary.set(key, {
        start: c.start,
        end: c.end,
        text: c.text,
        translation: null,
        translating: false,
      });
      added++;
    }
    if (added) {
      cueList = [...cueLibrary.values()].sort((a, b) => a.start - b.start);
      lastCueCaptureAt = Date.now();
      scheduleBatchTranslation();
    }
    return added;
  }

  let batchSchedulerRunning = false;
  async function scheduleBatchTranslation() {
    if (batchSchedulerRunning) return;
    batchSchedulerRunning = true;
    try {
      // Keep draining while new cues keep being captured.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // Don't waste API calls on cues in the skip-translation list.
        // Mark them as "translated" with their source text so time-sync /
        // cache hits display them immediately.
        for (const c of cueList) {
          if (c.translation === null && shouldSkipTranslation(c.text)) {
            c.translation = c.text;
            cache.set(compareKey(c.text), c.text);
          }
        }
        const pool = cueList.filter(
          (c) => c.translation === null && !c.translating
        );
        if (!pool.length) break;
        const videos = getVideos();
        const cur =
          videos.find((v) => !v.paused && v.readyState >= 2) || videos[0];
        // Same clock the timeline display uses, so "nearest upcoming cue"
        // really is the one about to be shown.
        const now = (cur ? cur.currentTime : 0) - timelineOffset;
        pool.sort((a, b) => {
          const da = a.start >= now ? a.start - now : now - a.start + 1e6;
          const db = b.start >= now ? b.start - now : now - b.start + 1e6;
          return da - db;
        });
        // Each request measures 2–5s against this provider, so 3 workers only
        // just keep ahead of playback and any stall puts the playhead in front
        // of the translated window.
        const MAX_CONCURRENT = 5;
        // One cue per API call — no delimiter, no parser ambiguity. With
        // 3 concurrent workers this still burns through the queue quickly.
        const BATCH_SIZE = 1;
        const workers = [];
        let idx = 0;
        for (let w = 0; w < MAX_CONCURRENT; w++) {
          workers.push(
            (async () => {
              while (idx < pool.length) {
                const myIdx = idx;
                idx += BATCH_SIZE;
                const batch = pool.slice(myIdx, myIdx + BATCH_SIZE);
                if (!batch.length) break;
                batch.forEach((c) => (c.translating = true));
                const lines = batch.map((c) => c.text);
                const t0 = Date.now();
                const translations = await new Promise((resolve) => {
                  chrome.runtime.sendMessage(
                    { type: "translate", lines, history: [] },
                    (resp) => {
                      if (resp?.ok) resolve(resp.translations);
                      else {
                        err("batch translation failed:",
                          resp?.error
                        );
                        resolve(lines.map(() => ""));
                      }
                    }
                  );
                });
                const dt = Date.now() - t0;
                let filled = 0;
                batch.forEach((c, i) => {
                  const tr = translations[i] || "";
                  c.translating = false;
                  if (tr) {
                    c.translation = tr;
                    cache.set(compareKey(c.text), tr);
                    filled++;
                  } else {
                    // Leave as null so the next scheduler pass retries.
                    c.translation = null;
                  }
                });
                info(`batch translated ${filled}/${batch.length} cues in ${dt}ms`
                );
              }
            })()
          );
        }
        await Promise.all(workers);
      }
    } finally {
      batchSchedulerRunning = false;
    }
  }

  // Listen for subtitle captures from the injected MAIN-world script.
  // Validate origin and source to reject messages from page scripts trying
  // to spoof subtitle segments.
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    if (e.origin && e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.source !== "__llm-subtitle-capture") return;
    if (typeof d.text !== "string") return;
    const text = String(d.text || "");
    let cues = [];
    if (text.startsWith("WEBVTT")) cues = parseWebVTT(text);
    else if (/<tt[\s>]/i.test(text)) {
      cues = parseTTML(text);
      // TTML carries the source language in xml:lang — use it as an
      // authoritative hint so kanji-only Japanese lines aren't mis-classified
      // as Chinese later on.
      const langMatch =
        text.match(/xml:lang="([^"]+)"/i) || text.match(/\slang="([^"]+)"/i);
      const display = langMatch ? langCodeToDisplay(langMatch[1]) : null;
      if (display) setSessionLanguage(display);
    } else if (/^\s*\{\s*"(wireMagic|events)"/.test(text)) {
      cues = parseYouTubeJSON3(text);
    } else if (/<transcript/i.test(text.slice(0, 200))) {
      cues = parseYouTubeXML(text);
    }
    // YouTube embeds the source language in the timedtext URL (`&lang=ja` etc.)
    if (!sessionLanguage && d.url) {
      const m = d.url.match(/[?&]lang=([a-zA-Z-]+)/);
      const display = m ? langCodeToDisplay(m[1]) : null;
      if (display) setSessionLanguage(display);
    }
    if (cues.length) {
      const added = ingestParsedCues(cues);
      const sample = cues[0];
      info(`captured subtitle segment (${cues.length} cues, ${added} new) ` +
          `first cue: ${sample.start.toFixed(2)}s–${sample.end.toFixed(2)}s "${sample.text.slice(0, 40)}" ` +
          `from ${d.url?.slice(0, 80)}`
      );
    }
  });

  // Time-based display: prefer pre-translated cues over DOM extraction when
  // available. Returns true if a cue was shown (and the DOM polling should
  // skip this tick).
  // video.currentTime and the subtitle file's timestamps do not always share an
  // origin (segment-relative times, presentationTimeOffset). When they differ,
  // EVERY timeline lookup misses and playback falls back to translating each
  // line live — which can never be on time. Measure the delta from lines we can
  // actually see on screen, then apply it so the library drives the display.
  let timelineOffset = 0;
  let offsetLocked = false;
  let offsetSamples = [];

  function resetTimelineCalibration() {
    timelineOffset = 0;
    offsetLocked = false;
    offsetSamples = [];
  }

  function calibrateTimeline(domText) {
    if (offsetLocked || !domText || !cueList.length) return;
    const videos = getVideos();
    const video = videos.find((v) => !v.paused && v.readyState >= 2) || videos[0];
    if (!video || !isFinite(video.currentTime)) return;
    const key = compareKey(domText);
    // Only calibrate off a line that appears exactly once, so the sample is
    // unambiguous.
    const hits = cueList.filter((c) => compareKey(c.text) === key);
    if (hits.length !== 1) return;
    const delta = video.currentTime - hits[0].start;
    if (!isFinite(delta) || Math.abs(delta) > 3600) return;
    offsetSamples.push(delta);
    if (offsetSamples.length < 3) return;
    const recent = offsetSamples.slice(-3);
    const spread = Math.max(...recent) - Math.min(...recent);
    if (spread > 1.0) {
      // Samples disagree — keep only the newest and wait for a steadier read.
      offsetSamples = recent.slice(-1);
      return;
    }
    timelineOffset = recent.slice().sort((a, b) => a - b)[1];
    offsetLocked = true;
    info(`timeline calibrated: cue times are offset by ${timelineOffset.toFixed(2)}s ` +
        `from video.currentTime — pre-translated cues can now drive the display`
    );
  }

  // How each displayed line was served. If domServed keeps climbing, the
  // pre-translation path is not doing its job and lines will run late.
  let timelineServed = 0;
  let domServed = 0;

  function tickTimeSyncDisplay() {
    if (!cueList.length) return false;
    const videos = getVideos();
    if (!videos.length) return false;
    const video = videos.find((v) => !v.paused && v.readyState >= 2) || videos[0];
    if (!isFinite(video.currentTime)) return false;
    const t = video.currentTime - timelineOffset;
    // Linear scan is fine (< a few hundred cues per segment window).
    // Pick the latest cue whose range contains t.
    let match = null;
    for (const c of cueList) {
      if (c.start <= t && t <= c.end) {
        match = c;
      } else if (c.start > t) {
        break;
      }
    }
    if (!match) {
      // Don't block the DOM fallback — cue times may be segment-relative
      // (not aligned to video.currentTime). Let DOM extraction handle it.
      return false;
    }
    // If we don't yet have a translation for this cue, check the main cache
    // (populated by scheduleBatchTranslation). If still absent, let DOM
    // fallback handle it so we don't race with the batch translator.
    // Treat empty string same as null — a previous batch may have recorded
    // a failure, and we want to retry / fall back rather than display blank.
    if (!match.translation) {
      const cached = cache.get(compareKey(match.text));
      if (cached) match.translation = cached;
      else return false; // fall through to DOM
    }
    // Sanity check against DOM: if the page is currently rendering a
    // different subtitle than what the timeline says, trust the DOM. This
    // guards against presentationTimeOffset mismatches (video.currentTime
    // and TTML cue times can be off by many seconds on some titles).
    const domText = extractSubtitle();
    if (domText && compareKey(domText) !== compareKey(match.text)) {
      return false;
    }
    if (match.text !== currentOriginal) {
      timelineServed++;
      info("sync cue:", match.text);
      lastLoggedText = match.text;
      currentOriginal = match.text;
      cueSetAt = Date.now();
    }
    const translated = match.translation || "";
    if (translated !== currentTranslated) {
      currentTranslated = translated;
    }
    renderOverlay();
    return true;
  }

  // -------------- observer --------------
  let pollTimer = null;
  let diagTimer = null;
  let retryTimer = null;

  function diagnostic() {
    const videos = [];
    for (const el of walkAllElements(document)) {
      if (el.tagName === "VIDEO") videos.push(el);
    }
    const platformMatches = [];
    for (const sel of platform.containerSelectors) {
      try {
        const n = document.querySelectorAll(sel).length;
        if (n > 0) platformMatches.push(`${sel} (${n})`);
      } catch (_) {}
    }
    const playingVideos = videos.filter((v) => !v.paused && v.readyState >= 2);
    const translatedCount = cueList.filter((c) => c.translation !== null).length;
    info(`diag: videos=${videos.length} playing=${playingVideos.length} ` +
        `platformMatches=[${platformMatches.join("; ") || "none"}] ` +
        `capturedCues=${cueList.length} preTranslated=${translatedCount} ` +
        `servedByTimeline=${timelineServed} servedLive=${domServed} ` +
        `timelineOffset=${offsetLocked ? timelineOffset.toFixed(2) + "s" : "未校准"} ` +
        `lastCapture=${lastCueCaptureAt ? `${Math.round((Date.now() - lastCueCaptureAt) / 1000)}s ago` : "never"} ` +
        `lastCue=${JSON.stringify(currentOriginal || "")}`
    );
  }

  function startObserving() {
    stopObserving();
    const check = () => {
      // DOM is authoritative for what's on screen right now; cueLibrary only
      // pre-warms the text cache in the background.
      const text = extractSubtitle();
      // Sample the platform's font every tick. renderOverlay() runs only when
      // a cue or a setting changes, so sampling only from there means a single
      // unmeasurable moment (empty container, player re-creating its nodes)
      // leaves us silently on the fallback font until the next cue change.
      // nativeCueElements() is memoized, so this shares the DOM walk that
      // extractSubtitle() just did and costs nothing extra.
      if (settings?.fontSizeSource === "platform") readNativeFont();
      // Learn the offset between the file's timestamps and video.currentTime
      // from lines we can see, so the timeline path stops missing.
      calibrateTimeline(text);
      handleCueChange(text);
      // Re-align each tick so overlay follows the video through page scroll,
      // window resize, and windowed-player drags.
      positionOverlayToVideo();
    };
    // Poll-based detection is more reliable than MutationObserver for
    // shadow DOM / React-rebuilt nodes that many players use.
    pollTimer = setInterval(check, 200);
    check();
    info("observer started; platform =", platform.name);
    // One diagnostic dump every 3 seconds for the first 15 seconds so the
    // user can see whether we find videos / platform containers at all.
    let dumps = 0;
    diagTimer = setInterval(() => {
      diagnostic();
      if (++dumps >= 5) {
        clearInterval(diagTimer);
        diagTimer = null;
      }
    }, 3000);
    // Periodically retry untranslated cues. This recovers from transient
    // provider errors (Gemini 503 / 429) that left some slots as null.
    retryTimer = setInterval(() => {
      if (cueList.some((c) => c.translation === null && !c.translating)) {
        scheduleBatchTranslation();
      }
    }, 5000);
  }

  function stopObserving() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (diagTimer) clearInterval(diagTimer);
    diagTimer = null;
    if (retryTimer) clearInterval(retryTimer);
    retryTimer = null;
    currentOriginal = "";
    currentTranslated = "";
    lastLoggedText = null;
    renderOverlay();
  }

  // -------------- lifecycle --------------
  async function loadSettings() {
    settings = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "getSettings" }, (s) => resolve(s || {}));
    });
  }

  async function applySettings() {
    await loadSettings();
    const active = !!settings?.enabled && isPlayerPage();
    hideNativeSubtitles(active);
    if (active) startObserving();
    else stopObserving();
    renderOverlay();
  }

  // The settings page reads the log and the timing stats from here, so the
  // whole diagnosis is available without opening DevTools.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "getLogs") return false;
    if (!getVideos().length && !cueList.length) return false; // let the player's frame answer
    const translated = cueList.filter((c) => c.translation !== null).length;
    sendResponse({
      host: location.hostname,
      platform: platform.name,
      playerPage: isPlayerPage(),
      enabled: !!settings?.enabled,
      targetLanguage: settings?.targetLanguage || "",
      skipLanguages: settings?.skipLanguages || [],
      sessionLanguage,
      capturedCues: cueList.length,
      preTranslated: translated,
      servedByTimeline: timelineServed,
      servedLive: domServed,
      timelineOffset: offsetLocked ? timelineOffset : null,
      currentOriginal: (currentOriginal || "").slice(0, 60),
      currentTranslated: (currentTranslated || "").slice(0, 60),
      logs: logBuffer.slice(-200),
    });
    return false;
  });

  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== "sync") return;
    applySettings();
  });

  // The options page asks what the player is rendering right now, so it can
  // show the live font regardless of which font mode is selected.
  //
  // Content scripts run in every frame (all_frames), and Chrome keeps only
  // the first response. Frames with no player have nothing useful to say, so
  // they stay silent and let the frame that actually holds the video answer.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "getNativeFont") return false;
    const cueEls = nativeCueElements();
    if (!cueEls.length && !getVideos().length) return false;
    const font = readNativeFont();
    sendResponse({
      host: location.hostname,
      platform: platform.name,
      // Whether a cue is on screen this instant, or we're reporting the last
      // good read from between lines.
      live: cueEls.length > 0 && !!font,
      fontFamily: font?.fontFamily || "",
      fontSize: font?.fontSize || 0,
    });
    return false;
  });

  // Which VIDEO the URL refers to — deliberately not the whole href. Players
  // rewrite their URL during playback (Amazon appends /ref=… as a path segment,
  // plus autoplay and resume-position params). Treating that as a new video
  // wipes the pre-translated cue library, and the subtitle file is NOT fetched
  // again because the player already holds it — so the library stays empty for
  // the rest of the episode and every line degrades to slow live translation.
  const TITLE_ID_PARAMS = ["v", "gti", "asin", "titleId", "contentId", "episodeId"];

  function videoIdentity() {
    let search = "";
    try {
      const params = new URLSearchParams(location.search);
      search = TITLE_ID_PARAMS.map((k) => params.get(k)).filter(Boolean).join(",");
    } catch (_) {}
    const path = location.pathname.replace(/\/ref=[^/]*/gi, "").replace(/\/+$/, "");
    return `${path}${search ? `?${search}` : ""}`;
  }

  let lastVideoId = videoIdentity();
  setInterval(() => {
    const id = videoIdentity();
    if (id !== lastVideoId) {
      lastVideoId = id;
      resetTimelineCalibration();
      currentOriginal = "";
      currentTranslated = "";
      lastLoggedText = null;
      cueLibrary.clear();
      cueList = [];
      lastCueCaptureAt = 0;
      sessionLanguage = null; // new video may be a different language
      info(`new video detected (${id}); cue library cleared, re-evaluating`
      );
      // Re-decide whether this URL is a player page; Netflix browse → /watch/
      // and back should toggle the observer on/off accordingly.
      applySettings();
    }
  }, 1000);

  applySettings();
})();
