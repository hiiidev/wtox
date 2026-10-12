import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {browserTranslateLanguage,translationTarget,TRANSLATION_LANGUAGES}
  from "../frontend/src/translation.js";

assert.equal(translationTarget("auto","zh-CN"),"zh-CN");
assert.equal(translationTarget("auto","zh-HK"),"zh-TW");
assert.equal(translationTarget("auto","zh-TW"),"zh-TW");
assert.equal(translationTarget("auto","en-US"),"en");
assert.equal(translationTarget("auto","pt-BR"),"pt");
assert.equal(translationTarget("auto","bn-BD"),"bn");
assert.equal(translationTarget("auto","ja-JP"),"ja");
assert.equal(translationTarget("auto","nonsense"),"en");
assert.equal(translationTarget("fr","zh-CN"),"fr");
assert.equal(browserTranslateLanguage("zh_Hant"),"zh-TW");
assert.equal(new Set(TRANSLATION_LANGUAGES.map(x=>x.value)).size,
  TRANSLATION_LANGUAGES.length,"Language option codes must not repeat");

const app=readFileSync("frontend/src/App.jsx","utf8");
const css=readFileSync("frontend/src/refine.css","utf8");
const backend=readFileSync("backend/translate_api.py","utf8");
const main=readFileSync("backend/main.py","utf8");
assert.ok(app.includes("key:\"translate\"") &&
  app.includes('if(key==="translate")void translateMessage(item)'),
  "Right-click text menu should translate, not attachments");
assert.ok(app.includes('aria-label="翻译消息"'),"On-screen touch action required");
assert.ok(app.includes("wt-bubble-footer-stack") &&
  app.includes("wt-translation-result"),
  "Translate below original bubble, preserving original text and time");
assert.ok(app.includes('className="wt-conversation-bubble"')&&
  app.includes('content={String(item.text||"")}'),
  "Encrypted original chat messages must remain unchanged");
assert.ok(app.includes('title="消息翻译"') &&
  app.includes('aria-label="默认翻译语言"'),
  "Translation destination belongs in settings");
assert.ok(app.includes('"wtox-translation-target"') &&
  app.includes('navigator.languages?.[0]||navigator.language'),
  "Default destination must derive from browser locale");
assert.ok(app.includes('api("/api/translate"') &&
  app.includes('method:"POST"'),
  "Only translate a selected message via the authenticated backend");
assert.ok(!app.includes('fetch("https://translate.'),
  "Frontend must never contact Google Translate directly");
assert.ok(app.includes("translationRequests.current.values()") &&
  app.includes("pending.abort()"),
  "Switching chat/identity/target aborts old translation requests");
assert.ok(app.includes('item.type==="file"'),
  "Do not translate file content or thumbnails");
assert.ok(app.includes("该条消息的明文发送到 Google 翻译"),
  "Disclose third-party plaintext transfer before first use");
assert.ok(css.includes(".wt-translation-result")&&
  css.includes('.ant-messenger[data-theme="dark"] .wt-translation-result'),
  "Dark and light translation result panels must have hierarchy");
assert.ok(backend.includes('router.post("/api/translate")')&&
  backend.includes("Depends(require_user)")&&
  backend.includes("check_origin(request)"),
  "Backend endpoint must be authenticated and same-origin");
assert.ok(backend.includes('"sl": "auto"')&&
  backend.includes("_MAX_BODY = 64 * 1024"),"Use automatic source detection and bounded response");
assert.ok(main.includes("app.include_router(translate_router)"));
console.log("Translation language defaults, on-demand UI, privacy and backend route OK");
