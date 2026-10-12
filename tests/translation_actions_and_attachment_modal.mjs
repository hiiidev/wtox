import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {translationAction} from "../frontend/src/translation_action.js";

const text="Hello",target="zh-CN";
assert.deepEqual(translationAction(null,text,target),
  {state:"idle",label:"翻译",disabled:false});
assert.equal(translationAction({text:"different",target,status:"ok",hidden:false},text,target).label,"翻译");
assert.equal(translationAction({text,target:"en",status:"ok"},text,target).label,"翻译");
assert.deepEqual(translationAction({text,target,status:"loading"},text,target),
  {state:"loading",label:"翻译中…",disabled:true});
assert.equal(translationAction({text,target,status:"error"},text,target).label,"重试翻译");
assert.equal(translationAction({text,target,status:"ok",hidden:false},text,target).label,"收起译文");
assert.equal(translationAction({text,target,status:"ok",hidden:true},text,target).label,"显示译文");

const app=readFileSync("frontend/src/App.jsx","utf8");
const css=readFileSync("frontend/src/refine.css","utf8");
const assertContains=x=>assert.ok(app.includes(x),"Missing "+x);
assertContains('key:"translate",label:translationActionFor(item).label');
assertContains('disabled:translationActionFor(item).disabled');
assertContains('title={action.label} aria-label={action.label}');
assertContains('disabled={action.disabled}');
assertContains('translationActionIcon(action)');
assertContains('if(action.state==="loading")return <LoadingOutlined spin/>');
assertContains('if(action.state==="shown")return <EyeInvisibleOutlined/>');
assertContains('if(action.state==="hidden")return <EyeOutlined/>');
assertContains('if(action.state==="error")return <RedoOutlined/>');
assert.ok(!app.includes("翻译 / 收起译文"));
assertContains('<AntModal open={!!uploadFile} title="准备发送附件" centered');
assert.ok(!app.includes("<Sender.Header"),"Composer should not expand into a file form");
assertContains('onClick={sendFile}>发送附件</AntButton>');
assertContains('onCancel={()=>{if(!busy)setUploadFile(null)}}');
assertContains('closable={!busy} maskClosable={!busy}');
assertContains('formatAttachmentSize(uploadFile.size)');
assertContains("processed.size>MAX_ATTACHMENT_BYTES");
assertContains("file.size>MAX_SOURCE_PHOTO_BYTES");
assertContains("await sanitizePhoto(file)");
assertContains('setUploadFile(null);');
assert.ok(css.includes(".wt-attachment-modal .wt-send-file-preview"));
console.log("State-aware translation actions and attachment send modal verified");
