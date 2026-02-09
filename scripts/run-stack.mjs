import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const modeArg = process.argv[2];
const mode = modeArg === "dev" ? "dev" : "start";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const cwd = process.cwd();
const logDir = resolve(cwd, process.env.LEASE_BOT_LOG_DIR || ".logs");

mkdirSync(logDir, { recursive: true });

const apiLogStream = createWriteStream(resolve(logDir, "api.log"), { flags: "a" });
const workerLogStream = createWriteStream(resolve(logDir, "worker.log"), { flags: "a" });
const stackLogStream = createWriteStream(resolve(logDir, "stack.log"), { flags: "a" });
const forceShutdownMs = Number(process.env.LEASE_BOT_STACK_FORCE_KILL_MS || 5000);

const children = new Map();
let shuttingDown = false;
let nextExitCode = 0;
let exitFlushed = false;

function writeLog(stream, line) {
  stream.write(`${line}\n`);
}

function logLine(label, line) {
  const timestamp = new Date().toISOString();
  const formatted = `${timestamp} [${label}] ${line}`;
  process.stdout.write(`${formatted}\n`);
  writeLog(stackLogStream, formatted);
  if (label.startsWith("api")) {
    writeLog(apiLogStream, formatted);
  }
  if (label.startsWith("worker")) {
    writeLog(workerLogStream, formatted);
  }
}

function attachChildOutput(child, label) {
  const stdoutReader = createInterface({ input: child.stdout });
  const stderrReader = createInterface({ input: child.stderr });
  stdoutReader.on("line", (line) => logLine(label, line));
  stderrReader.on("line", (line) => logLine(`${label}:err`, line));
  child.on("close", () => {
    stdoutReader.close();
    stderrReader.close();
  });
}

function spawnService(name, args) {
  const child = spawn(npmCommand, args, {
    cwd,
    env: process.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.set(name, child);
  attachChildOutput(child, name);
  logLine("stack", `spawned ${name} (pid=${child.pid}) with: npm ${args.join(" ")}`);
  child.on("exit", (code, signal) => {
    logLine("stack", `${name} exited (code=${code ?? "null"} signal=${signal ?? "none"})`);
    if (!shuttingDown) {
      nextExitCode = typeof code === "number" ? code : 1;
      shutdown();
    }
    children.delete(name);
    if (shuttingDown && children.size === 0) {
      flushAndExit(nextExitCode);
    }
  });
}

function flushAndExit(code) {
  if (exitFlushed) {
    return;
  }
  exitFlushed = true;
  const streams = [apiLogStream, workerLogStream, stackLogStream];
  let remaining = streams.length;
  const finish = () => {
    remaining -= 1;
    if (remaining === 0) {
      process.exit(code);
    }
  };
  streams.forEach((stream) => stream.end(finish));
}

function terminateChild(child, signal) {
  if (!child || child.killed) {
    return;
  }
  if (process.platform !== "win32" && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to direct child signal below.
    }
  }
  child.kill(signal);
}

function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logLine("stack", "shutting down api+worker stack");
  for (const [, child] of children.entries()) {
    terminateChild(child, "SIGTERM");
  }

  const timeout = Number.isFinite(forceShutdownMs) && forceShutdownMs > 0 ? forceShutdownMs : 5000;
  setTimeout(() => {
    if (children.size === 0) {
      return;
    }
    logLine("stack", "forcing shutdown (SIGKILL) for remaining processes");
    for (const [, child] of children.entries()) {
      terminateChild(child, "SIGKILL");
    }
    flushAndExit(nextExitCode || 1);
  }, timeout).unref();

  if (children.size === 0) {
    flushAndExit(nextExitCode);
  }
}

process.on("SIGINT", () => {
  nextExitCode = 0;
  shutdown();
});
process.on("SIGTERM", () => {
  nextExitCode = 0;
  shutdown();
});

const baseScript = mode === "dev" ? "dev" : "start";
spawnService("api", ["run", baseScript, "-w", "@lease-bot/api"]);
spawnService("worker", ["run", baseScript, "-w", "@lease-bot/worker"]);
