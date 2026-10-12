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
