// Service worker: handles LLM API calls so content scripts avoid CORS/key exposure.

const DEFAULT_SETTINGS = {
  provider: "gemini",
  apiKey: "", // DEPRECATED; kept only so existing users' key isn't lost on upgrade
  apiKeys: {
    gemini: "",
    openai: "",
    anthropic: "",
    "google-translate": "",
    "google-translate-v3": "",
    custom: "",
  },
  model: "", // DEPRECATED
  models: {
    gemini: "",
    openai: "",
    anthropic: "",
    "google-translate": "",
    "google-translate-v3": "",
    custom: "",
  },
  googleProjectId: "",
  googleLocation: "us-central1",
  // Languages that should NOT be translated — if a cue's detected language
  // falls into this list, the extension shows the original text as-is.
  skipLanguages: ["简体中文", "繁體中文"],
  targetLanguage: "简体中文",
  showOriginal: true,
  enabled: true,
  customEndpoint: "",
  temperature: 0.2,
  batchSize: 3,
  contextLines: 0,
  debug: false,
  fontFamily: "",
  // 400 (Regular). The old hardcoded 700 resolved to Semibold 600 — PingFang
  // SC's heaviest real face — which is a lot of ink for subtitles. Measured on
  // macOS, 400 paints ~24% less than 600 while the outline and backdrop keep
  // the contrast. Adjustable per user.
  fontWeight: 400,
  // Only the size can follow the player: "platform" reads the size off the
  // site's own cues, "custom" uses fontSize below. The family is never
  // inherited — a Western caption font has no CJK glyphs to lend.
  fontSizeSource: "custom",
  fontSize: 32,
  // Semi-transparent backdrop behind the subtitle text. The outline alone is
  // hard to read over bright scenes, so a faint black box is on by default.
  textBgEnabled: true,
  textBgOpacity: 35, // percent, 0-90
};

// Hard deadline for every outbound request. Without one, a stalled provider
// connection never settles: translate() never resolves, sendResponse is never
// called, and the content script's pending entry for that cue wedges forever —
// that line then silently never translates again, not even on replay.
const REQUEST_TIMEOUT_MS = 20000;

async function fetchWithTimeout(url, options = {}) {
  try {
    // globalThis.fetch, never this wrapper — a blanket rewrite of the call
    // sites once turned this line into infinite recursion.
    return await globalThis.fetch(url, {
      ...options,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new Error(`请求超时（${REQUEST_TIMEOUT_MS / 1000}s 无响应）`);
    }
    throw err;
  }
}

const PROVIDER_DEFAULT_MODEL = {
  // Keep this equal to the first preset offered in the options page: with the
  // "use the default" entry gone, a blank stored value must resolve to the
  // model the dropdown is showing.
  gemini: "gemini-3.8-flash",
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
  custom: "",
  "google-translate": "", // no model selection; Cloud Translation v2
  "google-translate-v3": "general/translation-llm", // Gemini-backed NMT+
};

// Map from the user-facing display language to Google Translate ISO codes.
// If the user types anything else (e.g. a raw ISO code), we pass it through.
const GOOGLE_TRANSLATE_LANG = {
  简体中文: "zh-CN",
  繁體中文: "zh-TW",
  English: "en",
  日本語: "ja",
  한국어: "ko",
  "Español": "es",
  "Français": "fr",
  Deutsch: "de",
  "Português": "pt",
  "Русский": "ru",
};

function googleLangCode(target) {
  if (!target) return "en";
  const t = target.trim();
  if (GOOGLE_TRANSLATE_LANG[t]) return GOOGLE_TRANSLATE_LANG[t];
  // Already looks like an ISO code (en, zh-CN, ja-JP, pt-BR, etc.)
  if (/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(t)) return t;
  return "en";
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

// The target as models read it best: an English name plus the native one.
// "Translate subtitles to 简体中文" inside an otherwise English instruction was
// often answered in English, especially by the fast models.
const TARGET_LANGUAGE_LABELS = {
  "简体中文": "Simplified Chinese (简体中文)",
  "簡體中文": "Simplified Chinese (简体中文)",
  "繁體中文": "Traditional Chinese (繁體中文)",
  "繁体中文": "Traditional Chinese (繁體中文)",
  "日本語": "Japanese (日本語)",
  "한국어": "Korean (한국어)",
  "English": "English",
  "Español": "Spanish (Español)",
  "Français": "French (Français)",
  "Deutsch": "German (Deutsch)",
  "Português": "Portuguese (Português)",
  "Русский": "Russian (Русский)",
};

function languageLabel(target) {
  const t = String(target || "").trim();
  return TARGET_LANGUAGE_LABELS[t] || t;
}

function buildSystemPrompt(targetLanguage, strict = false) {
  // Describe the delimiter in words, never as escape notation: writing the two
  // characters backslash-n into the prompt makes models echo that convention
  // straight back into the cue text.
  const label = languageLabel(targetLanguage);
  const isEnglish = /^english$/i.test(String(targetLanguage || "").trim());
  return (
    `You translate film and TV subtitles into ${label}. ` +
    `Always write the translation in ${label}` +
    (isEnglish ? "" : ", never in English") +
    ` and never in the source language — this holds for names, interjections ` +
    `and very short lines too. Output the translation only, no quotes or ` +
    `explanations. Keep it short. Write plain text with real line breaks — ` +
    `never escape sequences such as a backslash followed by n. If the input ` +
    `holds several cues separated by a line containing only ---, translate ` +
    `each and rejoin them with that same separator line.` +
    (strict
      ? ` Your previous answer was not in ${label}. Answer in ${label} only.`
      : "")
  );
}

// --- Output cleanup -------------------------------------------------------
// Whatever the prompt says, models still slip in escape sequences, wrapping
// quotes and code fences, and Google's endpoints HTML-escape apostrophes even
// with format:text. None of that is translated text, so strip it before it
// can reach the overlay.

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
};

function decodeHtmlEntities(s) {
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === "#") {
      const hex = ent[1] === "x" || ent[1] === "X";
      const code = parseInt(hex ? ent.slice(2) : ent.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0) return m;
      try {
        return String.fromCodePoint(code);
      } catch (_) {
        return m;
      }
    }
    const hit = NAMED_ENTITIES[ent.toLowerCase()];
    return hit === undefined ? m : hit;
  });
}

