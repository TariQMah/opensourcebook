/**
 * The engine on this computer, as `npm start` runs it: the same local engine as `wrangler dev`, started through
 * wrangler's own API so its debugger port can stay shut. `wrangler dev` always opens a debugger port, and any
 * program on this computer that reaches it can run code inside the engine and read its settings and tokens. So it is
 * off unless the person developing Open Sourcebook asks for it with OPENSOURCEBOOK_ENGINE_INSPECTOR=1 (then on 127.0.0.1, at
 * `--inspector-port`).
 *
 *   node scripts/dev.ts --ip 127.0.0.1 --port 8787 --env-file ../.opensourcebook/engine.env [--config wrangler.local.toml] [--persist-to <folder>]
 *                       [--inspector-port 9230] [--compatibility-flags nodejs_compat]
 */
import { unstable_readConfig, unstable_startWorker } from "wrangler";
import { withNewNames } from "../src/old-names.ts";

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const ip = flag("ip") ?? "127.0.0.1";
const port = Number(flag("port") ?? 8787);
const envFile = flag("env-file");
const config = flag("config") ?? "wrangler.toml";
const flags = flag("compatibility-flags");
// A shell that still sets the old name (RE_ENGINE_INSPECTOR) is read too.
const inspect = withNewNames(process.env).OPENSOURCEBOOK_ENGINE_INSPECTOR === "1";
const inspectorPort = Number(flag("inspector-port") ?? 9229);
// Where the local database, queue and files are kept: the launcher names the app data folder's `data/` when there is one.
const persistTo = flag("persist-to");

// The config as wrangler reads it, without the headless-browser binding a deployer's config may name (`[browser]`):
// on this computer the runtime would answer it by downloading a whole Chrome the first time a page is rendered, and
// again after every failed try, stalling the engine meanwhile. Pages are read without it.
const { browser: _browser, ...read } = unstable_readConfig({ config });

const worker = await unstable_startWorker({
  config: read as typeof read & { browser: undefined },
  ...(envFile ? { envFiles: [envFile] } : {}),
  ...(flags ? { compatibilityFlags: flags.split(",") } : {}),
  dev: {
    server: { hostname: ip, port },
    inspector: inspect ? { hostname: "127.0.0.1", port: inspectorPort } : false,
    watch: true,
    ...(persistTo ? { persist: persistTo } : {}),
  },
});
await worker.ready;
console.log(`Ready on http://${ip}:${port}${inspect ? ` (debugger on 127.0.0.1:${inspectorPort})` : ""}`);

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await worker.dispose().catch(() => undefined);
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => void close());
