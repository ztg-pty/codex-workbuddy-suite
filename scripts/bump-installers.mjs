// Keep the bootstrap installers pinned to the same version as package.json.
import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const version=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
const targets=[
  {file:'install.ps1',pattern:/(\$SuiteVersion\s*=\s*')[^']+(')/u},
  {file:'install.sh',pattern:/(SUITE_VERSION=')[^']+(')/u},
];
for(const {file,pattern} of targets){
  const full=path.join(root,file);
  const text=await fs.readFile(full,'utf8');
  if(!pattern.test(text))throw new Error(`version marker missing in ${file}`);
  await fs.writeFile(full,text.replace(pattern,`$1${version}$2`),'utf8');
  console.log(`${file} -> ${version}`);
}
