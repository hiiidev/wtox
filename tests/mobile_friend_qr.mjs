import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {parseScannedToxId} from "../frontend/src/tox_qr.js";

const toxId="aB".repeat(38);
assert.equal(parseScannedToxId(toxId),toxId.toUpperCase());
assert.equal(parseScannedToxId("  "+toxId+"\n"),toxId.toUpperCase());
assert.equal(parseScannedToxId("tox:"+toxId),toxId.toUpperCase());
assert.equal(parseScannedToxId("tox://"+toxId),toxId.toUpperCase());
for(const invalid of [
 "", "hello", "https://example.com/?id="+toxId, "<script>alert(1)</script>",
 "0".repeat(64),"1".repeat(77),"Z".repeat(76),undefined,null,{},toxId+"\nextra"
]){
 assert.equal(parseScannedToxId(invalid),null,
   `Reject non-Tox QR text: ${String(invalid).slice(0,25)}`);
}
const app=readFileSync("frontend/src/App.jsx","utf8");
const scanner=readFileSync("frontend/src/ToxQRScanner.jsx","utf8");
const refine=readFileSync("frontend/src/refine.css","utf8");
const pkg=JSON.parse(readFileSync("frontend/package.json","utf8"));
assert.equal(pkg.dependencies["@zxing/browser"],"0.2.1");
assert.match(scanner,/import\("@zxing\/browser"\)/,
  "Scanner decoder should load only when scanning is explicitly opened");
assert.match(scanner,/decodeFromConstraints\(/,
  "Use a camera stream and the local QR decoder");
assert.match(scanner,/facingMode:\{ideal:"environment"\}/,
  "Prefer the rear camera on mobile");
assert.match(scanner,/if\(!active\|\|acceptedRef\.current\)controls\.stop\(\)/,
  "A late camera permission grant must not leave a running camera after exit");
assert.match(scanner,/controlsRef\.current\?\.stop\(\)/,
  "Always close camera on scan screen exit");
assert.match(scanner,/track\.stop\(\)/,
  "Release camera tracks, including failed decoder cleanup");
assert.match(scanner,/onScan\(toxId\)/,
  "Scan should only hand a parsed ID to the parent");

assert.ok(app.includes("(isMobile||installedPwa)&&"),
  "Only mobile web and installed PWAs should offer QR scanning");
assert.ok(app.includes("<ToxQRScanner onScan={handleFriendQrScanned}"),
  "Render scanner inside the add friend dialog");
assert.ok(app.includes('const [friendQrOpen,setFriendQrOpen]=useState(false)'));
assert.ok(app.includes('setFriendId(toxId)')&&app.includes('setFriendQrOpen(false)'),
  "A successful scan should populate the form, not submit a request");
assert.match(app,/onCancel=\{closeAddFriend\}/,
  "Closing add-friend modal must reset the form");
assert.match(app,/const closeAddFriend=useCallback\(\(\)=>\{[\s\S]*?setFriendId\(""\);[\s\S]*?setRequestText\("你好，我想添加你为 Tox 好友"\);[\s\S]*?setFriendQrOpen\(false\);/,
  "Reset both user-entered fields and camera state on dismiss");
assert.ok(app.includes("closeAddFriend();"),
  "Success should clear the form too");
assert.ok(app.includes('disabled={!parseScannedToxId(friendId)||!requestText.trim()}'),
  "Prevent sending incomplete or invalid Tox IDs");

assert.ok(refine.includes(".wt-add-friend-modal .wt-qr-video-frame"),
  "Camera preview should be styled");
assert.ok(refine.includes(".wt-add-friend-modal .wt-add-friend-counter"),
  "Text input should show the 76-digit count");
assert.ok(refine.includes("border:0!important;")&&
  refine.includes(".wechat-conversation .wechat-presence.online"),
  "Online dots must not have borders");
assert.ok(!refine.includes(".wechat-conversation.is-selected .wechat-presence.online"),
  "Selected online dots must not add an outline or colored ring");
console.log("Mobile/PWA friend QR scanner, reset-on-close and borderless online indicators OK");
