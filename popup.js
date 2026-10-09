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

$("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

load();
