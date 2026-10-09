const $ = (id) => document.getElementById(id);

const MODEL_HINTS = {
  gemini: "从上面的列表里选，或选「自定义」填写任意模型名。留空则使用后端默认。",
  openai: "从上面的列表里选，或选「自定义」填写任意模型名。留空则使用后端默认。",
  anthropic: "从上面的列表里选，或选「自定义」填写任意模型名。留空则使用后端默认。",
  "google-translate":
    "Google Translate 无需模型设置，此项可留空。使用 Cloud Translation API v2，需要在 Google Cloud Console 开启 API 并创建 API Key。",
  custom: "选「自定义」填写你的目标模型名。Endpoint 必须是 OpenAI chat/completions 兼容。",
};

// Preset model names offered per backend. The stored value stays a plain
// string, so anything not in this list simply shows up as 自定义 — the presets
// are a convenience, never a restriction.
const MODEL_PRESETS = {
  gemini: [
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash-lite",
  ],
  openai: ["gpt-4o-mini"],
  anthropic: ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5"],
  custom: [],
};
// Fallback model per backend, sent by the service worker so this page never
// keeps a second copy that could drift.
let defaultModels = {};

// Sentinel for the last entry. Cannot collide with a real model name.
const MODEL_CUSTOM = "__custom__";

// Local cache of the per-provider maps so that editing the API key or model
// for the currently-selected provider writes back to the correct slot, and
// switching providers instantly swaps the displayed value.
let apiKeys = {};
let models = {};
let skipLanguages = [];

function toast(msg, ok = true) {
  const el = $("saveStatus");
  el.textContent = msg;
  el.classList.add("visible");
  el.style.background = ok ? "" : "var(--err)";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("visible"), 1500);
}

async function load() {
  const s = await chrome.runtime.sendMessage({ type: "getSettings" });
  // IMPORTANT: mutate the existing objects in place. The bindFixedSlot /
  // bindLLMField handlers captured the original references via closure; if
  // we reassigned the variables here, those handlers would keep writing to
  // the old (now-orphaned) object and never touch the displayed state.
  for (const k of Object.keys(apiKeys)) delete apiKeys[k];
  Object.assign(apiKeys, s.apiKeys || {});
  for (const k of Object.keys(models)) delete models[k];
  Object.assign(models, s.models || {});
  defaultModels = s.defaultModels || {};
  skipLanguages.length = 0;
  skipLanguages.push(...(s.skipLanguages || []));
  renderSkipChips();
  $("provider").value = s.provider;
  $("customEndpoint").value = s.customEndpoint || "";
  $("temperature").value = s.temperature ?? 0.2;
  $("targetLanguage").value = s.targetLanguage || "简体中文";
  $("contextLines").value = s.contextLines ?? 0;
  $("showOriginal").checked = !!s.showOriginal;
  $("enabled").checked = !!s.enabled;
  $("debug").checked = !!s.debug;
  applyFontSizeMode(s.fontSizeSource || "custom");
  $("fontFamily").value = s.fontFamily || "";
  $("fontWeight").value = String(s.fontWeight ?? 400);
  $("fontSize").value = s.fontSize ?? 32;
  // Shown until dismissed: the provider this user had selected is gone.
  $("providerNotice").hidden = !s.removedProviderNotice;
  $("textBgEnabled").checked = s.textBgEnabled !== false;
  $("textBgOpacity").value = s.textBgOpacity ?? 35;
  applyProviderSwap();
  updateStylePreview();
}

// --- Font size mode -------------------------------------------------------
// The switch governs the size only: on = follow the site's caption size,
// off = use the px field below. The family is always the user's own, so it
// is never disabled.

function applyFontSizeMode(mode) {
  const inheriting = mode === "platform";
  $("fontSizeInherit").checked = inheriting;
  $("fontSize").disabled = inheriting;
  $("rowFontSize").classList.toggle("is-disabled", inheriting);
  updateStylePreview();
}

