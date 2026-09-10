// purpose: inject one filesystem failure beneath actual native parent cleanup
// usage: NODE_OPTIONS=--import=<this file>; write {operation,path} to NATIVE_CLEANUP_FAULT
// effects: parent-only lstatSync/rmSync fault at one exact disposable path; no caller replacement
// requires: native Pi fixture; descendants retain normal filesystem behavior
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
if (!process.env.LARVA_PI_CAPSULE_ROOT && process.env.NATIVE_CLEANUP_FAULT) {
  const read = fs.readFileSync;
  for (const operation of ["lstatSync", "rmSync"]) {
    const original = fs[operation];
    fs[operation] = function (path, ...args) {
      let fault;
      try { fault = JSON.parse(read(process.env.NATIVE_CLEANUP_FAULT, "utf8")); } catch {}
      if (fault?.operation === operation && path === fault.path) {
        fs.appendFileSync(process.env.NATIVE_CLEANUP_FAULT + ".hits", JSON.stringify({ operation, path, pid: process.pid }) + "\n");
        throw Object.assign(new Error("Deliberate filesystem failure.\n".repeat(10000)), { code: fault.code ?? "EACCES" });
      }
      return original.call(this, path, ...args);
    };
  }
  syncBuiltinESMExports();
}
