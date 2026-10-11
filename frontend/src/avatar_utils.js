/** Stable, per-identity avatar palette. Colors are assigned once and stored
 *  with non-secret public keys only; Ant Design Avatar handles text scaling.
 */
export const AVATAR_PALETTE = [
  "#5674B9","#347F91","#6E6AAF","#AF665C","#6C8C52",
  "#9C68A9","#587F6C","#A47740","#7E699B","#B36C83",
  "#4977A6","#868C4B"
];

export function avatarLabel(name, fallback="") {
  const text=String(name||"").trim();
  if(!text)return String(fallback||"?").slice(0,1).toUpperCase();
  const symbols=Array.from(text);
  // Chinese and non-Latin names look best with a single readable glyph.
  if(symbols.some(ch=>ch.codePointAt(0)>0x7f))return symbols[0];
  // Ant Design Avatar auto-scales 1–2 letters with its "gap" prop.
  const words=text.split(/\s+/);
  if(words.length>1)return (words[0].slice(0,1)+words[1].slice(0,1)).toUpperCase();
  return symbols.slice(0,2).join("").toUpperCase();
}
export function avatarFallbackColor(key) {
  let hash=2166136261;
  for(const ch of String(key||""))hash=Math.imul(hash^ch.charCodeAt(0),16777619);
  return AVATAR_PALETTE[(hash>>>0)%AVATAR_PALETTE.length];
}

export function ensureAvatarColors(identity,publicKeys,storage,randomIndex) {
  if(!identity)return {};
  const storeKey="wtox-avatar-colors-"+identity;
  let saved={};
  try {
    const parsed=JSON.parse(storage?.getItem(storeKey)||"{}");
    if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))saved=parsed;
  } catch {}
  let changed=false;
  for(const key of publicKeys) {
    if(typeof key!=="string"||!/^[A-Fa-f0-9]{64}$/.test(key))continue;
    if(AVATAR_PALETTE.includes(saved[key]))continue;
    const n=randomIndex?randomIndex():
      crypto.getRandomValues(new Uint32Array(1))[0];
    saved[key]=AVATAR_PALETTE[(n>>>0)%AVATAR_PALETTE.length];
    changed=true;
  }
  if(changed) {
    try{storage?.setItem(storeKey,JSON.stringify(saved))}catch{}
  }
  return saved;
}
