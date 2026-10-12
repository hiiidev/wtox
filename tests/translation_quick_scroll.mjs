import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {showQuickTranslate} from "../frontend/src/translation_action.js";
for (const value of [
  "", "  ", "123456", "2026/10/13 12:30", "-45.20%", "￥100", "🙃🙃",
  "aaaaaaa", "kkkkk", "abababab", "abcabcabc",
  "qwerty", "asdfgh", "zxcvbn", "abcdefg", "xjkwpm"
]) assert.equal(showQuickTranslate(value),false,
  "Should not show inline quick Translate for: "+value);
for(const value of [
  "Hello", "hi", "I", "a", "OK", "thanks", "Translation",
  "Hello world", "你好", "下午好", "こんにちは", "مرحبا", "Привет", "2026年"
]) assert.equal(showQuickTranslate(value),true,
  "Keep translations discoverable for: "+value);

const app=readFileSync("frontend/src/App.jsx","utf8");
assert.ok(app.includes("showQuickTranslate(item.text)&&"),
  "Only inline button is filtered");
assert.ok(app.includes('key:"translate",label:translationActionFor(item).label'),
  "Explicit right-click translate remains available regardless of heuristic");
assert.ok(app.includes("translationBottomPending.current={peer,id:String(item.id)}"),
  "Remember when the user translates the final message");
assert.ok(app.includes("String(thread[thread.length-1]?.id)!==pending.id"),
  "Translating an older message must not force bottom");
assert.ok(app.includes("if(result.status===\"ok\" || result.status===\"error\")"),
  "Scroll after final translation, including long results");
assert.ok(app.includes("followLatest.current=true;"));
assert.ok(app.includes("settleThreadBottom();"));
assert.ok(app.includes("const second=requestAnimationFrame("),
  "Late DOM layout should still settle the true bottom");
assert.ok(app.includes("observer.observe(content)"),
  "Translation panel growth triggers bottom scroll when following latest");
console.log("Noise filtering and last translation bottom-scrolling wiring OK");
