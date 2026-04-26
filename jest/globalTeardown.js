const fs = require("fs");

module.exports = async function globalTeardown() {
  const dir = global.__GRUNT_TEST_DB_DIR__;
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
