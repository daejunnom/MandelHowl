/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const modern = require("minimatch-modern");
const legacyCallable = modern.minimatch;

for (const [key, value] of Object.entries(modern)) {
  legacyCallable[key] = value;
}

module.exports = legacyCallable;
