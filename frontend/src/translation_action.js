/** Translation controls derive their visible action from the current result. */
export function translationAction(entry, text, target) {
  if (!entry || entry.text !== text || entry.target !== target) {
    return {state:"idle",label:"翻译",disabled:false};
  }
  if (entry.status === "loading") {
    return {state:"loading",label:"翻译中…",disabled:true};
  }
  if (entry.status === "error") {
    return {state:"error",label:"重试翻译",disabled:false};
  }
  if (entry.status === "ok") {
    return entry.hidden
      ? {state:"hidden",label:"显示译文",disabled:false}
      : {state:"shown",label:"收起译文",disabled:false};
  }
  return {state:"idle",label:"翻译",disabled:false};
}


/**
 * The inline shortcut is for language, not counters or obvious keyboard mash.
 * These are conservative heuristics, not semantic language classification;
 * users can still explicitly select Translate from the context menu.
 */
export function showQuickTranslate(text) {
  const value=String(text??"").trim();
  if (!value || !/\p{L}/u.test(value)) return false;
  // Keep non-ASCII language scripts, including Chinese/Japanese/Arabic etc.
  if (/[^\x00-\x7F]/u.test(value)) return true;
  const words=value.match(/[a-z]+/gi)||[];
  if (!words.length) return false;
  const noise=word=>{
    const lower=word.toLowerCase();
    if (/^(.)\1{2,}$/.test(lower)) return true;
    if (/^(.{2,3})\1{2,}$/.test(lower)) return true;
    const rows=["qwertyuiop","asdfghjkl","zxcvbnm","abcdefghijklmnopqrstuvwxyz"];
    if (lower.length>=4 && rows.some(row=>
      row.includes(lower)||row.split("").reverse().join("").includes(lower)))return true;
    if (lower.length>=5 && !/[aeiouy]/.test(lower) && word===lower)
      return true;
    return false;
  };
  return words.some(word=>!noise(word));
}