$("fontSizeInherit").addEventListener("change", (e) => {
  const mode = e.target.checked ? "platform" : "custom";
  applyFontSizeMode(mode);
  saveField("fontSizeSource", mode);
});

// --- Live font readout from the open streaming tab ------------------------
// Kept up to date in both modes, so the current site's font is always visible.
// Host permissions already cover these origins, so tabs.query needs no extra
// permission; the URL filter also keeps us from touching unrelated tabs.
const STREAMING_MATCHES = [
  "https://*.netflix.com/*",
  "https://*.disneyplus.com/*",
  "https://*.hotstar.com/*",
  "https://*.primevideo.com/*",
  "https://*.amazon.com/*",
  "https://*.youtube.com/*",
  "https://*.hbomax.com/*",
  "https://*.max.com/*",
  "https://tv.apple.com/*",
  "https://*.tver.jp/*",
];

let nativeFontReading = null; // last successful read, for the preview

function showNativeFont(text, ok = false) {
  const el = $("nativeFontInfo");
  el.textContent = text;
  el.classList.toggle("ok", ok);
}

async function refreshNativeFont() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: STREAMING_MATCHES });
  } catch (err) {
    showNativeFont(`无法查询标签页：${err.message}`);
    return;
  }
  if (!tabs.length) {
    nativeFontReading = null;
    showNativeFont("未检测到已打开的流媒体页面");
    updateStylePreview();
    return;
  }
  const tab = tabs.find((t) => t.active) || tabs[0];
  const host = (() => {
    try {
      return new URL(tab.url).hostname;
    } catch (_) {
      return "";
    }
  })();
  const resp = await new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tab.id, { type: "getNativeFont" }, (r) => {
        void chrome.runtime.lastError; // silent when no frame answers
        resolve(r);
      });
    } catch (_) {
      resolve(null);
    }
  });
  if (!resp) {
    nativeFontReading = null;
    showNativeFont(`${host} · 页面无响应，刷新该标签页后重试`);
  } else if (!resp.fontSize) {
    nativeFontReading = null;
    showNativeFont(`${host} · 已连接，但当前没有字幕可测量`);
  } else {
    nativeFontReading = {
      fontFamily: resp.fontFamily,
      fontSize: resp.fontSize,
    };
    const size = Math.round(resp.fontSize);
    showNativeFont(
      `${host} · ${resp.fontFamily} · ${size}px${resp.live ? "" : "（上次读数）"}`,
      true
    );
  }
  updateStylePreview();
}

$("nativeFontRefresh").addEventListener("click", refreshNativeFont);

// --- Log / diagnostics panel ---------------------------------------------
// Reads the content script's in-memory log and timing stats, so the state of
// a playing tab is inspectable from here rather than from DevTools.

