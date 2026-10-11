import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const app=readFileSync("frontend/src/App.jsx","utf8");
const refined=readFileSync("frontend/src/refine.css","utf8");
const entry=readFileSync("frontend/src/main.jsx","utf8");
const pkg=JSON.parse(readFileSync("frontend/package.json","utf8"));

assert.ok(pkg.dependencies["@ant-design/x"]&&pkg.dependencies.antd);
assert.match(entry,/import "\.\/refine\.css"/);
assert.match(app,/visualStyle==="system"/);
assert.match(app,/matchMedia\("\(prefers-color-scheme: dark\)"\)/);
assert.match(app,/options=\{\[\{label:"跟随系统",value:"system"\}/);
assert.doesNotMatch(app,/风格只保存在当前浏览器|消息传输/);
assert.ok(app.includes('setModal("");')&&app.includes('alert("Tox 个人资料已保存")'),
  "Saving the native profile should close the popup");
const profileStart=app.indexOf('{modal==="profile"&&');
const settingsStart=app.indexOf('{modal==="settings"&&',profileStart);
assert.ok(profileStart>0&&settingsStart>profileStart);
assert.doesNotMatch(app.slice(profileStart,settingsStart),/wtox-profile-header/);
assert.match(app,/className="wt-mobile-me-page"/);
assert.match(app,/aria-label="设置"/);
assert.doesNotMatch(app,/查看并修改我的 Tox 资料/);
assert.match(app,/prefix=\{<Tooltip title="添加附件">/);
assert.match(app,/<Sender\.Header title="准备发送附件"/);
assert.match(app,/<FileCard name=\{uploadFile\.name\}/);
assert.match(app,/onPasteFile=\{files=>/);
assert.match(app,/<input type="file" hidden ref=\{attachmentInput\}/);
assert.match(app,/await h\.persistFile\(transfer\)/);
assert.match(app,/await h\.cacheImage\(transfer\.id/);
assert.match(app,/<FileCard name=\{file\.file_name\}/);
assert.match(app,/<Image className="wtox-attachment-image"/);
assert.match(refined,/max-width:none!important/);
assert.ok(refined.includes("wt-message-outgoing") &&
  refined.includes("justify-content:flex-end"),
  "Outgoing messages should align to the right");
assert.match(refined,/background:var\(--wt-bg\)/);
assert.match(refined,/scrollbar-gutter:stable/);
console.log("System themes, settings, Sender attachments, timeline images and token-based layout checks OK");

assert.match(app,/aria-label="好友请求"/);
assert.match(app,/onClick=\{\(\)=>setModal\("requests"\)\}/);
assert.match(app,/friend\.status_message\?\.trim\(\)/);
assert.match(app,/avatarLabel\(ownProfile\.name\|\|"我",user\.public_key\)/);
assert.match(app,/selectedMessageIds\.size>0/);
assert.match(app,/onClickCapture=\{event=>messageSelectionClick\(event,item\.id\)\}/);
assert.match(app,/wt-empty-conversation/);
assert.match(refined,/\.wt-batch-toolbar/);
assert.match(refined,/html\[data-wtox-theme="light"\]/);
assert.match(refined,/html\[data-wtox-theme="dark"\]/);
assert.match(refined,/\.wt-message-row \.ant-bubble-content/);

assert.doesNotMatch(app,/对方离线，VPS 已准备好离线队列/);
assert.match(app,/\(f\.name\|\|""\)\.toLocaleLowerCase\(\)\.includes\(filter\.trim\(\)\.toLocaleLowerCase\(\)\)/);
assert.doesNotMatch(app,/\(f\.name\|\|""\)\+" "\+f\.public_key/);
for(const variable of ["--wt-rail","--wt-sidebar","--wt-chat","--wt-search","--wt-own-text"]){
  assert.ok(app.includes(variable),"Missing messenger palette variable: "+variable);
}
assert.match(refined,/scrollbar-gutter:stable/);
assert.match(refined,/scrollbar-color:transparent transparent/);
assert.match(refined,/\.ant-messenger\[data-theme\] \.wt-thread-shell>\.ant-thread/);
assert.match(refined,/\.ant-messenger\[data-theme\] \.wechat-conversation\.is-selected/);
assert.match(refined,/max-width:none!important;\s*margin-inline:0!important/);
assert.match(refined,/background:var\(--wt-chat\)!important/);

assert.match(app,/aria-label="更多操作"/);
assert.match(app,/label:"删除好友",danger:true/);
assert.match(app,/open=\{deleteFriendOpen&&!!selectedFriend\}/);
assert.match(app,/okButtonProps=\{\{danger:true,loading:removingFriend\}\}/);
assert.doesNotMatch(app,/if\(!selected\|\|!confirm\(/);
assert.match(app,/--wt-scroll-thumb/);
assert.match(app,/--wt-scroll-hover/);
assert.match(refined,/scrollbar-color:var\(--wt-scroll-thumb\)/);
assert.match(refined,/scrollbar-color:var\(--wt-scroll-hover\)/);
assert.match(refined,/\.wt-chat-more-button\.ant-btn/);


assert.match(app,/message\.useMessage\(\{top:24,maxCount:2\}\)/);
assert.match(app,/duration:0/);
assert.match(app,/dismissedFriendIds\.current=signature/);
assert.match(app,/aria-label="关闭好友请求提示"/);
assert.match(app,/color="#ef4444"/);
assert.match(app,/kind="chats"/);
assert.match(app,/kind="contacts"/);
assert.match(app,/kind="settings"/);
assert.doesNotMatch(app,/<MessageOutlined\/><span>聊天<\/span>\s*<\/button>\s*<button/);
assert.match(app,/className="wt-peer-profile-presence"/);
assert.match(refined,/\.wt-peer-avatar-button\.ant-btn:active/);
assert.match(refined,/\.wt-select-indicator\{display:none!important;\}/);
assert.match(app,/\/"api\/tox\/create",\{method:"POST",/);
assert.match(app,/password:createPassword/);
assert.match(app,/X-Tox-Password-Bytes/);
assert.match(app,/password:backupPassword/);
assert.match(app,/\.\/api\/profile\/export\/encrypted/);