// Turn literal escape sequences (the two characters backslash + n) into the
// whitespace they stand for. Runs on its own before the delimiter split, so a
// model that wrote the separator in escaped form still parses correctly.
function unescapeLiterals(s) {
  return s
    .replace(/\\{1,2}r\\{1,2}n/g, "\n")
    .replace(/\\{1,2}[nr]/g, "\n")
    .replace(/\\{1,2}t/g, " ")
    .replace(/\\(["'\\])/g, "$1");
}

function sanitizeTranslation(text) {
  let s = unescapeLiterals(String(text ?? ""));
  if (!s.trim()) return "";
  // Markdown code fence around the whole reply.
  s = s.replace(/^\s*```[a-zA-Z]*\s*\n?/, "").replace(/\n?\s*```\s*$/, "");
  s = decodeHtmlEntities(s);
  // Leftover separator lines at either end (a cue never starts or ends with
  // one; interior "---" is left alone in case it's real dialogue punctuation).
  s = s.replace(/^(?:\s*-{3,}\s*\n)+/, "").replace(/(?:\n\s*-{3,}\s*)+$/, "");
  // A single pair of straight quotes the model wrapped around everything.
  // Only when there are none inside, so real quoted dialogue survives.
  const quoted = s.trim().match(/^"([^"]*)"$/);
  if (quoted) s = quoted[1];
  // Tidy spacing without collapsing the cue's own line breaks.
  return s
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// Character counters for judging whether a reply is in the target language.
const SCRIPT_RE = {
  cjk: /[\u3400-\u9FFF\uF900-\uFAFF]/g,
  kana: /[\u3040-\u30FF]/g,
  hangul: /[\uAC00-\uD7AF]/g,
  cyrillic: /[\u0400-\u04FF]/g,
  greek: /[\u0370-\u03FF]/g,
  latin: /[A-Za-z]/g,
};
const countMatches = (text, re) => (String(text || "").match(re) || []).length;

// Which script a translation into `target` must contain. null for targets
// written in Latin letters, where English cannot be told apart cheaply.
function targetScript(target) {
  const t = String(target || "").trim().toLowerCase();
  if (/中文|chinese|^zh/.test(t)) return "cjk";
  if (/日本語|日本语|日语|日文|japanese|^ja/.test(t)) return "ja";
  if (/한국어|韩语|韓語|korean|^ko/.test(t)) return "hangul";
  if (/русский|russian|^ru/.test(t)) return "cyrillic";
  if (/ελληνικά|greek|^el/.test(t)) return "greek";
  return null;
}

// true = in the target language, false = clearly not, null = can't tell.
// `source` is the line that was translated: Latin text the model copied from
// it (a name, "NASA", "OK") is fine, Latin text it made up is English.
function replyInTargetLanguage(reply, target, source = "") {
  const script = targetScript(target);
  if (!script || !reply) return null;
  if (script === "cjk") {
    // Chinese never contains kana: kana means the model answered in Japanese.
    if (countMatches(reply, SCRIPT_RE.kana) > 0) return false;
    if (countMatches(reply, SCRIPT_RE.cjk) > 0) return true;
  } else if (script === "ja") {
    if (countMatches(reply, SCRIPT_RE.kana) + countMatches(reply, SCRIPT_RE.cjk) > 0) return true;
  } else if (countMatches(reply, SCRIPT_RE[script]) > 0) {
    return true;
  }
  // No target-script characters at all. Judge the Latin words in the reply
  // against the source instead of by count — short interjections ("I see.",
  // "Yes.") are exactly where models slip into English, so a length cutoff
  // would let the commonest case through.
  const words = String(reply).match(/[A-Za-z]+/g) || [];
  if (!words.length) return null; // digits or punctuation only
  const sourceWords = new Set(
    (String(source).match(/[A-Za-z]+/g) || []).map((w) => w.toLowerCase())
  );
  if (!words.every((w) => sourceWords.has(w.toLowerCase()))) return false;
  // Everything was copied from the source. A name or two is fine; a whole
  // line of it is an English source line echoed back untranslated.
  return words.length >= 3 ? false : null;
}

function buildContextBlock(history, targetLanguage) {
  if (!history || history.length === 0) return "";
  const lines = history
    .map((h) => `- ${h.source}  →  ${h.translation}`)
    .join("\n");
  return `Recent translated lines (for tone and continuity, do NOT re-translate these):\n${lines}\n\nNow translate the following into ${targetLanguage}:\n`;
}

async function callGemini({ apiKey, model, system, user, temperature }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      temperature,
      responseMimeType: "text/plain",
    },
  };
  const res = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("").trim();
}

async function callOpenAICompatible({
  apiKey,
  model,
  system,
  user,
  temperature,
  endpointOverride,
}) {
  const endpoint =
    endpointOverride || "https://api.openai.com/v1/chat/completions";
  const body = {
    model,
    temperature,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  const res = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data?.choices?.[0]?.message?.content || "").trim();
}

async function callGoogleTranslate({ apiKey, targetCode, lines }) {
  const endpoint = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(
    apiKey
  )}`;
  const body = {
    q: lines,
    target: targetCode,
    format: "text",
  };
  const res = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Translate ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const arr = data?.data?.translations || [];
  return arr.map((t) => (t.translatedText || "").trim());
}

// --- Google Cloud OAuth2 JWT grant (for Translate v3) ---
// The service worker keeps the most recent access token in memory and reuses
// it until ~60s before expiry. Tokens last 1h; re-signing is cheap anyway.
let v3TokenCache = null; // { accessToken, expiresAt, saFingerprint }

function b64urlEncode(bytesOrString) {
  const s =
    typeof bytesOrString === "string"
      ? btoa(unescape(encodeURIComponent(bytesOrString)))
      : btoa(String.fromCharCode(...bytesOrString));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function pemToPkcs8(pem) {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const raw = atob(body);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

async function getV3AccessToken(serviceAccountJson) {
  let sa;
  try {
    sa = JSON.parse(serviceAccountJson);
  } catch (e) {
    throw new Error(
      "Service Account JSON 解析失败，请粘贴完整的 .json 文件内容。"
    );
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error(
      "Service Account JSON 缺字段（需要 client_email / private_key）。"
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const fingerprint = `${sa.client_email}:${sa.private_key_id || ""}`;
  if (
    v3TokenCache &&
    v3TokenCache.saFingerprint === fingerprint &&
    v3TokenCache.expiresAt - 60 > now
  ) {
    return { accessToken: v3TokenCache.accessToken, projectId: sa.project_id };
  }

  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-translation",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const signingInput = `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(
    JSON.stringify(claim)
  )}`;

  const keyBuf = pemToPkcs8(sa.private_key);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyBuf,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );
  const jwt = `${signingInput}.${b64urlEncode(new Uint8Array(sigBuf))}`;

  const tokRes = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:
      `grant_type=${encodeURIComponent(
        "urn:ietf:params:oauth:grant-type:jwt-bearer"
      )}&assertion=${encodeURIComponent(jwt)}`,
  });
  if (!tokRes.ok) {
    const text = await tokRes.text();
    throw new Error(
      `OAuth2 token exchange ${tokRes.status}: ${text.slice(0, 300)}`
    );
  }
  const tok = await tokRes.json();
  v3TokenCache = {
    accessToken: tok.access_token,
    expiresAt: now + (tok.expires_in || 3600),
    saFingerprint: fingerprint,
  };
  return { accessToken: tok.access_token, projectId: sa.project_id };
}

async function callGoogleTranslateV3({
  serviceAccountJson,
  projectIdOverride,
  location,
  model,
  targetCode,
  lines,
}) {
  const { accessToken, projectId: saProject } = await getV3AccessToken(
    serviceAccountJson
  );
  const projectId = projectIdOverride || saProject;
  if (!projectId) {
    throw new Error(
      "Project ID 未知（Service Account JSON 里没有 project_id，也未手动填写）。"
    );
  }
  const loc = location || "us-central1";
  const endpoint = `https://translation.googleapis.com/v3/projects/${encodeURIComponent(
    projectId
  )}/locations/${encodeURIComponent(loc)}:translateText`;
  const body = {
    contents: lines,
    targetLanguageCode: targetCode,
    mimeType: "text/plain",
  };
  const m = (model || "").trim();
  if (m) {
    body.model = m.startsWith("projects/")
      ? m
      : `projects/${projectId}/locations/${loc}/models/${m}`;
  }
  const res = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Google Translate v3 ${res.status}: ${text.slice(0, 300)}`
    );
  }
  const data = await res.json();
  const arr = data?.translations || [];
  return arr.map((t) => (t.translatedText || "").trim());
}