function summarize(d) {
  const lines = [];
  const st = d.stats || {};
  const instant = st.instant || 0;
  const waited = st.waited || 0;
  const total = instant + waited;

  // Display always follows the page's own cue; pre-translation helps by having
  // the answer cached before the line appears. So the useful question is how
  // many lines were ready in time.
  if (!total && !d.capturedCues) {
    lines.push("ℹ️ 还没有显示过需要翻译的字幕。请先播放一段有字幕的内容，再回来刷新。");
  } else if (!total) {
    lines.push(
      `ℹ️ 已抓到 ${d.capturedCues} 条字幕（翻译好 ${d.preTranslated} 条），还没有显示过需要翻译的台词。`
    );
  } else if (!d.capturedCues) {
    lines.push(
      "❌ 预翻译库是空的——一条字幕都没抓到。每句都得等台词出现后才现场翻译，" +
        "所以长句会迟到、短句可能来不及显示。"
    );
  } else if (waited > instant) {
    lines.push(
      `⚠️ 抓到了 ${d.capturedCues} 条字幕（翻译好 ${d.preTranslated} 条），` +
        `但多数台词出现时译文还没备好（已备好 ${instant} 句 / 现场等待 ${waited} 句）。`
    );
  } else {
    lines.push(
      `✅ 预翻译在起作用：${instant} 句出现时译文已备好，${waited} 句需要现场翻译。` +
        `已抓到 ${d.capturedCues} 条、翻译好 ${d.preTranslated} 条。`
    );
  }

  // Who is responsible when a line goes wrong: the model, the network, or a
  // setting of this extension.
  const bad = (st.echo || 0) + (st.wrongLanguage || 0) + (st.empty || 0);
  if (bad) {
    lines.push(
      `模型：首次回答不能用 ${bad} 次（原样返回原文 ${st.echo || 0}、` +
        `答成别的语言 ${st.wrongLanguage || 0}、没有内容 ${st.empty || 0}）。` +
        `重问后挽回 ${st.recovered || 0} 次，仍不行而被扣下不显示 ${st.withheld || 0} 次` +
        (d.retryingLines ? `；${d.retryingLines} 句稍后会再试` : "") +
        (d.withheldLines ? `；${d.withheldLines} 句已放弃` : "") +
        "。扣下的台词不显示任何内容，不会露出原文。"
    );
  } else if (total) {
    lines.push("模型：到目前为止每次回答都可用。");
  }
  if (st.errors) {
    lines.push(`请求：失败 ${st.errors} 次（网络、超时或接口报错），对应台词稍后重试。`);
  }
  const skipped = Object.entries(st.skipped || {});
  if (skipped.length) {
    lines.push(
      "插件：按「不翻译的语言」直接显示了原字幕——" +
        skipped.map(([lang, n]) => `${lang} ${n} 句`).join("、") +
        "。如果其中有不该跳过的语种，请检查该列表。"
    );
  }

  if (!d.enabled) lines.push("⚠️ 扩展当前是关闭状态。");
  if (!d.playerPage) lines.push("⚠️ 当前 URL 未被识别为播放页。");
  // Whether the page's own subtitle is actually hidden. Put a failure FIRST:
  // the panel colours itself from the first line, and nothing else going well
  // should make the box green while the source line is still on screen.
  const nc = d.nativeCues;
  if (nc && nc.visible > 0 && !d.showingNative) {
    lines.unshift(
      `❌ 原生字幕没有被隐藏：${nc.visible} 个字幕元素仍然可见` +
        (nc.inShadow ? `（其中 ${nc.inShadow} 个在 shadow root 里）` : "") +
        `。所以译文下面还能看到原文，开了「显示原文」就会出现两行原文。`
    );
  } else if (nc && nc.total === 0 && d.currentTranslated) {
    lines.push(
      "⚠️ 正在显示译文，但页面上一个原生字幕元素都没匹配到。" +
        "这说明该平台的字幕选择器可能已经过时，原文无法被隐藏。"
    );
  } else if (nc && nc.total > 0 && !d.showingNative) {
    lines.push(
      `原生字幕已隐藏（${nc.total} 个元素` +
        (nc.inShadow ? `，${nc.inShadow} 个在 shadow root 里` : "") +
        `）`
    );
  }
  // Which names have a fixed rendering in the video being played.
  const nm = d.names;
  if (nm) {
    if (nm.unsupported) {
      lines.push("译名：当前翻译服务不接受提示词，无法保持人名一致。");
    } else if (!d.capturedCues) {
      lines.push("译名：没有抓到字幕文件，无法提前整理人名，同一个名字可能出现不同译法。");
    } else if (!nm.count) {
      lines.push(
        nm.scanning
          ? "译名：正在从字幕里整理人名……"
          : "译名：还没有定下任何译名（字幕里没找到人名，或整理的请求失败了——失败会记在下面的日志里）。"
      );
    } else {
      lines.push(
        `译名：本片已定下 ${nm.count} 个` +
          (nm.scanning ? "（还在整理）" : "") +
          " —— " +
          nm.sample.map(([n, r]) => `${n}→${r}`).join("、") +
          (nm.count > nm.sample.length ? " …" : "") +
          `。打开页面以来共有 ${st.named || 0} 句翻译时带上了译名。`
      );
    }
  }
  // Where the translation sits relative to what can be seen. Boxes are
  // [left, top, width, height]. A box that pokes out goes FIRST, as above.
  const lay = d.layout;
  if (lay && lay.element) {
    const size = (b) => `${b[2]}×${b[3]}`;
    const el = lay.element;
    const vis = lay.visible;
    const ov = lay.overlay;
    const cropped = el[2] > vis[2] + 1 || el[3] > vis[3] + 1;
    if (
      ov &&
      (ov[0] < vis[0] - 1 ||
        ov[1] < vis[1] - 1 ||
        ov[0] + ov[2] > vis[0] + vis[2] + 1 ||
        ov[1] + ov[3] > vis[1] + vis[3] + 1)
    ) {
      lines.unshift(
        "❌ 译文框有一部分在可见画面之外，字幕会被截掉或完全看不到。" +
          "反馈时请用「复制」带上这段诊断。"
      );
    }
    lines.push(
      `画面：窗口 ${lay.viewport[0]}×${lay.viewport[1]}` +
        (lay.fullscreen ? "（全屏）" : "") +
        ` · 片源 ${lay.frame[0]}×${lay.frame[1]}` +
        ` · 视频元素 ${size(el)}，位于 (${el[0]}, ${el[1]})` +
        (cropped
          ? `，其中只有 ${size(vis)} 在可见范围内，译文按这部分定位`
          : "") +
        (lay.videos > 1 ? ` · 页面上共有 ${lay.videos} 个视频` : "") +
        " · " +
        (ov
          ? `译文框 ${size(ov)}，底边距可见画面底部 ${vis[1] + vis[3] - ov[1] - ov[3]}px`
          : "译文框当前未显示")
    );
  }
  lines.push(
    `平台 ${d.platform} · 字幕语种 ${d.sessionLanguage || "未确定"} · ` +
      `目标 ${d.targetLanguage}`
  );
  return lines.join("\n");
}

