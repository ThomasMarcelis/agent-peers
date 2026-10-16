// Test-owned listeners register their cleanup before they listen, so a failed assertion
// cannot leave a handle open and hold the run until CI's job timeout.
import { once } from "node:events";

const connections = Symbol("connections");

// Close a server and destroy the connections it accepted: server.close alone waits for
// them, and a peer's idle connection can outlive the test by readLines' 30 s timeout.
// Safe to call more than once, and on a server that never started listening.
export function closeServer(server) {
  for (const socket of server[connections] ?? []) socket.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}

// Listen on a Unix socket path. With a test context, cleanup is registered before listening.
export async function listen(server, path, t) {
  if (!server[connections]) {
    const open = server[connections] = new Set();
    server.on("connection", (socket) => { open.add(socket); socket.once("close", () => open.delete(socket)); });
  }
  t?.after(() => closeServer(server));
  server.listen(path);
  await once(server, "listening");
  return server;
}
