/** Translation target languages used by Google Translate. */
export const TRANSLATION_LANGUAGES=[
  {value:"auto",label:"跟随浏览器"},
  {value:"zh-CN",label:"简体中文"},
  {value:"zh-TW",label:"繁體中文"},
  {value:"en",label:"English"},
  {value:"ja",label:"日本語"},
  {value:"ko",label:"한국어"},
  {value:"fr",label:"Français"},
  {value:"de",label:"Deutsch"},
  {value:"es",label:"Español"},
  {value:"pt",label:"Português"},
  {value:"ru",label:"Русский"},
  {value:"it",label:"Italiano"},
  {value:"ar",label:"العربية"},
  {value:"hi",label:"हिन्दी"},
  {value:"tr",label:"Türkçe"},
  {value:"vi",label:"Tiếng Việt"},
  {value:"th",label:"ไทย"},
  {value:"id",label:"Bahasa Indonesia"},
  {value:"ms",label:"Bahasa Melayu"},
  {value:"nl",label:"Nederlands"},
  {value:"pl",label:"Polski"},
  {value:"uk",label:"Українська"},
  {value:"sv",label:"Svenska"},
  {value:"fa",label:"فارسی"}
];

const supported=new Set(TRANSLATION_LANGUAGES.map(item=>item.value));
export function browserTranslateLanguage(language){
  const raw=String(language||"en").replaceAll("_","-").trim();
  const [primary,region=""]=raw.split("-");
  const root=primary.toLowerCase();
  if(root==="zh"){
    return /^(TW|HK|MO|Hant)$/i.test(region)?"zh-TW":"zh-CN";
  }
  if(root==="tl")return "fil";
  // An otherwise valid browser locale should not silently become English
  // simply because we do not show it as a predefined menu choice.
  return /^[a-z]{2,3}$/.test(root)?root:"en";
}
export function translationTarget(preference,language){
  return supported.has(preference)&&preference!=="auto"
    ?preference:browserTranslateLanguage(language);
}
