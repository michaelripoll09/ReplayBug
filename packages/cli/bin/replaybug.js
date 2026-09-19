#!/usr/bin/env node
// ReplayBug CLI binary: thin launcher over the built commander program.
// All logic lives in ../dist (built by tsup); this shim only forwards so
// `bin/replaybug.js` stays the stable `replaybug` entry point.
import "../dist/bin.js";
