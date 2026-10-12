import assert from "node:assert/strict";
import {chatTime} from "../frontend/src/chat_time.js";
const dates=[
  [new Date(2026,9,12,20,59),"2026年10月12日 20:59"],
  [new Date(2026,9,11,21,10),"2026年10月11日 21:10"],
  [new Date(2026,8,25,18,30),"2026年09月25日 18:30"],
  [new Date(2025,11,31,23,12),"2025年12月31日 23:12"]
];
for (const [value,expected] of dates) assert.equal(chatTime(value.getTime()),expected);
assert.equal(chatTime("invalid"),"");
console.log("All chat entries show full local year, month, day and time");
