// No npm dependencies: fail before npm install if Ant Design X and Ant Design
// are pinned to incompatible major/minor versions.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const pkg=JSON.parse(readFileSync(new URL("../frontend/package.json",import.meta.url),"utf8"));
const deps=pkg.dependencies||{};
const parse=(value,name)=>{
  assert.match(value||"",/^\d+\.\d+\.\d+$/,name+" must be an exact version");
  return value.split(".").map(Number);
};
const [antdMajor,antdMinor,antdPatch]=parse(deps.antd,"antd");
const [xMajor,xMinor]=parse(deps["@ant-design/x"],"@ant-design/x");
const [iconsMajor]=parse(deps["@ant-design/icons"],"@ant-design/icons");
assert.ok(xMajor===2 && xMinor===9,"Peer check targets @ant-design/x v2.9.x; update requirements if X upgrades");
assert.ok(antdMajor===6 && (antdMinor>1 || (antdMinor===1 && antdPatch>=1)),
  "@ant-design/x v2.9.0 requires antd ^6.1.1; antd 5.x breaks npm install");
assert.ok(iconsMajor===6,"Use @ant-design/icons 6.x with antd 6.x");
assert.ok(!deps["@chatscope/chat-ui-kit-react"],"Do not retain old ChatScope UI dependency");
console.log("Ant Design peer versions compatible:",{
  antd:deps.antd,x:deps["@ant-design/x"],icons:deps["@ant-design/icons"]
});