function formatLogs(logs) {
  if (!logs || !logs.length) return "（暂无日志）";
  return logs
    .map((e) => {
      const d = new Date(e.t);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      const ss = String(d.getSeconds()).padStart(2, "0");
      const tag =
        e.level === "error" ? "✖" : e.level === "warn" ? "▲" : e.level === "debug" ? "·" : " ";
      return `${hh}:${mm}:${ss} ${tag} ${e.msg}`;
    })
    .join("\n");
}

let lastLogs = null;

async function refreshLogs() {
  const sum = $("logSummary");
  const out = $("logOutput");
  sum.hidden = false;
  out.hidden = false;

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: STREAMING_MATCHES });
  } catch (err) {
    sum.textContent = `无法查询标签页：${err.message}`;
    return;
  }
  if (!tabs.length) {
    sum.className = "diag-verdict";
    sum.textContent = "未检测到已打开的流媒体页面。请先打开播放页。";
    out.textContent = "";
    return;
  }
  const tab = tabs.find((t) => t.active) || tabs[0];
  const resp = await new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tab.id, { type: "getLogs" }, (r) => {
        void chrome.runtime.lastError;
        resolve(r);
      });
    } catch (_) {
      resolve(null);
    }
  });
  if (!resp) {
    sum.className = "diag-verdict";
    sum.textContent = "播放页没有响应。扩展更新后需要重新加载该标签页。";
    out.textContent = "";
    return;
  }
  lastLogs = resp;
  const text = summarize(resp);
  sum.className =
    "diag-verdict " + (text.startsWith("✅") ? "good" : text.startsWith("❌") ? "bad" : "");
  sum.textContent = text;
  const atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 20;
  out.textContent = formatLogs(resp.logs);
  if (atBottom) out.scrollTop = out.scrollHeight;
}

