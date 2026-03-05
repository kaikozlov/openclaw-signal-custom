import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignalSocketClient } from "./socket-client.js";

function createMockServer() {
  const connections: net.Socket[] = [];
  const server = net.createServer((socket) => {
    connections.push(socket);
    socket.on("close", () => {
      const idx = connections.indexOf(socket);
      if (idx !== -1) {
        connections.splice(idx, 1);
      }
    });

    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString("utf8");
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) {
          const req = JSON.parse(line) as { id: string; method: string };
          socket.write(
            `${JSON.stringify({ jsonrpc: "2.0", result: { ok: req.method }, id: req.id })}\n`,
          );
        }
        idx = buffer.indexOf("\n");
      }
    });
  });

  return {
    connections,
    async listen() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve server address");
      }
      return address.port;
    },
    async close() {
      for (const connection of connections) {
        connection.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("SignalSocketClient", () => {
  let mockServer: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    mockServer = createMockServer();
  });

  afterEach(async () => {
    await mockServer.close();
  });

  it("connects and resolves requests", async () => {
    const port = await mockServer.listen();
    const client = new SignalSocketClient({
      host: "127.0.0.1",
      port,
      reconnect: false,
    });
    client.connect();
    await client.waitForConnect();

    const response = await client.request<{ ok: string }>("send", { message: "hi" });
    expect(response).toEqual({ ok: "send" });

    client.close();
  });

  it("rejects request when not connected", async () => {
    const port = await mockServer.listen();
    const client = new SignalSocketClient({
      host: "127.0.0.1",
      port,
      reconnect: false,
    });

    await expect(client.request("send", {})).rejects.toThrow(/not connected/);
    client.close();
  });
});
