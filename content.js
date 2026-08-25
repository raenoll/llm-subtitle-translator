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
  console.log(
    `${DEBUG_PREFIX} content script loaded (build ${BUILD}) on ${HOST} ` +
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
      console.warn(DEBUG_PREFIX, "failed to inject capture script:", e);
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
  // Most recent reply that came back still in the source language, surfaced
  // by the diagnostics panel.
  let lastUntranslated = null;
  // Subtitle-shaped requests the page made, recorded by inject.js. Lets the
  // diagnostics panel show WHY nothing was captured instead of guessing.
  const captureCandidates = [];
  // How often a translation arrived too late to be shown, and how many lines
  // the model failed to translate — the two ways a line ends up blank.
  let droppedLate = 0;
  let droppedUntranslated = 0;
  // Safety net for the message round trip. The service worker bounds its own
  // network calls, but if it is torn down mid-flight the callback can simply
  // never fire. An unsettled promise never runs its .finally(), so the pending
  // entry for that cue would wedge and the line would stay silent forever.
  const TRANSLATE_TIMEOUT_MS = 25000;
  let lastLoggedText = null;
  let cueSetAt = 0;
  const STALE_CUE_MS = 10000; // force-clear if the same cue persists this long

  // --- Pre-translation library (populated by inject.js via postMessage) ---
  // cueLibrary: unique key ("start|end|text") -> { start, end, text, translation, translating }
  const cueLibrary = new Map();
  let cueList = []; // sorted by start time
  let lastCueCaptureAt = 0;

  function log(...args) {
    if (settings?.debug) console.log(DEBUG_PREFIX, ...args);
  }

  // Coarse language detection by script range. CJK-only text (no hiragana /
  // katakana / hangul) is ambiguous because Japanese and Chinese share the
  // kanji range — short lines like "東京" or "殺人事件" can belong to either.
  // Strategy: remember the language the current session has been confidently
  // identified as (via kana, hangul, Cyrillic, Latin, or an xml:lang from a
  // captured subtitle file), and fall back to it for ambiguous lines.
  const TRADITIONAL_MARKERS = /[繁體國學愛們會個時這萬對發頭來說麼這個話請過點時當開關長無師寫聽車馬龍樓嗎見讀書現實內對應動進經濟經過機構參與飛錢麵]/;
  let sessionLanguage = null; // reset on navigation
  // Kanji-only lines ("大丈夫", "準備完了") are genuinely ambiguous between
  // Chinese and Japanese. Distinct such lines seen so far this session; once
  // enough have gone by with no kana anywhere, the track really is Chinese.
  const cjkAmbiguousSeen = new Set();
  const CJK_SETTLE_LINES = 6;
  // Cues whose "translation" is just their own text, because they were judged
  // to be in a skip-list language. That judgement can be overturned later — a
  // single kana line proves a kanji-only track is Japanese, not Chinese — so
  // it has to be undoable. Left permanent, those cues render raw source
  // forever, long after detection has corrected itself.
  const skipMarkedKeys = new Set();
  // Whole-track evidence beats any single line: if ANY captured cue contains
  // kana, the track is Japanese, so a kanji-only line in it is Japanese too.
  let kanaEvidence = { at: -1, value: false };
  // Deliberately not a plausible skip-list entry: an unsettled CJK line must
  // never match the skip list.
  const CJK_UNDECIDED = "CJK（待定）";

  function setSessionLanguage(lang) {
    if (lang && sessionLanguage !== lang) {
      const previous = sessionLanguage;
      sessionLanguage = lang;
      console.log(DEBUG_PREFIX, "session language:", lang);
      // Anything skipped under the old guess has to be re-judged.
      if (previous) revokeSkipMarks();
    }
  }

  function revokeSkipMarks() {
    if (!skipMarkedKeys.size) return;
    let undone = 0;
    for (const c of cueLibrary.values()) {
      if (skipMarkedKeys.has(normalize(c.text)) && c.translation === c.text) {
        c.translation = null;
        undone++;
      }
    }
    for (const key of skipMarkedKeys) cache.delete(key);
    skipMarkedKeys.clear();
    log(
      `session language changed — re-queued ${undone} cue(s) previously ` +
        `skipped under the old guess`
    );
    if (undone) scheduleBatchTranslation();
  }

  function trackHasKana() {
    if (kanaEvidence.at === lastCueCaptureAt) return kanaEvidence.value;
    let found = false;
    for (const c of cueLibrary.values()) {
      if (/[\u3040-\u309F\u30A0-\u30FF]/.test(c.text)) {
        found = true;
        break;
      }
    }
    kanaEvidence = { at: lastCueCaptureAt, value: found };
    return found;
  }

  function detectLang(text) {
    if (!text) return "other";
    const count = (re) => (text.match(re) || []).length;
    const kana = count(/[\u3040-\u309F\u30A0-\u30FF]/g);
    const hangul = count(/[\uAC00-\uD7AF]/g);
    const cyrillic = count(/[\u0400-\u04FF]/g);
    const greek = count(/[\u0370-\u03FF]/g);
    const cjk = count(/[\u4E00-\u9FFF]/g);
    const latin = count(/[A-Za-z]/g);
    // Compare each script against HALF the Latin count, not against its mere
    // presence. One ideograph carries roughly as much text as two Latin
    // letters, and — crucially — a lone Chinese name or on-screen sign inside
    // an English line must not reclassify the whole line. Getting that wrong
    // sends the cue down the skip-translation path, which stands the overlay
    // down and flashes the untranslated native subtitle.
    const latinWeight = latin / 2;
    if (kana > 0 && kana >= latinWeight) {
      setSessionLanguage("日本語");
      return "日本語";
    }
    if (hangul > 0 && hangul >= latinWeight) {
      setSessionLanguage("한국어");
      return "한국어";
    }
    if (cyrillic > 0 && cyrillic >= latinWeight) {
      setSessionLanguage("Русский");
      return "Русский";
    }
    if (greek > 0 && greek >= latinWeight) {
      setSessionLanguage("Ελληνικά");
      return "Ελληνικά";
    }
    // CJK-dominant — ambiguous between Chinese and Japanese.
    if (cjk > 0 && cjk >= latinWeight) {
      // If the session has already been firmly identified (via an earlier
      // line's kana / hangul, or the subtitle file's xml:lang), trust that
      // over a naive per-line classification.
      if (sessionLanguage === "日本語") return "日本語";
      if (sessionLanguage === "한국어") return "한국어";
      // A kanji-only line inside a track that contains kana anywhere is
      // Japanese. This is far stronger than counting lines, and it is exactly
      // the case that was mislabelling Japanese subtitles as Chinese.
      if (trackHasKana()) {
        setSessionLanguage("日本語");
        return "日本語";
      }
      const zh = TRADITIONAL_MARKERS.test(text) ? "繁體中文" : "简体中文";
      if (sessionLanguage === "简体中文" || sessionLanguage === "繁體中文") {
        return zh;
      }
      // Nothing has settled the track's language yet. Guessing "Chinese" here
      // is the expensive mistake: Chinese is in the default skip list, so the
      // cue takes the stand-down path and the raw untranslated source line is
      // shown. Guessing the other way costs one redundant API call. So stay
      // undecided — and therefore translate — until several distinct
      // kanji-only lines have gone by without a single kana appearing.
      cjkAmbiguousSeen.add(normalize(text));
      if (cjkAmbiguousSeen.size >= CJK_SETTLE_LINES) {
        setSessionLanguage(zh);
        return zh;
      }
      return CJK_UNDECIDED;
    }
    if (latin > 0) {
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

  // A model sometimes hands back text still in the source language — an exact
  // copy, or a near-copy with a character altered ("そうだ" → "そうか"). Byte
  // equality misses the near-copies, so check the SCRIPT instead: a Chinese
  // translation cannot legitimately contain kana or hangul.
  function translationLooksUntranslated(translation, target) {
    if (!translation) return false;
    const t = String(target || "");
    const kana = /[\u3040-\u309F\u30A0-\u30FF]/.test(translation);
    const hangul = /[\uAC00-\uD7AF]/.test(translation);
    const cjk = /[\u4E00-\u9FFF]/.test(translation);
    if (/中文|Chinese|^zh/i.test(t)) return kana || hangul;
    if (/English|英语|英文|^en/i.test(t)) return kana || hangul || cjk;
    if (/Русский|Russian|^ru/i.test(t)) return kana || hangul || cjk;
    // Targets that legitimately use these scripts, or ones we can't judge.
    return false;
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

  function renderOverlay() {
    if (!settings?.enabled) {
      if (overlay) overlay.style.display = "none";
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
      log(
        `standing down: cue detected as ${detectLang(currentOriginal)}, ` +
          `which is in the skip list — showing the native subtitle instead`
      );
      if (overlay) overlay.style.display = "none";
      hideNativeSubtitles(false);
      return;
    }
    const ov = ensureOverlay();
    const tEl = ov.querySelector(".llm-subtitle-translated");
    const oEl = ov.querySelector(".llm-subtitle-original");
    const hasText = currentOriginal || currentTranslated;
    ov.style.display = hasText ? "flex" : "none";
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
    if (duplicated) {
      log(
        "translation is identical to the source — our overlay is painting the " +
          "original text (this is NOT the native subtitle showing through)"
      );
    }
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

  // Roots we have planted the hide rule into, so it can be lifted again.
  const hideStyleRoots = new Set();

  function findHideStyle(root, styleId) {
    return root.getElementById
      ? root.getElementById(styleId)
      : root.querySelector?.(`#${styleId}`) || null;
  }

  function hideNativeSubtitles(on) {
    const styleId = "llm-subtitle-hide-native";
    if (!on) {
      let removed = 0;
      for (const root of hideStyleRoots) {
        const el = findHideStyle(root, styleId);
        if (el) {
          el.remove();
          removed++;
        }
      }
      hideStyleRoots.clear();
      if (removed) log("native subtitles UN-HIDDEN — raw source is now visible");
      return;
    }
    const selectors = platform.containerSelectors.filter(Boolean).join(", ");
    if (!selectors) return;
    // A <style> in the document cannot cross a shadow boundary. extractSubtitle
    // walks shadow roots to FIND cues, so a player that renders captions inside
    // one is detected but was never actually hidden — the raw source line stayed
    // fully visible. Plant the rule in every root that holds a cue as well.
    const roots = new Set([document]);
    for (const el of nativeCueElements()) {
      const root = el.getRootNode?.();
      if (root && root !== document && root.host) roots.add(root);
    }
    for (const root of roots) {
      if (findHideStyle(root, styleId)) {
        hideStyleRoots.add(root);
        continue;
      }
      const el = document.createElement("style");
      el.id = styleId;
      // Use opacity so the native subtitle's background box disappears too
      // (Disney+ renders an opaque black box behind its cues).
      el.textContent = `${selectors} { opacity: 0 !important; }`;
      (root === document ? document.documentElement : root).appendChild(el);
      hideStyleRoots.add(root);
      log(
        root === document
          ? "native subtitles hidden"
          : "native subtitles hidden (inside a shadow root)"
      );
    }
    // Verify the OUTCOME, not merely that the rule was injected. A <style>
    // that cannot reach the cue fails completely silently — that is exactly
    // how the shadow-DOM case went unnoticed for so long. Runs only on the
    // injection path, so it is not a per-tick cost.
    const stillVisible = nativeCueElements().filter(
      (el) => parseFloat(getComputedStyle(el).opacity || "1") > 0
    );
    if (stillVisible.length) {
      console.warn(
        DEBUG_PREFIX,
        `hide rule injected, but ${stillVisible.length} native cue element(s) ` +
          `are STILL VISIBLE — the raw source line will show through:`,
        stillVisible.map((el) => ({
          cls: el.className || el.tagName,
          opacity: getComputedStyle(el).opacity,
          inShadowRoot: el.getRootNode?.() !== document,
        }))
      );
    }
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

  // Our own overlay must never be read back as a native cue. Loose platform
  // selectors like [class*='subtitle'] (HBO Max, Apple TV+) match our
  // llm-subtitle-* classes, and picking our own translation back up creates a
  // feedback loop: the translated Chinese is detected as a skip-list language,
  // renderOverlay stands down, and the untranslated native line flashes up.
  function isOwnOverlay(el) {
    if (!el) return false;
    if (el.id === "llm-subtitle-overlay") return true;
    return typeof el.closest === "function"
      ? !!el.closest("#llm-subtitle-overlay")
      : false;
  }

  function collectNativeCueElements() {
    if (!platform.containerSelectors.length) return [];
    const joined = platform.containerSelectors.join(", ");
    const all = [];
    try {
      document.querySelectorAll(joined).forEach((el) => {
        if (!isOwnOverlay(el)) all.push(el);
      });
    } catch (_) {}
    for (const el of walkAllElements(document)) {
      if (el.shadowRoot) {
        try {
          el.shadowRoot.querySelectorAll(joined).forEach((x) => {
            if (!isOwnOverlay(x)) all.push(x);
          });
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

  async function translateText(text) {
    const key = normalize(text);
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
        console.error(
          DEBUG_PREFIX,
          `translation timed out after ${TRANSLATE_TIMEOUT_MS}ms:`,
          JSON.stringify(text),
          "— will retry when the line comes round again"
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
            console.error(
              DEBUG_PREFIX,
              `translation runtime error after ${dt}ms:`,
              chrome.runtime.lastError.message
            );
            finish("");
            return;
          }
          if (!resp?.ok) {
            console.error(
              DEBUG_PREFIX,
              `translation failed after ${dt}ms:`,
              resp?.error
            );
            finish("");
            return;
          }
          const joined = resp.translations.join("\n");
          console.log(
            DEBUG_PREFIX,
            `translated in ${dt}ms:`,
            JSON.stringify(text),
            "→",
            JSON.stringify(joined)
          );
          if (
            joined &&
            translationLooksUntranslated(joined, settings?.targetLanguage)
          ) {
            console.warn(
              DEBUG_PREFIX,
              `model did NOT translate — the reply is still in the source ` +
                `language, not ${settings?.targetLanguage}:`,
              JSON.stringify(text),
              "→",
              JSON.stringify(joined)
            );
            lastUntranslated = { source: text, reply: joined, at: Date.now() };
            droppedUntranslated++;
            // Do not cache it: caching would make this line permanently
            // untranslated. Returning empty lets it be retried instead of
            // painting the source text as if it were a translation.
            finish("");
            return;
          }
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
      console.log(DEBUG_PREFIX, "detected cue:", text);
    } else if (!text && currentOriginal) {
      console.log(DEBUG_PREFIX, "cue cleared");
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
      console.log(
        DEBUG_PREFIX,
        `skipped (${detectLang(text)} in skip list); showing native`
      );
      currentTranslated = text;
      renderOverlay();
      return;
    }
    currentTranslated = "";
    renderOverlay();

    // MIN_INTERVAL_MS paces calls to the translation API — so only pay it when
    // a call is actually going to happen. A cache or in-flight hit needs no
    // network at all, and in fast dialogue this delay alone can outlast the
    // cue: the line ends before the translation lands, the strict-sync check
    // below discards it, and that cue never shows a translation at all.
    const key = normalize(text);
    if (!cache.has(key) && !pending.has(key)) {
      const now = Date.now();
      if (now - lastTranslationAt < MIN_INTERVAL_MS) {
        await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS));
      }
      lastTranslationAt = Date.now();
    }

    const captured = text;
    const translation = await translateText(text);
    // Strict sync: only show the translation if the cue is still on screen.
    // If it already ended, discard — resurrecting a finished cue would leave
    // stale text on top of the next line. The cache has been filled either
    // way, so the same text reappearing later shows instantly.
    if (captured === currentOriginal) {
      currentTranslated = translation;
      renderOverlay();
    } else if (translation) {
      // The line ended before its translation came back. Showing it now would
      // paint the previous line's text over the current one, so it is dropped —
      // the cache keeps it, but this cue displays nothing at all.
      droppedLate++;
      log(
        `translation arrived too late, cue already gone (dropped ${droppedLate} so far):`,
        JSON.stringify(captured)
      );
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

  // `lang` is the language of the file these cues came from, when the file
  // said so. A title can carry several subtitle tracks and the player may
  // fetch more than the one the viewer picked, so cues have to stay
  // attributable to their track instead of all landing in one anonymous pool.
  // A cue belongs to the track being watched unless its file said otherwise.
  // Cues with no known language are always allowed — we cannot rule them out.
  function cueMatchesActiveTrack(c) {
    if (!c.lang || !sessionLanguage) return true;
    return c.lang === sessionLanguage;
  }

  function ingestParsedCues(cues, lang) {
    if (!cues.length) return 0;
    let added = 0;
    for (const c of cues) {
      const key = `${c.start.toFixed(3)}|${c.end.toFixed(3)}|${c.text.slice(0, 32)}`;
      if (cueLibrary.has(key)) continue;
      cueLibrary.set(key, {
        start: c.start,
        end: c.end,
        text: c.text,
        lang: lang || null,
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
          if (!cueMatchesActiveTrack(c)) continue;
          if (c.translation === null && shouldSkipTranslation(c.text)) {
            const k = normalize(c.text);
            c.translation = c.text;
            cache.set(k, c.text);
            skipMarkedKeys.add(k);
          }
        }
        const pool = cueList.filter(
          (c) =>
            c.translation === null &&
            !c.translating &&
            cueMatchesActiveTrack(c)
        );
        if (!pool.length) break;
        const videos = getVideos();
        const cur =
          videos.find((v) => !v.paused && v.readyState >= 2) || videos[0];
        const now = cur ? cur.currentTime : 0;
        pool.sort((a, b) => {
          const da = a.start >= now ? a.start - now : now - a.start + 1e6;
          const db = b.start >= now ? b.start - now : now - b.start + 1e6;
          return da - db;
        });
        const MAX_CONCURRENT = 3;
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
                  let settled = false;
                  const finish = (v) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    resolve(v);
                  };
                  // Same guarantee as translateText(): without it a dropped
                  // callback leaves c.translating stuck and the cue never
                  // returns to the pool.
                  const timer = setTimeout(() => {
                    console.error(
                      DEBUG_PREFIX,
                      `batch translation timed out after ${TRANSLATE_TIMEOUT_MS}ms`
                    );
                    finish(lines.map(() => ""));
                  }, TRANSLATE_TIMEOUT_MS);
                  chrome.runtime.sendMessage(
                    { type: "translate", lines, history: [] },
                    (resp) => {
                      if (resp?.ok) finish(resp.translations);
                      else {
                        console.error(
                          DEBUG_PREFIX,
                          "batch translation failed:",
                          resp?.error
                        );
                        finish(lines.map(() => ""));
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
                    cache.set(normalize(c.text), tr);
                    filled++;
                  } else {
                    // Leave as null so the next scheduler pass retries.
                    c.translation = null;
                  }
                });
                console.log(
                  DEBUG_PREFIX,
                  `batch translated ${filled}/${batch.length} cues in ${dt}ms`
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
    if (d?.source === "__llm-subtitle-candidate") {
      if (captureCandidates.length < 25) {
        captureCandidates.push({
          url: String(d.url || "").slice(0, 180),
          contentType: String(d.contentType || ""),
          passedUrlGate: !!d.narrowGate,
          bodyLookedLikeSubtitle: d.sniffed,
        });
      }
      return;
    }
    if (!d || d.source !== "__llm-subtitle-capture") return;
    if (typeof d.text !== "string") return;
    const text = String(d.text || "");
    let cues = [];
    let fileLang = null;
    if (text.startsWith("WEBVTT")) cues = parseWebVTT(text);
    else if (/<tt[\s>]/i.test(text)) {
      cues = parseTTML(text);
      // TTML carries its language in xml:lang. This describes THIS FILE only —
      // it must not be promoted to the session language, because the player
      // also fetches tracks the viewer did not select, and letting a
      // background prefetch redefine the session makes every later per-cue
      // decision (skip list, kanji disambiguation) wrong.
      const langMatch =
        text.match(/xml:lang="([^"]+)"/i) || text.match(/\slang="([^"]+)"/i);
      fileLang = langMatch ? langCodeToDisplay(langMatch[1]) : null;
    } else if (/^\s*\{\s*"(wireMagic|events)"/.test(text)) {
      cues = parseYouTubeJSON3(text);
    } else if (/<transcript/i.test(text.slice(0, 200))) {
      cues = parseYouTubeXML(text);
    }
    // Subtitle URLs often name the track's language (`&lang=ja`, `.ja.vtt`).
    if (!fileLang && d.url) {
      const m =
        d.url.match(/[?&]lang=([a-zA-Z-]+)/) ||
        d.url.match(/[._-]([a-z]{2}(?:-[A-Za-z]{2,4})?)\.(?:vtt|ttml|dfxp|srt)/i);
      fileLang = m ? langCodeToDisplay(m[1]) : null;
    }
    if (cues.length) {
      const added = ingestParsedCues(cues, fileLang);
      const sample = cues[0];
      console.log(
        DEBUG_PREFIX,
        `captured subtitle segment (${cues.length} cues, ${added} new) ` +
          `first cue: ${sample.start.toFixed(2)}s–${sample.end.toFixed(2)}s "${sample.text.slice(0, 40)}" ` +
          `from ${d.url?.slice(0, 80)}`
      );
    }
  });

  // Time-based display: prefer pre-translated cues over DOM extraction when
  // available. Returns true if a cue was shown (and the DOM polling should
  // skip this tick).
  function tickTimeSyncDisplay() {
    if (!cueList.length) return false;
    const videos = getVideos();
    if (!videos.length) return false;
    const video = videos.find((v) => !v.paused && v.readyState >= 2) || videos[0];
    if (!isFinite(video.currentTime)) return false;
    const t = video.currentTime;
    // Linear scan is fine (< a few hundred cues per segment window).
    // Pick the latest cue whose range contains t.
    let match = null;
    for (const c of cueList) {
      if (c.start <= t && t <= c.end) {
        // With two tracks in the library, the same timestamp matches a cue in
        // each. Only the watched track may be displayed.
        if (cueMatchesActiveTrack(c)) match = c;
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
      const cached = cache.get(normalize(match.text));
      if (cached) match.translation = cached;
      else return false; // fall through to DOM
    }
    // Sanity check against DOM: if the page is currently rendering a
    // different subtitle than what the timeline says, trust the DOM. This
    // guards against presentationTimeOffset mismatches (video.currentTime
    // and TTML cue times can be off by many seconds on some titles).
    const domText = extractSubtitle();
    if (domText && normalize(domText) !== normalize(match.text)) {
      return false;
    }
    if (match.text !== currentOriginal) {
      console.log(DEBUG_PREFIX, "sync cue:", match.text);
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
    console.log(
      DEBUG_PREFIX,
      `diag: videos=${videos.length} playing=${playingVideos.length} ` +
        `platformMatches=[${platformMatches.join("; ") || "none"}] ` +
        `capturedCues=${cueList.length} preTranslated=${translatedCount} ` +
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
      handleCueChange(text);
      // Re-assert the native-subtitle hide on every tick. renderOverlay() is
      // the only other place that sets it, and it runs just on cue/settings
      // changes — so anything that removes the style (a skip cue, an
      // applySettings() pass while the URL is momentarily not recognised as a
      // player page, the player rebuilding its subtitle DOM) leaves the raw
      // source line on screen until the NEXT cue arrives. That is exactly the
      // "one untranslated line, then back to normal" shape. Re-asserting here
      // bounds the exposure to a single 200ms tick.
      if (
        settings?.enabled &&
        !(currentOriginal && shouldSkipTranslation(currentOriginal))
      ) {
        hideNativeSubtitles(true);
      }
      // Re-align each tick so overlay follows the video through page scroll,
      // window resize, and windowed-player drags.
      positionOverlayToVideo();
    };
    // Poll-based detection is more reliable than MutationObserver for
    // shadow DOM / React-rebuilt nodes that many players use.
    pollTimer = setInterval(check, 200);
    check();
    console.log(DEBUG_PREFIX, "observer started; platform =", platform.name);
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
  // Full state snapshot for the options page's diagnostics panel, so the
  // common failure modes can be told apart without opening DevTools.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "getDiagnostics") return false;
    const videos = getVideos();
    if (!nativeCueElements().length && !videos.length) return false;
    const cues = nativeCueElements().map((el) => {
      const cs = getComputedStyle(el);
      const root = el.getRootNode?.();
      const inShadow = !!root && root !== document && !!root.host;
      return {
        cls: String(el.className || el.tagName).slice(0, 60),
        text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
        opacity: cs.opacity,
        inShadow,
        hideRuleInRoot: !!findHideStyle(inShadow ? root : document, "llm-subtitle-hide-native"),
      };
    });
    const ov = document.getElementById("llm-subtitle-overlay");
    sendResponse({
      host: location.hostname,
      platform: platform.name,
      playerPage: isPlayerPage(),
      sessionLanguage,
      trackHasKana: trackHasKana(),
      skipLanguages: settings?.skipLanguages || [],
      targetLanguage: settings?.targetLanguage || "",
      showOriginal: !!settings?.showOriginal,
      cueLibrarySize: cueLibrary.size,
      droppedLate,
      droppedUntranslated,
      captureCandidates,
      skipMarked: skipMarkedKeys.size,
      nativeCues: cues,
      overlay: ov
        ? {
            display: getComputedStyle(ov).display,
            translated: (ov.querySelector(".llm-subtitle-translated")?.textContent || "").slice(0, 40),
            original: (ov.querySelector(".llm-subtitle-original")?.textContent || "").slice(0, 40),
          }
        : null,
      currentOriginal: (currentOriginal || "").slice(0, 40),
      currentTranslated: (currentTranslated || "").slice(0, 40),
      duplicated: !!currentTranslated && currentTranslated === currentOriginal,
      provider: settings?.provider || "",
      model: settings?.models?.[settings?.provider] || "(默认)",
      translatedStillInSourceLanguage: translationLooksUntranslated(
        currentTranslated,
        settings?.targetLanguage
      ),
      lastUntranslatedReply: lastUntranslated
        ? {
            source: lastUntranslated.source.slice(0, 40),
            reply: lastUntranslated.reply.slice(0, 40),
            secondsAgo: Math.round((Date.now() - lastUntranslated.at) / 1000),
          }
        : null,
    });
    return false;
  });

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

  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      currentOriginal = "";
      currentTranslated = "";
      lastLoggedText = null;
      cueLibrary.clear();
      cueList = [];
      lastCueCaptureAt = 0;
      sessionLanguage = null; // new video may be a different language
      cjkAmbiguousSeen.clear();
      skipMarkedKeys.clear();
      kanaEvidence = { at: -1, value: false };
      console.log(
        DEBUG_PREFIX,
        `navigation detected (${location.pathname}); re-evaluating`
      );
      // Re-decide whether this URL is a player page; Netflix browse → /watch/
      // and back should toggle the observer on/off accordingly.
      applySettings();
    }
  }, 1000);

  applySettings();
})();
