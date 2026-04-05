// Minimal CJS stub for @octokit/rest (ESM-only package).
// Jest runs in CommonJS mode and cannot parse the ESM dist files,
// so we redirect the import here for all test runs.
class Octokit {
  constructor(_options) {}
}

module.exports = { Octokit };
