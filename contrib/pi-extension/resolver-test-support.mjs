// Read-only test instrumentation; no product state is assigned or replaced.
import fs from "node:fs";
import fsp from "node:fs/promises";
import cp from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

export function observeReadEffects(fn) {
  const effects = [];
  const undo = [];
  const wrap = (object, key, label) => {
    const original = object[key];
    if (typeof original !== "function") return;
    object[key] = function (...args) { effects.push(label); return Reflect.apply(original, this, args); };
    undo.push(() => { object[key] = original; });
  };
  for (const [object, label] of [[fs, "fs"], [fsp, "fs/promises"]]) {
    for (const key of Object.keys(object)) {
      if (/^(read|write|append|open|close|stat|lstat|access|realpath|readdir|mkdir|rm|unlink|rename|copy|watch)/.test(key)) wrap(object, key, `${label}.${key}`);
    }
  }
  for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) wrap(cp, key, `child_process.${key}`);
  for (const object of [http, https]) for (const key of ["request", "get"]) wrap(object, key, `http.${key}`);
  for (const key of ["connect", "createConnection"]) wrap(net, key, `net.${key}`);
  for (const key of ["fetch", "setTimeout", "setInterval", "queueMicrotask"]) wrap(globalThis, key, key);
  const originalEnv = process.env;
  process.env = new Proxy(originalEnv, { get(target, key) { effects.push("env.read"); return Reflect.get(target, key); }, ownKeys(target) { effects.push("env.enumerate"); return Reflect.ownKeys(target); } });
  syncBuiltinESMExports();
  try { fn(); } finally {
    process.env = originalEnv;
    for (const restore of undo.reverse()) restore();
    syncBuiltinESMExports();
  }
  return effects;
}

export function barrier() {
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  return { entered: entered.promise, enter: entered.resolve, wait: released.promise, release: released.resolve };
}
