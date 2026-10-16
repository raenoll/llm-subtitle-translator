const $ = (id) => document.getElementById(id);

function setStatus(text, ok = true) {
  const el = $("status");
  el.textContent = text || "";
  el.style.color = ok ? "" : "#dc2626";
}

async function load() {
  const s = await chrome.runtime.sendMessage({ type: "getSettings" });
  $("enabled").checked = !!s.enabled;
  $("showOriginal").checked = !!s.showOriginal;
  $("provider").value = s.provider || "gemini";
  showOffset(s.subtitleOffset ?? 0);
  // Make sure the target-language option exists, else add it
  const langSel = $("targetLanguage");
  if (![...langSel.options].some((o) => o.value === s.targetLanguage)) {
    const opt = document.createElement("option");
    opt.value = s.targetLanguage;
    opt.textContent = s.targetLanguage;
    langSel.appendChild(opt);
  }
  langSel.value = s.targetLanguage || "简体中文";

  // Keys are stored per provider; `apiKey` is the deprecated single field.
  if (!s.apiKeys?.[s.provider] && !s.apiKey) {
    setStatus("未配置 API key，点击下方打开设置。", false);
  } else {
    // The backend by the name the dropdown shows, not by its internal id.
    const chosen = $("provider").selectedOptions[0];
    setStatus(`已启用 · ${chosen ? chosen.textContent : s.provider}`);
  }
}

async function save(patch) {
  await chrome.runtime.sendMessage({ type: "setSettings", patch });
}

$("enabled").addEventListener("change", (e) =>
  save({ enabled: e.target.checked })
);
$("showOriginal").addEventListener("change", (e) =>
  save({ showOriginal: e.target.checked })
);
$("targetLanguage").addEventListener("change", (e) =>
  save({ targetLanguage: e.target.value })
);
$("provider").addEventListener("change", (e) =>
  save({ provider: e.target.value })
);

// --- Subtitle offset ------------------------------------------------------
// The popup and the settings page edit the same stored value, and each
// follows the other's changes through storage. Seconds, 0.1 s steps.
const OFFSET_LIMIT = 30;

function normalizeOffset(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  const clamped = Math.max(-OFFSET_LIMIT, Math.min(OFFSET_LIMIT, n));
  // Round to the step so repeated ±0.1 never drifts to 0.30000000000000004.
  return Math.round(clamped * 10) / 10;
}

function showOffset(v) {
  $("subtitleOffset").value = normalizeOffset(v).toFixed(1);
}

function saveOffset(v) {
  const n = normalizeOffset(v);
  showOffset(n);
  return save({ subtitleOffset: n });
}

let offsetTimer;
$("subtitleOffset").addEventListener("input", (e) => {
  clearTimeout(offsetTimer);
  if (e.target.value === "" || e.target.value === "-") return; // still typing
  offsetTimer = setTimeout(() => save({ subtitleOffset: normalizeOffset(e.target.value) }), 400);
});
$("subtitleOffset").addEventListener("change", (e) => {
  clearTimeout(offsetTimer);
  saveOffset(e.target.value);
});
document.querySelectorAll(".offset .step").forEach((b) => {
  b.addEventListener("click", () => {
    clearTimeout(offsetTimer);
    const cur = normalizeOffset($("subtitleOffset").value);
    saveOffset(cur + Number(b.dataset.step));
  });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !("subtitleOffset" in changes)) return;
  // Don't overwrite a number the user is in the middle of typing.
  if (document.activeElement === $("subtitleOffset")) return;
  showOffset(changes.subtitleOffset.newValue ?? 0);
});

$("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

load();
