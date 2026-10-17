// Test-only loader for the extension's single shared ESM settings dependency.
// The actual Chrome runtime uses native ES modules.
const fs=require('node:fs');
const path=require('node:path');
exports.readScript=name=>{
  const dir=path.join(__dirname,'../extension/src');
  const settings=fs.readFileSync(path.join(dir,'settings.js'),'utf8').replace(/^export /gm,'');
  const script=fs.readFileSync(path.join(dir,name),'utf8').replace(/^import \{[^}]+\} from "\.\/settings\.js";\r?\n/,'');
  return settings+'\n'+script;
};
