#!/usr/bin/env node
import { dispatchCli } from "./surfaces/cli-commands.ts";

const argv = process.argv.slice(2);
const code = await dispatchCli(argv, {
  runMcp: async () => {
    const { runMcpServer } = await import("./mcp-server.ts");
    return runMcpServer();
  },
});
// MCP has already settled child ownership, but disconnected observer timers
// may still be live. Ordinary commands let Node flush stdout and stderr.
if (argv.length === 1 && argv[0] === "mcp") process.exit(code);
process.exitCode = code;
