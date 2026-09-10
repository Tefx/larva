// purpose: record Pi extension ctx.mode/hasUI and registered Larva commands in disposable tests
// usage: pi -e tests/fixtures/pi/mode-observer.ts with LARVA_NATIVE_OBSERVE set
// effects: writes JSON to LARVA_NATIVE_OBSERVE; shuts down TUI after a short delay
// requires: isolated PI_CODING_AGENT_DIR and LARVA_NATIVE_OBSERVE path
import { writeFileSync } from "node:fs";

export default function (pi: {
  on: (event: string, handler: (event: unknown, ctx: Record<string, unknown>) => unknown) => void;
  registerCommand?: (name: string, options: unknown) => void;
}) {
  const commands: string[] = [];
  const original = pi.registerCommand?.bind(pi);
  if (typeof original === "function") {
    pi.registerCommand = ((name: string, options: unknown) => {
      commands.push(name);
      return original(name, options);
    }) as typeof pi.registerCommand;
  }
  pi.on("session_start", (_event, ctx) => {
    const observe = process.env.LARVA_NATIVE_OBSERVE;
    if (typeof observe === "string" && observe.length > 0) {
      writeFileSync(observe, JSON.stringify({
        mode: ctx.mode,
        hasUI: ctx.hasUI,
        execPath: process.execPath,
        argv: process.argv,
        commands,
        larvaCliArgvJsonPresent: typeof process.env.LARVA_CLI_ARGV_JSON === "string",
      }), { encoding: "utf8", mode: 0o600 });
    }
    if (ctx.mode === "tui" && typeof ctx.shutdown === "function") {
      setTimeout(() => {
        try { (ctx.shutdown as () => void)(); } catch { /* test observer */ }
      }, 400);
    }
  });
}
