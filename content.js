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

  // ---- Lines that could not be translated ---------------------------------
  // By compareKey: how many rounds a line has used and when the next may
  // start. Shared by the on-screen path and the pre-translator, so neither can
  // hammer the API over one stubborn line, and a refused line is retried later
  // instead of being cached as blank — or shown in the source language.
  const failures = new Map(); // key → { attempts, nextTryAt, reason }
  const MAX_ROUNDS = 3;
  const RETRY_DELAYS_MS = [4000, 30000]; // wait after round 1, after round 2
  let batchWakeTimer = null;
  // true while the line on screen is in a skip-list language. Decided once,
  // when the line appears: re-deciding on every render let the answer flip
  // mid-line as language evidence accumulated.
  let currentSkip = false;
  // Running totals for the diagnostics panel — who caused what.
  const stats = {
    instant: 0, // lines whose translation was ready when they appeared
    waited: 0, // lines that had to be translated while on screen
    echo: 0, // first reply was the source handed back
    wrongLanguage: 0, // first reply was in some other language
    empty: 0, // first reply was empty or blocked
    recovered: 0, // …and the second ask fixed it
    withheld: 0, // …and the second ask did not: the line was not shown
    gaveUp: 0, // lines abandoned after MAX_ROUNDS
    errors: 0, // transport failures and timeouts
    named: 0, // requests sent with fixed name renderings attached
    skipped: {}, // lines left to the native subtitle, by detected language
  };
  const REASON_TEXT = {
    echo: "returned the source line unchanged",
    "wrong-language": "answered in a different language",
    empty: "returned nothing",
  };
  // Everything goes through one cache now, including the pre-translator, and a
  // long episode has well over 500 lines — a cap that small would evict
  // pre-translated lines before they are ever shown.
  const CACHE_MAX = 5000;
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
  // Language of what is ON SCREEN. Display/diagnostics only — the skip decision
  // no longer reads it for Chinese vs Japanese (see detectLang).
  let sessionLanguage = null; // reset on navigation
  const KANA_RE = /[\u3040-\u309F\u30A0-\u30FF]/;
  // Recently displayed lines that contain CJK/kana, oldest first.
  const ONSCREEN_WINDOW = 12;
  const recentCjkLines = []; // { key, kana }
  // Language of each captured cue, by compareKey(text), from the file it came
  // from. Only CJK-script languages are kept, because only they are ambiguous.
  // null marks text found in two tracks with different languages.
  const CJK_FILE_LANGS = new Set(["日本語", "简体中文", "繁體中文", "한국어"]);
  const cueLangByKey = new Map();

  function setSessionLanguage(lang) {
    if (lang && sessionLanguage !== lang) {
      sessionLanguage = lang;
      info("session language:", lang);
      // Which captured lines count as skip-list lines may just have changed;
      // let the pre-translator look at them again.
      scheduleBatchTranslation();
    }
  }

  // "ja" | "zh" | null, from the lines actually displayed recently.
  function onScreenCjkTrack() {
    const n = recentCjkLines.length;
    if (!n) return null;
    // The last few lines dominate, so switching subtitle tracks mid-video is
    // picked up after about two lines instead of being outvoted by history
    // from the previous track.
    const last3 = recentCjkLines.slice(-3);
    if (last3.length >= 3 && last3.every((l) => !l.kana)) return "zh";
    if (recentCjkLines.slice(-4).filter((l) => l.kana).length >= 2) return "ja";
    const kana = recentCjkLines.filter((l) => l.kana).length;
    if (n >= 4) {
      // Mixed recent evidence (e.g. one stray kana line in a Chinese track):
      // use the whole window. Japanese subtitles put kana in most lines,
      // Chinese ones almost never. In between, stay undecided and let the
      // line speak for itself — never fall back to "any kana means Japanese"
      // here, or a single song title in kana relabels a Chinese track.
      const r = kana / n;
      if (r >= 0.3) return "ja";
      if (r <= 0.1) return "zh";
      return null;
    }
    // Very little evidence yet: any kana seen on screen points at Japanese.
    return kana > 0 ? "ja" : null;
  }

  // Pure: no side effects. It runs every tick, on every render and for every
  // captured cue, so it must never change state.
  function detectLang(text) {
    if (!text) return "other";
    // Strong signals — these uniquely identify a language.
    if (KANA_RE.test(text)) return "日本語";
    if (/[\uAC00-\uD7AF]/.test(text)) return "한국어";
    if (/[\u0400-\u04FF]/.test(text)) return "Русский";
    if (/[\u0370-\u03FF]/.test(text)) return "Ελληνικά";
    // Ideographs without kana — ambiguous between Chinese and Japanese.
    //
    // This used to defer to `sessionLanguage`, which anything could pin to
    // 日本語 — one Japanese line, a prefetched Japanese subtitle file, or
    // watching the Japanese track before switching to 繁體中文 — and only a
    // video change could clear. Every Chinese line after that was classed as
    // 日本語, missed the skip list, and got translated. Use evidence instead,
    // strongest first.
    if (/[\u4E00-\u9FFF]/.test(text)) {
      const zh = TRADITIONAL_MARKERS.test(text) ? "繁體中文" : "简体中文";
      // 1. The subtitle file this exact line came from.
      const fileLang = cueLangByKey.get(compareKey(text));
      if (fileLang) return fileLang;
      // 2. What the recently displayed lines look like.
      const track = onScreenCjkTrack();
      if (track === "ja") return "日本語";
      if (track === "zh") return zh;
      // 3. No usable evidence yet.
      if (sessionLanguage === "한국어") return "한국어";
      return zh;
    }
    if (/[A-Za-z]/.test(text)) return "English";
    return "other";
  }

  // Record a line that is actually being shown. The only thing that feeds the
  // on-screen evidence window and the displayed session language.
  function observeOnScreenLine(text) {
    if (!text) return;
    if (/[\u3040-\u30FF\u3400-\u9FFF]/.test(text)) {
      const key = compareKey(text);
      if (!recentCjkLines.some((l) => l.key === key)) {
        recentCjkLines.push({ key, kana: KANA_RE.test(text) });
        if (recentCjkLines.length > ONSCREEN_WINDOW) recentCjkLines.shift();
      }
    }
    const lang = detectLang(text);
    if (lang === "other") return;
    // A stray Latin line (a name, a sign) must not relabel a CJK track.
    if (lang === "English" && sessionLanguage) return;
    setSessionLanguage(lang);
  }

  // Skip-list entries are free text — presets or typed by hand. Compare on
  // canonical keys so "繁体中文" typed by hand matches the detector's
  // "繁體中文", and a bare "中文" / "Chinese" covers both scripts.
  function langKeys(label) {
    const s = String(label || "").trim().toLowerCase();
    if (!s) return [];
    if (/^(繁體中文|繁体中文|繁中|正體中文|正体中文|traditional chinese|zh-hant|zh-tw|zh-hk)$/.test(s)) return ["zh-hant"];
    if (/^(简体中文|簡體中文|简中|簡中|simplified chinese|zh-hans|zh-cn|zh-sg)$/.test(s)) return ["zh-hans"];
    if (/^(中文|chinese|zh)$/.test(s)) return ["zh-hans", "zh-hant"];
    if (/^(日本語|日本语|日语|日文|japanese|ja)$/.test(s)) return ["ja"];
    if (/^(한국어|韩语|韓語|韩文|korean|ko)$/.test(s)) return ["ko"];
    if (/^(русский|俄语|russian|ru)$/.test(s)) return ["ru"];
    if (/^(ελληνικά|希腊语|greek|el)$/.test(s)) return ["el"];
    if (/^(english|英语|英文|en)$/.test(s)) return ["en"];
    return [s];
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
    const skip = new Set(list.flatMap(langKeys));
    return langKeys(detectLang(text)).some((k) => skip.has(k));
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

  // Where the video really shows, as opposed to where its element is. A player
  // that crops or zooms the picture does it by making the <video> larger than
  // its frame and clipping the excess, which leaves the element's bottom edge
  // below the screen. Anchoring the overlay to that edge put the translation
  // partly or wholly out of sight (reported on Netflix with wide-screen films,
  // whose black bars are the usual thing to be cropped away).
  //   shown   — the element's box cut down to what its clipping ancestors let
  //             through: the picture as the player frames it
  //   visible — `shown` cut down again to the viewport
  const RECT_MIN = 100; // anything smaller is not a video we would subtitle

  function intersectRects(a, b) {
    return {
      left: Math.max(a.left, b.left),
      top: Math.max(a.top, b.top),
      right: Math.min(a.right, b.right),
      bottom: Math.min(a.bottom, b.bottom),
    };
  }

  function rectIsUsable(r) {
    return r.right - r.left >= RECT_MIN && r.bottom - r.top >= RECT_MIN;
  }

  function videoArea() {
    const videos = getVideos();
    const video =
      videos.find((x) => !x.paused && x.readyState >= 2) || videos[0];
    if (!video) return null;
    const element = video.getBoundingClientRect();
    let shown = element;
    let pos = getComputedStyle(video).position;
    // A fixed box answers to the viewport, not to its ancestors.
    for (let el = video; pos !== "fixed"; ) {
      el = el.assignedSlot || el.parentElement || el.getRootNode?.().host;
      // <html> / <body> overflow belongs to the viewport, which is `visible`.
      if (!el || el === document.body || el === document.documentElement) break;
      const cs = getComputedStyle(el);
      // A static, untransformed ancestor does not clip an absolutely
      // positioned box: its containing block is further up.
      if (
        pos === "absolute" &&
        cs.position === "static" &&
        cs.transform === "none"
      ) {
        continue;
      }
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
        // Ignore a clip that leaves next to nothing: that is a zero-height
        // wrapper or similar, not the frame around the picture.
        const cut = intersectRects(shown, el.getBoundingClientRect());
        if (rectIsUsable(cut)) shown = cut;
      }
      pos = cs.position;
    }
    // Scrolled almost or entirely out of view: follow the video off-screen
    // instead of pinning the subtitle over the rest of the page.
    const cut = intersectRects(shown, {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
    });
    return { video, element, shown, visible: rectIsUsable(cut) ? cut : shown };
  }

  // Keep the overlay aligned with the part of the <video> that is on screen.
  // In windowed mode the video is only part of the page and the overlay would
  // otherwise stick to the page bottom.
  function positionOverlayToVideo() {
    if (!overlay) return;
    const area = videoArea();
    if (!area || !rectIsUsable(area.shown)) return;
    const { shown, visible } = area;
    const centerX = (visible.left + visible.right) / 2;
    // Position the overlay near the bottom of the visible picture, inset ~8%
    // of the picture's height (matches the default 8vh look used in
    // fullscreen). The inset is taken from `shown` so it does not change
    // while the page scrolls the video partly out of view.
    const targetBottom =
      visible.bottom - Math.max(16, (shown.bottom - shown.top) * 0.08);
    let bottomOffset = window.innerHeight - targetBottom;
    overlay.style.setProperty("left", `${centerX}px`, "important");
    overlay.style.setProperty("bottom", `${bottomOffset}px`, "important");
    overlay.style.setProperty(
      "max-width",
      `${(visible.right - visible.left) * 0.92}px`,
      "important"
    );
    // `bottom` counts from the viewport only while nothing above the overlay
    // has become the containing block for fixed boxes (a transform on <html>
    // does that). Rather than trust it, look at where the box landed and move
    // it by the difference.
    const r = overlay.getBoundingClientRect();
    if (r.height > 0 && Math.abs(r.bottom - targetBottom) > 1) {
      bottomOffset += r.bottom - targetBottom;
      overlay.style.setProperty("bottom", `${bottomOffset}px`, "important");
    }
  }

  // --- Translation line reflow ---------------------------------------------
  // The subtitle file splits a cue across lines to fit the SOURCE language's
  // width (parseTTML turns <br/> into "\n"), and the model mirrors that split.
  // A translation rarely breaks well in the same places, so join the lines
  // into one run that simply wraps at the overlay's max-width — keeping a
  // break only where it carries meaning:
  //   · after a sentence end (。！？ / .!?), optionally followed by a closer
  //   · at a dash — a line opening with one (dialogue) or ending with one
  //     (continuation, e.g. "……也在预算之内——")
  //   · before a speaker label such as （杉山） / (Sugiyama) / 【杉山】
  // A lone "." counts, but not the last dot of "..." — an ellipsis trails off
  // mid-thought, and treating it as a sentence end would keep a break there.
  const REFLOW_SENTENCE_END = /(?:[。！？!?]|(?<!\.)\.)[」』）)"'”’]*$/;
  const REFLOW_DASH_START = /^[-－—―–‐]/;
  const REFLOW_DASH_END = /(?:—|―|–|－|--)$/;
  const REFLOW_SPEAKER_START = /^[（(［\[【][^）)\]］】\n]{1,20}[）)\]］】]/;
  // Joining across a CJK (or full-width) boundary needs no space; Latin does.
  const REFLOW_CJK = /[\u3000-\u303F\u3040-\u30FF\u3400-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

  function breakCarriesMeaning(prev, cur) {
    return (
      REFLOW_SENTENCE_END.test(prev) ||
      REFLOW_DASH_END.test(prev) ||
      REFLOW_DASH_START.test(cur) ||
      REFLOW_SPEAKER_START.test(cur)
    );
  }

  function reflowTranslation(text, source) {
    if (!text || !text.includes("\n")) return text || "";
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return lines.join("");
    // Models sometimes drop the leading "-" or speaker label. When the source
    // has the same number of lines, its structure can vouch for the break too.
    const src = (source || "").split("\n").map((l) => l.trim()).filter(Boolean);
    const aligned = src.length === lines.length;
    let out = lines[0];
    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1];
      const cur = lines[i];
      if (
        breakCarriesMeaning(prev, cur) ||
        (aligned && breakCarriesMeaning(src[i - 1], src[i]) &&
          // …but a source sentence end alone is not a reason: that's exactly
          // the language-specific split we are removing.
          !REFLOW_SENTENCE_END.test(src[i - 1]))
      ) {
        out += "\n" + cur;
        continue;
      }
      const joinTight = REFLOW_CJK.test(prev.slice(-1)) || REFLOW_CJK.test(cur[0]);
      out += (joinTight ? "" : " ") + cur;
    }
    return out;
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
    // currentSkip was decided when the line appeared; see handleCueChange.
    const isSkipping = currentOriginal && currentSkip;
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
    // Reflow at display time rather than when the translation is stored, so
    // translations already in the cache get it too. The original row keeps
    // the source's own line layout.
    tEl.textContent = reflowTranslation(currentTranslated, currentOriginal);
    oEl.textContent = settings.showOriginal ? currentOriginal || "" : "";
    // Apply user-configurable font to the translated row. The original row
    // inherits the family but stays proportionally smaller.
    const fam = settings.fontFamily?.trim();
    const baseSize = Number(settings.fontSize) || 0;
    // Scale relative to the video's rendered height (reference: 1080p).
    // A user who sets 32px at 1080p gets ~64px on a 4K fullscreen and ~21px
    // on a 720p windowed player. Clamped so tiny thumbnails / absurdly large
    // video walls don't produce unreadable extremes. Measured on the picture
    // as the player frames it — a cropped <video> is taller than what shows.
    let scale = 1;
    const area = videoArea();
    if (area) {
      const h = area.shown.bottom - area.shown.top;
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

  // Every root the hide rule has been planted into, so it can be lifted again.
  const HIDE_STYLE_ID = "llm-subtitle-hide-native";
  const hideStyleRoots = new Set();

  function findHideStyle(root) {
    return root.getElementById
      ? root.getElementById(HIDE_STYLE_ID)
      : root.querySelector?.(`#${HIDE_STYLE_ID}`) || null;
  }

  function hideNativeSubtitles(on) {
    if (!on) {
      for (const root of hideStyleRoots) findHideStyle(root)?.remove();
      hideStyleRoots.clear();
      document.getElementById(HIDE_STYLE_ID)?.remove();
      return;
    }
    const selectors = platform.containerSelectors.filter(Boolean).join(", ");
    if (!selectors) return;
    // A <style> in the document cannot cross a shadow boundary. Cue extraction
    // walks shadow roots to FIND cues (collectNativeCueElements), so on a player
    // that renders captions inside one — Disney+'s web player is built from web
    // components — the cue is read and translated but was never hidden, and the
    // source line stays on screen under the translation. Plant the same rule in
    // every root that currently holds a cue, not just the document.
    const roots = new Set([document]);
    for (const el of nativeCueElements()) {
      const root = el.getRootNode?.();
      if (root && root !== document && root.host) roots.add(root);
    }
    for (const root of roots) {
      if (!findHideStyle(root)) {
        const style = document.createElement("style");
        style.id = HIDE_STYLE_ID;
        // Use opacity so the native subtitle's background box disappears too
        // (Disney+ renders an opaque black box behind its cues).
        style.textContent = `${selectors} { opacity: 0 !important; }`;
        (root === document ? document.documentElement : root).appendChild(style);
        log(
          root === document
            ? "native subtitles hidden"
            : "native subtitles hidden (inside a shadow root)"
        );
      }
      hideStyleRoots.add(root);
    }
  }

  // What the page is actually showing, not what we asked for. The old version
  // only recorded that a rule was injected, so a rule that could not reach the
  // cue failed completely silently.
  function nativeCueStats() {
    const els = nativeCueElements();
    let visible = 0;
    let inShadow = 0;
    for (const el of els) {
      const root = el.getRootNode?.();
      if (root && root !== document && root.host) inShadow++;
      if (
        (el.textContent || "").trim() &&
        parseFloat(getComputedStyle(el).opacity || "1") > 0
      ) {
        visible++;
      }
    }
    return { total: els.length, visible, inShadow };
  }

  let lastVisibleNative = 0;

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
  // selectors such as [class*='subtitle'] (HBO Max, Apple TV+) match our
  // llm-subtitle-* classes; reading our own Chinese back as "the subtitle"
  // gets it classified as a skip-list language and the native line shown.
  function isOwnOverlay(el) {
    return !!el && (el.id === "llm-subtitle-overlay" ||
      (typeof el.closest === "function" && !!el.closest("#llm-subtitle-overlay")));
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

  function mayTranslateNow(key) {
    const f = failures.get(key);
    return !f || (f.attempts < MAX_ROUNDS && Date.now() >= f.nextTryAt);
  }

  // Charge a line one round. After MAX_ROUNDS it is left alone until the video
  // changes; it then shows nothing, which is the point — never the source.
  function noteFailure(key, reason, text) {
    const f = failures.get(key) || { attempts: 0, nextTryAt: 0, reason: "" };
    f.attempts++;
    f.reason = reason;
    const wait = RETRY_DELAYS_MS[f.attempts - 1];
    f.nextTryAt = wait === undefined ? Infinity : Date.now() + wait;
    failures.set(key, f);
    if (f.attempts >= MAX_ROUNDS) {
      stats.gaveUp++;
      warn(
        `gave up on a line after ${f.attempts} rounds (${reason}); it stays ` +
          `hidden rather than showing the source:`,
        JSON.stringify(text)
      );
    } else {
      scheduleBatchWake();
    }
  }

  // Bring the pre-translator back when the earliest back-off runs out.
  function scheduleBatchWake() {
    clearTimeout(batchWakeTimer);
    batchWakeTimer = null;
    let earliest = Infinity;
    for (const c of cueList) {
      if (c.translation !== null) continue;
      const f = failures.get(compareKey(c.text));
      if (f && f.attempts < MAX_ROUNDS) earliest = Math.min(earliest, f.nextTryAt);
    }
    if (earliest === Infinity) return;
    batchWakeTimer = setTimeout(() => {
      batchWakeTimer = null;
      scheduleBatchTranslation();
    }, Math.max(50, earliest - Date.now()));
  }

  // Record what the service worker found wrong with the model's first reply,
  // and whether the second ask fixed it. This is the "was it the model?" log.
  function accountReply(resp, text) {
    const first = resp.first?.[0];
    if (!first || first === "kept") return;
    if (first === "echo") stats.echo++;
    else if (first === "wrong-language") stats.wrongLanguage++;
    else if (first === "empty") stats.empty++;
    const what = REASON_TEXT[first] || first;
    if (resp.rejected?.[0]) {
      stats.withheld++;
      warn(
        `model ${what}, and again when asked a second time — line withheld:`,
        JSON.stringify(text),
        resp.raw?.[0] ? `| it said: ${JSON.stringify(resp.raw[0])}` : "",
        resp.detail ? `| ${resp.detail}` : ""
      );
    } else {
      stats.recovered++;
      info(
        `model ${what}; asked again and got a translation:`,
        JSON.stringify(text),
        resp.raw?.[0] ? `| first it said: ${JSON.stringify(resp.raw[0])}` : ""
      );
    }
  }

  // -------------- name glossary --------------
  // Each cue is translated in a request of its own, so left to itself the
  // model spells the same name differently from one line to the next. The
  // names are settled first (background.js: buildNameGlossary) and every line
  // is then sent together with the renderings it has to use.
  //   glossary    — this video: name as spelled in the subtitles → rendering
  //   name memory — every rendering settled so far, kept in
  //                 chrome.storage.local so the next episode spells the cast
  //                 the same way. It is only OFFERED to the model, as "already
  //                 fixed": a name enters `glossary` when the model finds it
  //                 in this video's lines. A name from another title that is
  //                 an ordinary word here is therefore not forced on anything.
  const glossary = new Map();
  let glossaryTarget = ""; // the language those renderings are in
  let glossaryScan = null; // the scan in flight, if any
  let glossaryScans = 0; // scans started for this video
  let glossaryHoldUntil = 0; // pre-translation waits for names until then
  let glossaryUnsupported = false; // the provider takes no prompt
  const GLOSSARY_CHUNK_LINES = 500;
  const GLOSSARY_CHUNK_CHARS = 20000;
  // After the first scan, wait for this many new lines before asking again:
  // players that deliver subtitles a few cues at a time would otherwise cost
  // a glossary request per segment.
  const GLOSSARY_MIN_NEW_LINES = 40;
  const GLOSSARY_WAIT_MS = 15000;
  const GLOSSARY_REPLY_TIMEOUT_MS = 32000; // just over the worker's own limit
  const GLOSSARY_HINT_MAX = 16;
  const NAME_MEMORY_KEY = "nameMemory";
  const NAME_MEMORY_MAX = 1000;
  // Lines this close to being shown are translated without waiting for names.
  const IMMINENT_S = 20;

  function unifyNamesOn() {
    return settings?.unifyNames !== false && !glossaryUnsupported;
  }

  // In scripts written with spaces a name has to stand as a word of its own
  // ("Rose" is not in "Rosemary"). Korean particles and Japanese suffixes
  // attach directly to the name, so there a plain substring is the right test.
  const UNSPACED_SCRIPT = /[\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/;
  const LETTER = /\p{L}/u;

  function nameOccurs(name, text) {
    if (UNSPACED_SCRIPT.test(name)) return text.includes(name);
    for (let i = text.indexOf(name); i !== -1; i = text.indexOf(name, i + 1)) {
      const before = text[i - 1];
      const after = text[i + name.length];
      if (!(before && LETTER.test(before)) && !(after && LETTER.test(after))) {
        return true;
      }
    }
    return false;
  }

  // The renderings to send along with `text`.
  function glossaryFor(text) {
    if (!glossary.size || !unifyNamesOn()) return [];
    if (glossaryTarget !== (settings?.targetLanguage || "")) return [];
    const hits = [];
    for (const entry of glossary) {
      if (nameOccurs(entry[0], text)) hits.push(entry);
    }
    // Longest first, so a full name is listed before the given name inside it.
    return hits.sort((a, b) => b[0].length - a[0].length).slice(0, GLOSSARY_HINT_MAX);
  }

  // Stored as { [target language]: [[name, rendering], …] } — a rendering is
  // only good for the language it is in.
  async function readNameMemories() {
    try {
      const all = (await chrome.storage.local.get(NAME_MEMORY_KEY))?.[NAME_MEMORY_KEY];
      if (all && typeof all === "object" && !Array.isArray(all)) return all;
    } catch (_) {
      // No storage (or the extension was reloaded under this page): the
      // glossary still works for this video, it is just not remembered.
    }
    return {};
  }

  function memoryFor(all, target) {
    const entries = Array.isArray(all[target]) ? all[target] : [];
    return new Map(
      entries.filter(
        (e) => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string"
      )
    );
  }

  async function rememberNames(pairs, target) {
    if (!pairs.length) return;
    try {
      // Read again rather than reuse an earlier copy: another tab may have
      // added names in the meantime. What is stored first stays.
      const all = await readNameMemories();
      const memory = memoryFor(all, target);
      for (const [name, rendering] of pairs) {
        if (!memory.has(name)) memory.set(name, rendering);
      }
      all[target] = [...memory].slice(-NAME_MEMORY_MAX);
      await chrome.storage.local.set({ [NAME_MEMORY_KEY]: all });
    } catch (_) {}
  }

  function requestGlossary(lines, known) {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ ok: false, error: "no reply" }),
        GLOSSARY_REPLY_TIMEOUT_MS
      );
      const done = (r) => {
        clearTimeout(timer);
        resolve(r);
      };
      try {
        chrome.runtime.sendMessage({ type: "buildGlossary", lines, known }, (resp) => {
          const lastError = chrome.runtime.lastError;
          done(
            lastError
              ? { ok: false, error: lastError.message }
              : resp || { ok: false, error: "no reply" }
          );
        });
      } catch (e) {
        done({ ok: false, error: String(e?.message || e) });
      }
    });
  }

  const needsNameScan = (c) =>
    !c.scanned && !!compareKey(c.text) && !shouldSkipTranslation(c.text);

  // The next lot of lines to look through, nearest the playhead first: those
  // are the lines about to be translated.
  function nextNameChunk() {
    const pending = cueList.filter(needsNameScan);
    if (glossaryScans > 1 && pending.length < GLOSSARY_MIN_NEW_LINES) return [];
    pending.sort(byPlayhead(cueClock()));
    // Even lots rather than a full one followed by a handful.
    const lots = Math.ceil(pending.length / GLOSSARY_CHUNK_LINES);
    const size = Math.ceil(pending.length / (lots || 1));
    const chunk = [];
    let chars = 0;
    for (const c of pending) {
      if (chunk.length >= size || chars >= GLOSSARY_CHUNK_CHARS) break;
      chunk.push(c);
      chars += c.text.length;
    }
    return chunk;
  }

  async function runNameScan() {
    let first = true;
    for (;;) {
      const chunk = nextNameChunk();
      if (!chunk.length) return;
      for (const c of chunk) c.scanned = true;
      const video = lastVideoId;
      const target = glossaryTarget;
      const lines = [...new Set(chunk.map((c) => c.text.replace(/\s+/g, " ").trim()))];
      const text = lines.join("\n");
      const memory = memoryFor(await readNameMemories(), target);
      // What is already settled and shows up in these lines: this video's
      // names (so "지훈" agrees with "김지훈"), then names from earlier videos.
      const known = [...glossary].filter(([name]) => text.includes(name));
      for (const entry of memory) {
        if (!glossary.has(entry[0]) && text.includes(entry[0])) known.push(entry);
      }
      const t0 = Date.now();
      let resp = await requestGlossary(lines, known);
      // A failure this quick is usually a 429 or a 503; one more try is cheap.
      if (!resp.ok && Date.now() - t0 < 8000) resp = await requestGlossary(lines, known);
      if (first) {
        // The lines nearest the playhead have had their turn; the rest of the
        // scan stays far ahead of the translator, which takes seconds a line.
        first = false;
        glossaryHoldUntil = 0;
      }
      // Answered for a video that is gone, or in a language no longer wanted.
      if (lastVideoId !== video || glossaryTarget !== target) continue;
      if (!resp.ok) {
        warn(
          `name glossary: could not settle the names in ${chunk.length} lines ` +
            `(${resp.error}); they are translated without it`
        );
        continue;
      }
      if (resp.unsupported) {
        glossaryUnsupported = true;
        // Nothing was looked at: leave it all for a provider that can.
        glossaryScans = 0;
        for (const c of chunk) c.scanned = false;
        info("name glossary: not available with this translation provider");
        return;
      }
      const added = [];
      for (const [name, rendering] of resp.entries || []) {
        if (glossary.has(name)) continue;
        // A rendering settled before — in an earlier episode — beats a new idea.
        const fixed = memory.get(name) || rendering;
        glossary.set(name, fixed);
        added.push([name, fixed]);
      }
      await rememberNames(added, target);
      info(
        `name glossary: ${added.length} new name(s) from ${chunk.length} lines ` +
          `in ${Date.now() - t0}ms (${glossary.size} in all)` +
          (added.length
            ? ": " + added.slice(0, 12).map(([n, r]) => `${n}→${r}`).join(", ")
            : "")
      );
    }
  }

  // Start settling the names in captured lines not looked at yet. Returns the
  // scan in flight (a promise), or null when there is nothing to do.
  function scanForNames() {
    if (glossaryScan) return glossaryScan;
    // Subtitles can be captured before the settings have arrived.
    if (!settings || !unifyNamesOn()) return null;
    const target = settings.targetLanguage || "";
    if (glossaryTarget !== target) {
      // Renderings in another language are no use: start over.
      glossary.clear();
      glossaryTarget = target;
      glossaryScans = 0;
      for (const c of cueList) c.scanned = false;
    }
    glossaryScans++;
    if (!nextNameChunk().length) {
      glossaryScans--;
      return null;
    }
    glossaryHoldUntil = Date.now() + GLOSSARY_WAIT_MS;
    glossaryScan = runNameScan()
      .catch((e) => warn("name glossary: scan failed:", String(e?.message || e)))
      .finally(() => {
        glossaryScan = null;
        glossaryHoldUntil = 0;
      });
    return glossaryScan;
  }

  // The one way a translation is obtained — for the line on screen (live) and
  // for the pre-translator alike. Returns "" when there is none to show; only
  // text the service worker accepted is ever cached or returned.
  async function translateText(text, { live = true } = {}) {
    const key = compareKey(text);
    if (!key) return "";
    if (cache.has(key)) return cache.get(key);
    if (pending.has(key)) return pending.get(key);
    // Refused recently: wait out the back-off. Out of rounds: leave it.
    if (!mayTranslateNow(key)) return "";
    const attempt = failures.get(key)?.attempts || 0;

    // Send the whole cue as ONE translation unit. Splitting on '\n' and then
    // joining batch entries with '\n---\n' confused some models: they'd
    // translate only the first line and echo the rest of the source text,
    // which our parser's byLine-fallback then accepted as "translations".
    const lines = [text];
    const names = glossaryFor(text);
    if (names.length) stats.named++;
    const t0 = Date.now();
    const promise = new Promise((resolve) => {
      // Context lines only make sense in playing order, i.e. for live lines.
      const n = live ? Math.max(0, settings?.contextLines ?? 0) : 0;
      const historySlice = n > 0 ? history.slice(-n) : [];
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      // Every exit without a translation goes through here, so the line is
      // always charged a round. That is what stops either caller from asking
      // for the same line again in a tight loop.
      const fail = (reason) => {
        if (settled) return;
        noteFailure(key, reason, text);
        finish("");
      };
      const accept = (tr) => {
        failures.delete(key);
        cache.set(key, tr);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      };
      const timer = setTimeout(() => {
        stats.errors++;
        err(`translation timed out after ${TRANSLATE_TIMEOUT_MS}ms:`,
          JSON.stringify(text)
        );
        fail("timeout");
      }, TRANSLATE_TIMEOUT_MS);
      chrome.runtime.sendMessage(
        { type: "translate", lines, history: historySlice, attempt, glossary: names },
        (resp) => {
          const dt = Date.now() - t0;
          const lastError = chrome.runtime.lastError;
          if (settled) {
            // Timed out earlier; a good answer that arrives late is still
            // worth keeping for the next time the line comes round.
            if (!lastError && resp?.ok && resp.translations?.[0]) {
              accept(resp.translations[0]);
            }
            return;
          }
          if (lastError) {
            stats.errors++;
            err(`translation runtime error after ${dt}ms:`, lastError.message);
            fail("error");
            return;
          }
          if (!resp?.ok) {
            stats.errors++;
            err(`translation failed after ${dt}ms:`, resp?.error);
            fail("error");
            return;
          }
          accountReply(resp, text);
          const tr = resp.translations?.[0] || "";
          if (!tr) {
            fail(resp.rejected?.[0] || "empty");
            return;
          }
          accept(tr);
          if (live) {
            info(`translated in ${dt}ms:`,
              JSON.stringify(text),
              "→",
              JSON.stringify(tr)
            );
            history.push({ source: text, translation: tr });
            if (history.length > HISTORY_MAX) history.shift();
          }
          finish(tr);
          // The line may be on screen right now with nothing under it — a
          // retry that landed late, or a pre-translation finishing just after
          // the line appeared. Show it.
          if (
            !currentSkip &&
            !currentTranslated &&
            currentOriginal &&
            compareKey(currentOriginal) === key
          ) {
            currentTranslated = tr;
            renderOverlay();
          }
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
      currentSkip = false;
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
    // A new line never starts out showing anything: the translated row holds
    // only text that came back from translateText().
    currentTranslated = "";
    currentSkip = false;
    if (!text) {
      renderOverlay();
      return;
    }
    observeOnScreenLine(text);
    // Source language is in the user's skip list — no API call, renderOverlay
    // stands down (Method B: let the native subtitle show through).
    currentSkip = shouldSkipTranslation(text);
    if (currentSkip) {
      const lang = detectLang(text);
      stats.skipped[lang] = (stats.skipped[lang] || 0) + 1;
      info(`skipped (${lang} in skip list); showing native`);
      renderOverlay();
      return;
    }
    const key = compareKey(text);
    const ready = cache.has(key);
    if (ready) stats.instant++;
    else stats.waited++;
    log(`translating: detected ${detectLang(text)}, not in the skip list`);
    renderOverlay();

    // MIN_INTERVAL_MS paces requests to the API, so only wait when one is
    // actually about to be made — not for a line that is already cached or
    // already in flight.
    if (!ready && !pending.has(key)) {
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

  function ingestParsedCues(cues, lang) {
    if (!cues.length) return 0;
    if (lang && CJK_FILE_LANGS.has(lang)) {
      for (const c of cues) {
        const k = compareKey(c.text);
        const prev = cueLangByKey.get(k);
        if (prev === undefined) cueLangByKey.set(k, lang);
        else if (prev !== lang) cueLangByKey.set(k, null);
      }
    }
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

  // Where playback is, on the clock the cue times use.
  function cueClock() {
    const videos = getVideos();
    const cur = videos.find((v) => !v.paused && v.readyState >= 2) || videos[0];
    return (cur ? cur.currentTime : 0) - timelineOffset;
  }

  // Upcoming cues first, nearest first; cues already behind the playhead last.
  function byPlayhead(now) {
    const dist = (c) => (c.start >= now ? c.start - now : now - c.start + 1e6);
    return (a, b) => dist(a) - dist(b);
  }

  let batchSchedulerRunning = false;
  async function scheduleBatchTranslation() {
    if (batchSchedulerRunning) return;
    batchSchedulerRunning = true;
    try {
      // Keep draining while new cues keep being captured.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // Names first — see "name glossary". Until they are settled only the
        // lines about to be shown go out, so nothing reaches the screen late
        // and nothing else is translated with a name spelled ad hoc.
        const scan = scanForNames();
        // Skip-list lines are left alone — and deliberately NOT marked as
        // translated. Which language a kanji-only line is in can change once
        // more lines have been seen, and a line written off here as "Chinese,
        // nothing to do" used to be cached with its own source text as its
        // translation and shown that way for good.
        const pool = cueList.filter((c) => {
          if (c.translation !== null || c.translating) return false;
          const key = compareKey(c.text);
          return !!key && mayTranslateNow(key) && !shouldSkipTranslation(c.text);
        });
        if (!pool.length) break;
        // Same clock the timeline display uses, so "nearest upcoming cue"
        // really is the one about to be shown.
        const now = cueClock();
        pool.sort(byPlayhead(now));
        const holding = !!scan && Date.now() < glossaryHoldUntil;
        const waitForNames = () =>
          Promise.race([scan, new Promise((r) => setTimeout(r, 500))]);
        const batch = holding
          ? pool.filter((c) => c.end >= now && c.start - now <= IMMINENT_S)
          : pool;
        if (!batch.length) {
          await waitForNames();
          continue;
        }
        // Each request measures 2–5s against this provider, so 3 workers only
        // just keep ahead of playback and any stall puts the playhead in front
        // of the translated window.
        const MAX_CONCURRENT = 5;
        const t0 = Date.now();
        let filled = 0;
        let charged = 0;
        let idx = 0;
        const workers = [];
        for (let w = 0; w < MAX_CONCURRENT; w++) {
          workers.push(
            (async () => {
              while (idx < batch.length) {
                const c = batch[idx++];
                const key = compareKey(c.text);
                const before = failures.get(key)?.attempts || 0;
                c.translating = true;
                let tr = "";
                try {
                  // Same path as the line on screen: shared cache, shared
                  // in-flight requests, time-out, validation and back-off.
                  tr = await translateText(c.text, { live: false });
                } finally {
                  c.translating = false;
                }
                if (tr) {
                  c.translation = tr;
                  filled++;
                } else if ((failures.get(key)?.attempts || 0) > before) {
                  charged++;
                }
              }
            })()
          );
        }
        await Promise.all(workers);
        info(
          `pre-translated ${filled}/${batch.length} cues in ${Date.now() - t0}ms` +
            (charged ? ` (${charged} refused, will retry later)` : "")
        );
        // Nothing moved at all: whatever is left is waiting on something else.
        // Stop rather than spin; the retry timers bring us back. (While names
        // are being settled the rest of the pool is still to come.)
        if (!filled && !charged) {
          if (!holding) break;
          await waitForNames();
        }
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
    // The language this FILE declares. Deliberately not the session language:
    // players also fetch tracks the viewer did not pick.
    let fileLang = null;
    if (text.startsWith("WEBVTT")) cues = parseWebVTT(text);
    else if (/<tt[\s>]/i.test(text)) {
      cues = parseTTML(text);
      // TTML carries the source language in xml:lang — use it as an
      // authoritative hint so kanji-only Japanese lines aren't mis-classified
      // as Chinese later on.
      const langMatch =
        text.match(/xml:lang="([^"]+)"/i) || text.match(/\slang="([^"]+)"/i);
      fileLang = langMatch ? langCodeToDisplay(langMatch[1]) : null;
    } else if (/^\s*\{\s*"(wireMagic|events)"/.test(text)) {
      cues = parseYouTubeJSON3(text);
    } else if (/<transcript/i.test(text.slice(0, 200))) {
      cues = parseYouTubeXML(text);
    }
    // Subtitle URLs often name the track (`&lang=ja`, `….zh-Hant.vtt`).
    if (!fileLang && d.url) {
      const m =
        d.url.match(/[?&]lang=([a-zA-Z-]+)/) ||
        d.url.match(/[._-]((?:zh-(?:hant|hans|tw|cn|hk))|ja|ko)\.(?:vtt|ttml2?|dfxp|srt|xml)(?:[?#]|$)/i);
      fileLang = m ? langCodeToDisplay(m[1]) : null;
    }
    if (cues.length) {
      const added = ingestParsedCues(cues, fileLang);
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
      observeOnScreenLine(match.text);
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
      // Re-assert hiding every tick. renderOverlay only runs on cue or
      // settings changes, and players re-create their subtitle nodes — and
      // sometimes the shadow root holding them — so a fresh root needs its own
      // copy of the rule. Not while standing down for a skip-list cue, where
      // the native subtitle is meant to show.
      if (
        settings?.enabled &&
        !(currentOriginal && currentSkip)
      ) {
        hideNativeSubtitles(true);
        const stats = nativeCueStats();
        if (stats.visible && !lastVisibleNative) {
          warn(
            `hide rule is in place, but ${stats.visible} native cue element(s) ` +
              `are STILL VISIBLE (${stats.inShadow} inside a shadow root) — ` +
              `the source line shows under the translation`
          );
        }
        lastVisibleNative = stats.visible;
      }
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
    // Forgetting the line means the next tick sees it as new and decides
    // afresh — which is also how a changed skip list takes effect.
    currentOriginal = "";
    currentTranslated = "";
    currentSkip = false;
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
    glossaryUnsupported = false; // the provider may have changed; ask again
    const active = !!settings?.enabled && isPlayerPage();
    hideNativeSubtitles(active);
    if (active) startObserving();
    else stopObserving();
    renderOverlay();
  }

  // Where things are on screen right now, each box as [left, top, width,
  // height]. "The subtitle is cut off" cannot be diagnosed from text logs.
  function layoutSnapshot() {
    const area = videoArea();
    const box = (r) =>
      [r.left, r.top, r.right - r.left, r.bottom - r.top].map(Math.round);
    const showing = overlay && overlay.style.display !== "none";
    return {
      viewport: [window.innerWidth, window.innerHeight],
      fullscreen: !!fullscreenTarget(),
      videos: getVideos().length,
      frame: area ? [area.video.videoWidth, area.video.videoHeight] : null,
      element: area ? box(area.element) : null,
      visible: area ? box(area.visible) : null,
      overlay: showing ? box(overlay.getBoundingClientRect()) : null,
    };
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
      nativeCues: nativeCueStats(),
      layout: layoutSnapshot(),
      names: {
        enabled: settings?.unifyNames !== false,
        unsupported: glossaryUnsupported,
        scanning: !!glossaryScan,
        count: glossary.size,
        sample: [...glossary].slice(0, 30),
      },
      showingNative: !!(currentOriginal && currentSkip),
      stats,
      withheldLines: [...failures.values()].filter((f) => f.attempts >= MAX_ROUNDS).length,
      retryingLines: [...failures.values()].filter((f) => f.attempts < MAX_ROUNDS).length,
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
      recentCjkLines.length = 0;
      cueLangByKey.clear();
      failures.clear();
      glossary.clear();
      glossaryScans = 0;
      glossaryHoldUntil = 0;
      currentSkip = false;
      clearTimeout(batchWakeTimer);
      batchWakeTimer = null;
      info(`new video detected (${id}); cue library cleared, re-evaluating`
      );
      // Re-decide whether this URL is a player page; Netflix browse → /watch/
      // and back should toggle the observer on/off accordingly.
      applySettings();
    }
  }, 1000);

  applySettings();
})();