$("logRefresh").addEventListener("click", refreshLogs);
let logTimer = null;
$("logAuto").addEventListener("change", (e) => {
  clearInterval(logTimer);
  logTimer = null;
  if (e.target.checked) {
    refreshLogs();
    logTimer = setInterval(() => {
      if (!document.hidden) refreshLogs();
    }, 2000);
  }
});
$("logCopy").addEventListener("click", async () => {
  if (!lastLogs) return;
  await navigator.clipboard.writeText(
    summarize(lastLogs) + "\n\n" + formatLogs(lastLogs.logs)
  );
  toast("已复制");
});
// Poll while the page is actually being looked at.
setInterval(() => {
  if (!document.hidden) refreshNativeFont();
}, 2000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshNativeFont();
});

// Mirrors the overlay styling in content.css / renderOverlay() so the font
// and backdrop settings can be judged without switching to a real player.
function updateStylePreview() {
  const inheriting = $("fontSizeInherit").checked;
  // Only the size can come from the player; the family is always the user's.
  const useNative = inheriting && nativeFontReading;
  const fam = $("fontFamily").value.trim();
  const on = $("textBgEnabled").checked;
  const pct = on ? Math.max(0, Math.min(90, Number($("textBgOpacity").value) || 0)) : 0;
  const bg = `rgba(0, 0, 0, ${pct / 100})`;
  // The preview box is far smaller than a real frame, so shrink the
  // configured size into something that fits instead of using it verbatim.
  const rawSize = useNative
    ? nativeFontReading.fontSize
    : Number($("fontSize").value) || 32;
  const px = Math.max(12, Math.min(34, rawSize * 0.7));
  const weight = Number($("fontWeight").value) || 400;
  const t = $("previewTranslated");
  const o = $("previewOriginal");
  t.style.fontWeight = String(weight);
  o.style.fontWeight = String(Math.max(100, weight - 100));
  t.style.fontFamily = fam || "";
  t.style.fontSize = `${px}px`;
  t.style.background = bg;
  o.style.fontFamily = fam || "";
  o.style.fontSize = `${Math.round(px * 0.65)}px`;
  o.style.background = bg;
  o.style.display = $("showOriginal").checked ? "block" : "none";
  $("textBgOpacityValue").textContent = on ? `${pct}%` : "关闭";
  $("previewHint").textContent = !inheriting
    ? "背景为模拟的亮画面，实际字号会按视频分辨率缩放。"
    : useNative
      ? `字号按上面读到的网站字号 ${Math.round(nativeFontReading.fontSize)}px 预览（已缩放以适应预览框）。`
      : "跟随网站字号，但当前读不到；播放时将回退到下面的自定义字号。";
}

function applyProviderSwap() {
  const p = $("provider").value;
  const isV2 = p === "google-translate";
  const isLLM = !isV2;

  // Show exactly one of the two blocks.
  $("llmBlock").hidden = !isLLM;
  $("v2Block").hidden = !isV2;
  $("customRow").hidden = p !== "custom";
  $("modelHint").textContent = MODEL_HINTS[p] || "";

  // Populate each block's fields from its own slot in the per-provider maps.
  $("apiKey").value = isLLM ? apiKeys[p] || "" : "";
  $("model").value = isLLM ? models[p] || "" : "";
  if (isLLM) renderModelPresets(p, models[p] || "");
  $("apiKeyV2").value = apiKeys["google-translate"] || "";
}