async function callAnthropic({ apiKey, model, system, user, temperature }) {
  const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      temperature,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const parts = data?.content || [];
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("")
    .trim();
}

async function translate({ lines, history }) {
  const settings = await getSettings();
  const apiKey =
    settings.apiKeys?.[settings.provider] || settings.apiKey || "";
  if (!apiKey) {
    throw new Error(
      `${settings.provider} 的 API key 未设置，请先在扩展选项里填写。`
    );
  }

  // Google Translate has a totally different shape (no prompt, takes an
  // array of strings, returns an array of strings), so we short-circuit.
  if (settings.provider === "google-translate") {
    const targetCode = googleLangCode(settings.targetLanguage);
    const translations = await callGoogleTranslate({
      apiKey,
      targetCode,
      lines,
    });
    if (translations.length === lines.length)
      return translations.map(sanitizeTranslation);
    return lines.map((_, i) => sanitizeTranslation(translations[i] || ""));
  }
  if (settings.provider === "google-translate-v3") {
    const targetCode = googleLangCode(settings.targetLanguage);
    const model =
      settings.models?.["google-translate-v3"] ||
      PROVIDER_DEFAULT_MODEL["google-translate-v3"];
    const translations = await callGoogleTranslateV3({
      // For v3 we store the Service Account JSON in the per-provider apiKey slot.
      serviceAccountJson: apiKey,
      projectIdOverride: settings.googleProjectId || "",
      location: settings.googleLocation || "us-central1",
      model,
      targetCode,
      lines,
    });
    if (translations.length === lines.length)
      return translations.map(sanitizeTranslation);
    return lines.map((_, i) => sanitizeTranslation(translations[i] || ""));
  }

  const model =
    settings.models?.[settings.provider] ||
    settings.model ||
    PROVIDER_DEFAULT_MODEL[settings.provider];
  const label = languageLabel(settings.targetLanguage);
  const contextBlock = buildContextBlock(history, label);
  // Name the target in the user turn too: some models weigh the system
  // instruction lightly, and a bare line of Japanese as the entire user
  // message was often answered in English.
  const lead = contextBlock || `Translate into ${label}:\n`;
  const user = lead + lines.join("\n---\n");

  const request = async (strict) => {
    const common = {
      apiKey,
      model,
      system: buildSystemPrompt(settings.targetLanguage, strict),
      user,
      temperature: Number(settings.temperature) || 0.2,
    };

    let output;
    switch (settings.provider) {
      case "gemini":
        output = await callGemini(common);
        break;
      case "openai":
        output = await callOpenAICompatible(common);
        break;
      case "anthropic":
        output = await callAnthropic(common);
        break;
      case "custom":
        if (!settings.customEndpoint) {
          throw new Error("自定义 provider 需要填写 endpoint URL。");
        }
        output = await callOpenAICompatible({
          ...common,
          endpointOverride: settings.customEndpoint,
        });
        break;
      default:
        throw new Error(`未知 provider: ${settings.provider}`);
    }

    // Unescape first: a model that wrote the separator as escape notation
    // would otherwise fail the split and send every cue back for a retry.
    const cleaned = unescapeLiterals(output);
    const parts = cleaned.split(/\n\s*-{3,}\s*\n/);
    if (parts.length === lines.length) return parts.map(sanitizeTranslation);
    // Single-cue path: no delimiter needed, output is the translation as-is.
    if (lines.length === 1) return [sanitizeTranslation(cleaned)];
    // Multi-cue batch where the model didn't respect our delimiter: we can't
    // safely reassign output lines to inputs (the old byLine fallback happily
    // treated untranslated source lines as "translations"). Return empty so
    // the retry timer re-dispatches these cues individually.
    return lines.map(() => "");
  };

  // A reply in the wrong language (in practice, English) is re-asked ONCE with
  // a firmer instruction. Not in a loop, and never by returning empty: the
  // content script immediately re-queues cues that come back empty, so failing
  // here would turn one stubborn line into an endless stream of API calls.
  const target = settings.targetLanguage;
  const isWrong = (t, i) => replyInTargetLanguage(t, target, lines[i]) === false;
  let translations = await request(false);
  let wrongLanguage = translations.map(isWrong);
  let retriedForLanguage = false;
  if (wrongLanguage.some(Boolean)) {
    retriedForLanguage = true;
    try {
      const again = await request(true);
      translations = translations.map((t, i) =>
        wrongLanguage[i] && again[i] && !isWrong(again[i], i) ? again[i] : t
      );
    } catch (_) {
      // Keep the first answers if the retry itself fails.
    }
    wrongLanguage = translations.map(isWrong);
  }
  return { translations, retriedForLanguage, wrongLanguage };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "translate") {
    translate({ lines: msg.lines, history: msg.history })
      .then((r) =>
        sendResponse(
          Array.isArray(r) ? { ok: true, translations: r } : { ok: true, ...r }
        )
      )
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true; // async
  }
  if (msg?.type === "getSettings") {
    // Ship the fallback table along with the settings so the options page can
    // name the concrete model instead of saying a vague "default" — and so it
    // never has to keep its own copy that could drift from this one.
    getSettings().then((s) =>
      sendResponse({ ...s, defaultModels: { ...PROVIDER_DEFAULT_MODEL } })
    );
    return true;
  }
  if (msg?.type === "setSettings") {
    chrome.storage.sync.set(msg.patch || {}).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "ping") {
    sendResponse({ ok: true });
    return false;
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(null);
  const merged = { ...DEFAULT_SETTINGS, ...current };
  // Ensure the per-provider objects exist and include every known provider
  // (even if older builds stored a subset).
  merged.apiKeys = { ...DEFAULT_SETTINGS.apiKeys, ...(merged.apiKeys || {}) };
  merged.models = { ...DEFAULT_SETTINGS.models, ...(merged.models || {}) };
  // Migration: if the user had a single `apiKey` / `model` from a previous
  // build, carry it into the current provider's slot so they don't lose it.
  const p = merged.provider;
  if (p && merged.apiKey && !merged.apiKeys[p]) merged.apiKeys[p] = merged.apiKey;
  if (p && merged.model && !merged.models[p]) merged.models[p] = merged.model;
  // Migration: `fontSource` used to control family+size together; it now
  // applies to the size alone under a clearer name.
  if (current.fontSource && !current.fontSizeSource) {
    merged.fontSizeSource = current.fontSource;
  }
  delete merged.fontSource;
  await chrome.storage.sync.set(merged);
});
