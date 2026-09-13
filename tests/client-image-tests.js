const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sourceRoot = path.join(__dirname, '..', 'src');
for (const filename of fs.readdirSync(sourceRoot).filter((name) => name.endsWith('.gs'))) {
  const source = fs.readFileSync(path.join(sourceRoot, filename), 'utf8');
  new Function(source);
}

const scriptsHtml = fs.readFileSync(path.join(sourceRoot, 'Scripts.html'), 'utf8');
const scriptMatch = scriptsHtml.match(/<script>([\s\S]*?)<\/script>/);
assert(scriptMatch, 'Scripts.html must contain a script block.');
new Function(scriptMatch[1]);

const dimensionMatch = scriptMatch[1].match(
  /function mobileHdDimensions\(width, height\) \{[\s\S]*?\n    \}/
);
assert(dimensionMatch, 'mobileHdDimensions must be present.');
const mobileHdDimensions = new Function(
  `${dimensionMatch[0]}; return mobileHdDimensions;`
)();

assert.deepStrictEqual(mobileHdDimensions(1920, 1080), { width: 1280, height: 720 });
assert.deepStrictEqual(mobileHdDimensions(1080, 1920), { width: 720, height: 1280 });
assert.deepStrictEqual(mobileHdDimensions(4000, 3000), { width: 960, height: 720 });
assert.deepStrictEqual(mobileHdDimensions(3000, 4000), { width: 720, height: 960 });
assert.deepStrictEqual(mobileHdDimensions(640, 480), { width: 640, height: 480 });

console.log('Apps Script syntax and mobile HD dimension checks passed.');