function renderModelPresets(provider, stored) {
  const sel = $("modelPreset");
  const presets = MODEL_PRESETS[provider] || [];
  sel.innerHTML = "";
  const add = (value, label) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  };
  for (const m of presets) add(m, m);
  add(MODEL_CUSTOM, "自定义…");

  // There is no "use the default" entry: the model is always an explicit
  // choice. A blank stored value (what older installs have) still resolves
  // through PROVIDER_DEFAULT_MODEL in the service worker, so show whichever
  // preset that is — the dropdown then matches what actually gets sent.
  const effective = stored || defaultModels[provider] || presets[0] || "";
  const isPreset = presets.includes(effective);
  const useCustom = !!effective && !isPreset;
  sel.value = useCustom ? MODEL_CUSTOM : isPreset ? effective : MODEL_CUSTOM;
  $("rowModelCustom").hidden = !(useCustom || !isPreset);
}

$("modelPreset").addEventListener("change", (e) => {
  const provider = $("provider").value;
  const custom = e.target.value === MODEL_CUSTOM;
  $("rowModelCustom").hidden = !custom;
  if (custom) {
    $("model").focus();
    return; // keep whatever is already typed; the input owns the value
  }
  models[provider] = e.target.value;
  $("model").value = e.target.value;
  saveField("models", { ...models });
});

async function saveField(key, value) {
  await chrome.runtime.sendMessage({
    type: "setSettings",
    patch: { [key]: value },
  });
  toast("已保存");
}

function bindText(id, key, parse = (v) => v) {
  const el = $(id);
  let timer;
  el.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => saveField(key, parse(el.value)), 300);
  });
}

function bindSelect(id, key, parse = (v) => v) {
  $(id).addEventListener("change", (e) => {
    saveField(key, parse(e.target.value));
    if (id === "provider") applyProviderSwap();
  });
}

function bindCheckbox(id, key) {
  $(id).addEventListener("change", (e) => saveField(key, e.target.checked));
}

// Per-provider save: write to apiKeys[provider] / models[provider].
function bindPerProvider(id, mapRef, mapName) {
  const el = $(id);
  let timer;
  el.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const p = $("provider").value;
      mapRef[p] = el.value;
      saveField(mapName, { ...mapRef });
    }, 300);
  });
}

bindSelect("provider", "provider");

// LLM block: apiKey / model go to the currently-selected provider's slot —
// but only when an LLM provider is actually active.
function bindLLMField(id, mapRef, mapName) {
  const el = $(id);
  let timer;
  el.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const p = $("provider").value;
      if (p === "google-translate") return;
      mapRef[p] = el.value;
      saveField(mapName, { ...mapRef });
    }, 300);
  });
}
bindLLMField("apiKey", apiKeys, "apiKeys");
bindLLMField("model", models, "models");
// While 自定义 is selected the text input owns the value; keep the dropdown
// on 自定义 rather than letting it snap to a preset the user just typed out.
$("model").addEventListener("input", () => {
  if ($("modelPreset").value !== MODEL_CUSTOM) {
    $("modelPreset").value = MODEL_CUSTOM;
  }
});

// Fixed-slot fields — each writes to a specific provider's slot regardless
// of which provider is currently active.
function bindFixedSlot(id, mapRef, mapName, slot) {
  const el = $(id);
  let timer;
  el.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      mapRef[slot] = el.value;
      saveField(mapName, { ...mapRef });
    }, 300);
  });
}
bindFixedSlot("apiKeyV2", apiKeys, "apiKeys", "google-translate");
bindText("customEndpoint", "customEndpoint");
bindText("temperature", "temperature", (v) => Number(v));
bindText("targetLanguage", "targetLanguage");
bindText("contextLines", "contextLines", (v) => Number(v));
bindCheckbox("showOriginal", "showOriginal");
bindCheckbox("enabled", "enabled");
bindCheckbox("debug", "debug");
bindText("fontFamily", "fontFamily");
bindSelect("fontWeight", "fontWeight", (v) => Number(v));
bindText("fontSize", "fontSize", (v) => Number(v));
bindCheckbox("textBgEnabled", "textBgEnabled");
bindText("textBgOpacity", "textBgOpacity", (v) => Number(v));

