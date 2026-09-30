// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// Lets a child `node -r <this file> some.ts` process run the workspace's
// TypeScript sources the way jest.config.*.js does, so a test can execute a CLI
// as a real process (real stdout/stderr) without building dist/. Uses only the
// repo's pinned `typescript` (transpile, no type check):
//   - @cmdb/<pkg>[/path] -> packages/<pkg>/src[/path];
//   - @happy-technologies/connector-core -> its TS source (the package is ESM-only);
//   - `./x.js` from a .ts file -> ./x.ts when that exists;
//   - .ts (and <dir>/index.ts) is preferred over the stale compiled .js that
//     is committed next to some sources.
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

// packages/api-server/src/scripts/__tests__/fixtures -> repository root.
const ROOT = path.resolve(__dirname, '../../../../../..');

function preferTs(base) {
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  let target = null;
  const cmdb = /^@cmdb\/([^/]+)(?:\/(.*))?$/.exec(request);
  if (cmdb) {
    target = preferTs(path.join(ROOT, 'packages', cmdb[1], 'src', cmdb[2] || ''));
  } else if (request === '@happy-technologies/connector-core') {
    target = path.join(ROOT, 'node_modules/@happy-technologies/connector-core/src/index.ts');
  } else if (/^\.{1,2}\//.test(request) && parent && parent.filename && parent.filename.endsWith('.ts')) {
    const base = path.resolve(path.dirname(parent.filename), request.replace(/\.js$/, ''));
    target = preferTs(base);
  }
  return resolveFilename.call(this, target || request, parent, ...rest);
};

require.extensions['.ts'] = function (module, filename) {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      resolveJsonModule: true,
    },
  });
  module._compile(outputText, filename);
};
