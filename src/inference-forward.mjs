// Fixed launcher for the Linux worker sandbox. The sandbox has its own network
// namespace with only loopback, so this forwards 127.0.0.1:<port> to the host
// inference relay's Unix socket, then runs Pi and passes its exit status on.
// It is copied into a run-owned directory and mounted read-only; it must not
// import other TinySDD modules.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { connect, createServer } from "node:net";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

export const LAUNCHER_SETUP_EXIT = 125;
const FORWARDED_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];

export function startInferenceForwarder({ port, socketPath, host = "127.0.0.1" }) {
  const sockets = new Set();
  const server = createServer({ allowHalfOpen: true }, (client) => {
    const upstream = connect({ path: socketPath, allowHalfOpen: true });
    sockets.add(client);
    sockets.add(upstream);
    const destroy = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", destroy);
    upstream.on("error", destroy);
    // pipe() propagates each half-close; a client that is gone has no use for the relay connection.
    client.once("close", () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.once("close", () => sockets.delete(upstream));
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

function refuse(message) {
  process.stderr.write(`tinysdd inference launcher: ${message}\n`);
  process.exit(LAUNCHER_SETUP_EXIT);
}

export async function launch([portText, socketPath, command, ...args]) {
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) refuse("invalid forwarder port");
  if (typeof socketPath !== "string" || !socketPath.startsWith("/")) refuse("invalid relay socket path");
  if (typeof command !== "string" || !command.startsWith("/")) refuse("invalid Pi executable path");
  let forwarder;
  try {
    forwarder = await startInferenceForwarder({ port, socketPath });
  } catch (error) {
    refuse(`cannot listen on 127.0.0.1:${port}: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Pi writes its JSON event stream straight to the inherited stdout.
  const child = spawn(command, args, { stdio: "inherit" });
  const relay = (signal) => () => child.kill(signal);
  const handlers = FORWARDED_SIGNALS.map((signal) => [signal, relay(signal)]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  child.once("error", (error) => {
    process.stderr.write(`tinysdd inference launcher: cannot start Pi: ${error.message}\n`);
    process.exit(127);
  });
  child.once("exit", (code, signal) => {
    void forwarder.close();
    for (const [name, handler] of handlers) process.removeListener(name, handler);
    if (signal) {
      process.kill(process.pid, signal);
      // Signals whose default action is ignore still need a matching status.
      setTimeout(() => process.exit(128 + (constants.signals[signal] ?? 0)), 1000);
      return;
    }
    process.exit(code ?? 1);
  });
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) void launch(process.argv.slice(2));
