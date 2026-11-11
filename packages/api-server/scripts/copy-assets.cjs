// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
//
// tsc emits only .ts output. swagger.routes.ts loads openapi/openapi.yaml relative to
// its compiled location (dist/rest/routes -> dist/openapi/openapi.yaml), so the spec
// must be copied next to the emitted JS or startup logs "Failed to load OpenAPI
// specification" (HAP-900). Usage: node scripts/copy-assets.cjs [packageRoot]
const fs = require('node:fs');
const path = require('node:path');

const ASSETS = ['openapi/openapi.yaml'];

function copyAssets(packageRoot) {
  for (const asset of ASSETS) {
    const from = path.join(packageRoot, 'src', asset);
    const to = path.join(packageRoot, 'dist', asset);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

module.exports = { copyAssets };

if (require.main === module) {
  copyAssets(path.resolve(process.argv[2] ?? path.join(__dirname, '..')));
}
