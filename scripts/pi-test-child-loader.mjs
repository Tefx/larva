// purpose: retarget controlled protocol tests without a shipped launch override
// usage: node --import ./scripts/pi-test-child-loader.mjs <API/protocol test>
// effects: process-local loader hook on Larva source; never installed or inherited
// requires: Node 26 registerHooks; NOT for native launch/discovery acceptance
import { registerHooks } from "node:module";

registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.startsWith("file:") || !url.split("?")[0].endsWith(".ts") || loaded.source == null) return loaded;
    const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
    const signature = /function resolvePiCommandPrefix\([^\n]*\)\s*:\s*string\[\] \| LarvaError \{/;
    if (!signature.test(source)) return loaded;
    // Fault-injection seam belongs exclusively to this test loader. The real
    // implementation, child argv assembly, RPC protocol and cleanup still run.
    const replaced = source.replace(signature, `function resolvePiCommandPrefix(env: RuntimeEnv): string[] | LarvaError {
      if (typeof env.LARVA_PI_TEST_CHILD_ARGV_JSON === "string" && env.LARVA_PI_TEST_CHILD_ARGV_JSON.length > 0) {
        try {
          const prefix = JSON.parse(env.LARVA_PI_TEST_CHILD_ARGV_JSON);
          if (Array.isArray(prefix) && prefix.length && prefix.every((part) => typeof part === "string" && part.length > 0) && isAbsolute(prefix[0]) && existsSync(prefix[0])) return prefix;
        } catch { /* invalid controlled input falls through to native failure */ }
      }
      return nativeTestOriginalPrefix(env);
    }
    function nativeTestOriginalPrefix(_env: RuntimeEnv): string[] | LarvaError {`);
    return { ...loaded, source: replaced };
  },
});
