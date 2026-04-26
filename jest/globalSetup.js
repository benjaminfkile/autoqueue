const fs = require("fs");
const os = require("os");
const path = require("path");

// Allocate a fresh, throwaway SQLite database path per test run and expose it
// via GRUNT_DB_PATH so src/db/db.ts#getDbFilePath() points at the temp file
// instead of the user data dir. Tests that mock the db module ignore this; the
// scaffolding is here for tests that exercise the real db layer end-to-end.
module.exports = async function globalSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grunt-test-"));
  const dbFile = path.join(dir, "grunt.sqlite");
  process.env.GRUNT_DB_PATH = dbFile;
  // Stash the dir on the global so teardown can clean it up.
  global.__GRUNT_TEST_DB_DIR__ = dir;
};
