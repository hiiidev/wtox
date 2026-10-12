import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const app=readFileSync("frontend/src/App.jsx","utf8");
const api=readFileSync("frontend/src/api.js","utf8");
const style=readFileSync("frontend/src/refine.css","utf8");
const env=readFileSync(".env.example","utf8");
const server=readFileSync("backend/main.py","utf8");
const websocket=readFileSync("backend/tox_api.py","utf8");
const gate=readFileSync("backend/access.py","utf8");

assert.ok(app.includes('getJson("/api/gate/status"'),
  "Check site access before attempting to load any Tox identity");
assert.ok(app.includes('status.required&&!status.authorized'),
  "Do not expose the Tox authentication form until gate authorization");
assert.ok(app.includes('postJson("/api/gate/login",{password:sitePasswordInput})'));
assert.ok(app.includes('siteGate==="locked"')&&app.includes('wt-site-gate-card'),
  "Render a separate site password screen");
assert.ok(app.includes('autoComplete="current-password"')&&
  app.includes('placeholder="请输入访问密码"'),
  "Use a password field with password-manager-compatible autocomplete");
const siteMarkup=app.slice(app.indexOf('if(siteGate==="locked")'),
  app.indexOf('if(bootstrapError)return'));
assert.ok(!/6位|六位|至少6|最短|minimum|minLength=\{6\}/.test(siteMarkup),
  "Do not hint at the configured six-character minimum on the password screen");
assert.ok(siteMarkup.includes('value={sitePasswordInput}') &&
  siteMarkup.includes('onFinish={enterSite}'),
  "Submission must use React state and not persist plaintext credentials");
assert.ok(app.includes('setSitePasswordInput("")') &&
  !app.includes('localStorage.setItem("wtox-site-password"'),
  "Never store the entry password in localStorage");
assert.ok(app.includes('window.addEventListener("wtox-site-locked",locked)'));
assert.ok(api.includes("error.accessRequired=accessRequired") &&
  api.includes('window.dispatchEvent(new Event("wtox-site-locked"))'),
  "Expired/revoked access should return the user to the password form");
assert.ok(style.includes(".wt-site-gate-card"),"Gate needs responsive theme styling");

assert.ok(env.includes("WTOX_ACCESS_PASSWORD="));
assert.ok(server.includes('"/api/gate/status"') &&
  server.includes('"/api/gate/login"'));
assert.ok(server.includes('class SiteGateMiddleware(BaseHTTPMiddleware)'));
assert.ok(server.includes('request.cookies.get(access.COOKIE_NAME)'));
assert.ok(websocket.includes("access.gate_authorized(ws.cookies.get(access.COOKIE_NAME))"),
  "WebSocket bypasses HTTP middleware, must independently check site access");
assert.ok(gate.includes("REMEMBER_SECONDS = 10 * 365 * 86400") &&
  gate.includes("def issue_access_cookie(password: str)") &&
  gate.includes('payload = f"v2.{nonce}"'),
  "Persistent signed tokens must not use a 30-day expiry");
assert.ok(gate.includes('samesite')===false,
  "Cookie attributes are set only by the API handler");
assert.ok(server.includes('samesite="strict"')&&server.includes("httponly=True"),
  "Site access needs Strict HttpOnly cookies");

console.log("ENV site password gate, persistent cookie and Tox/WebSocket separation verified");
