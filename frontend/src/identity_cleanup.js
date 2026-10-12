/** Erase only the chosen Tox identity's device-local browser data.
 * Account, friends and encrypted Tox keys on the VPS are NOT touched.
 * Global theme and other identities' preferences are preserved.
 */
export async function clearIdentityBrowserData(owner, {
  db=indexedDB, storage=localStorage
}={}){
  if(typeof owner!=="string"||!/^[a-fA-F0-9]{64}$/.test(owner)){
    throw new Error("无效的 Tox 身份，已拒绝清除数据");
  }
  const name="wtox-local-"+owner;
  await new Promise((resolve,reject)=>{
    const req=db.deleteDatabase(name);
    req.onsuccess=()=>resolve();
    req.onerror=()=>reject(req.error||new Error("删除身份历史失败"));
    req.onblocked=()=>reject(new Error("其他网页仍占用该身份的本地数据库，请关闭其他 wTox 标签页后重试"));
  });
  // Only remove identity-specific preferences AFTER the database is gone.
  storage.removeItem("wtox-avatar-colors-"+owner);
  storage.removeItem("wtox-seen-"+owner);
  storage.removeItem("wtox-pwa-push-prompt-"+owner);
}