for (const id of [
  "fontFamily",
  "fontWeight",
  "fontSize",
  "textBgEnabled",
  "textBgOpacity",
  "showOriginal",
]) {
  $(id).addEventListener("input", updateStylePreview);
}

// Show/hide password inputs (shared helper)
function bindPasswordToggle(inputId, btnId) {
  $(btnId).addEventListener("click", () => {
    const input = $(inputId);
    const btn = $(btnId);
    if (input.type === "password") {
      input.type = "text";
      btn.textContent = "隐藏";
    } else {
      input.type = "password";
      btn.textContent = "显示";
    }
  });
}
bindPasswordToggle("apiKey", "toggleApiKey");
bindPasswordToggle("apiKeyV2", "toggleApiKeyV2");

// ---- Skip languages (chips UI) ----
function renderSkipChips() {
  const host = $("skipChips");
  host.innerHTML = "";
  for (const lang of skipLanguages) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = lang;
    const btn = document.createElement("button");
    btn.className = "remove";
    btn.type = "button";
    btn.textContent = "×";
    btn.title = `移除 ${lang}`;
    btn.addEventListener("click", () => {
      const idx = skipLanguages.indexOf(lang);
      if (idx >= 0) {
        skipLanguages.splice(idx, 1);
        saveField("skipLanguages", [...skipLanguages]);
        renderSkipChips();
      }
    });
    chip.appendChild(btn);
    host.appendChild(chip);
  }
  // Mark preset buttons as active if the language is already in the list
  document.querySelectorAll("#skipPresets .preset").forEach((b) => {
    b.classList.toggle("active", skipLanguages.includes(b.dataset.lang));
  });
}

function addSkipLang(lang) {
  const v = (lang || "").trim();
  if (!v) return;
  if (skipLanguages.includes(v)) return;
  skipLanguages.push(v);
  saveField("skipLanguages", [...skipLanguages]);
  renderSkipChips();
}

document.querySelectorAll("#skipPresets .preset").forEach((b) => {
  b.addEventListener("click", () => {
    const lang = b.dataset.lang;
    if (skipLanguages.includes(lang)) {
      // Clicking an active preset removes it
      skipLanguages.splice(skipLanguages.indexOf(lang), 1);
      saveField("skipLanguages", [...skipLanguages]);
    } else {
      skipLanguages.push(lang);
      saveField("skipLanguages", [...skipLanguages]);
    }
    renderSkipChips();
  });
});

$("skipLangAdd").addEventListener("click", () => {
  const input = $("skipLangCustom");
  addSkipLang(input.value);
  input.value = "";
});
$("skipLangCustom").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("skipLangAdd").click();
  }
});

$("providerNoticeDismiss").addEventListener("click", async () => {
  $("providerNotice").hidden = true;
  await saveField("removedProviderNotice", "");
});

$("testBtn").addEventListener("click", async () => {
  const statusEl = $("testStatus");
  statusEl.textContent = "测试中…";
  statusEl.className = "inline-status";
  const resp = await chrome.runtime.sendMessage({
    type: "translate",
    lines: ["Hello, world."],
    history: [],
  });
  if (resp?.ok && resp.translations?.[0]) {
    statusEl.textContent = `✓ 成功: ${resp.translations[0]}`;
    statusEl.className = "inline-status ok";
  } else if (resp?.ok) {
    // The request went through, but the reply was not a usable translation.
    const why = {
      echo: "把原文原样返回了",
      "wrong-language": "回答不是目标语言",
      empty: "没有返回内容",
    }[resp.rejected?.[0]] || "没有返回内容";
    statusEl.textContent =
      `✗ 模型${why}` +
      (resp.raw?.[0] ? `：${resp.raw[0]}` : "") +
      (resp.detail ? `（${resp.detail}）` : "");
    statusEl.className = "inline-status err";
  } else {
    statusEl.textContent = `✗ ${resp?.error || "未知错误"}`;
    statusEl.className = "inline-status err";
  }
});

load();
refreshNativeFont();
