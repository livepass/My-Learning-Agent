import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.INNO_DATA_DIR = join(tmpdir(), `inno-agent-vitest-${process.pid}`);

// E4.9b: the learning UI renders through react-i18next. Without initialising it
// in tests, `t()` returns the key itself and every Chinese assertion fails for
// the wrong reason. The default locale is zh-CN, matching the product default.
import "./apps/learning-agent/web/src/i18n/index.js";
