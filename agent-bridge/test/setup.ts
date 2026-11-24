// Loaded before every test file (see bunfig.toml): code under test that uses
// ~/.eyepatch gets a temporary one instead.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.EYEPATCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "eyepatch-test-home-"));
