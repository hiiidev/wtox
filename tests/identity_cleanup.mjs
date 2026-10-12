import assert from "node:assert/strict";
import {clearIdentityBrowserData} from "../frontend/src/identity_cleanup.js";

const own="A".repeat(64),other="B".repeat(64);
const values=new Map([
  ["wtox-avatar-colors-"+own,"my-color"],
  ["wtox-avatar-colors-"+other,"peer-color"],
  ["wtox-seen-"+own,"my-read"],
  ["wtox-seen-"+other,"peer-read"],
  ["wtox-visual-style","dark"]
]);
const storage={
  getItem:key=>values.get(key),
  removeItem:key=>values.delete(key)
};
const deleted=[];
const db={deleteDatabase(name){
  deleted.push(name);
  const request={};
  queueMicrotask(()=>request.onsuccess());
  return request;
}};
await clearIdentityBrowserData(own,{db,storage});
assert.deepEqual(deleted,["wtox-local-"+own]);
assert.ok(!values.has("wtox-avatar-colors-"+own));
assert.ok(!values.has("wtox-seen-"+own));
assert.equal(values.get("wtox-avatar-colors-"+other),"peer-color");
assert.equal(values.get("wtox-seen-"+other),"peer-read");
assert.equal(values.get("wtox-visual-style"),"dark");

await assert.rejects(
  clearIdentityBrowserData("../unsafe",{db,storage}),/无效/);
assert.deepEqual(deleted,["wtox-local-"+own],"Reject malformed IDs before deleting anything");

const blockedValues=new Map([["wtox-seen-"+own,"do-not-drop"]]);
const blockedDb={deleteDatabase(){
  const request={};
  queueMicrotask(()=>request.onblocked());
  return request;
}};
await assert.rejects(
  clearIdentityBrowserData(own,{db:blockedDb,storage:{
    removeItem:key=>blockedValues.delete(key)
  }}),/其他网页/);
assert.equal(blockedValues.get("wtox-seen-"+own),"do-not-drop",
  "Never remove preferences when IndexedDB deletion did not finish");
console.log("Selective Tox identity browser data removal verified");
