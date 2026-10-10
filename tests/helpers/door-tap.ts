import { createConnection, createServer, type Socket } from "node:net";

/** One line that crossed the tap, in the order the tap saw it on that connection. */
export interface TappedLine {
  connection: number;
  direction: "toDaemon" | "fromDaemon";
  line: string;
}

const splitLines = (onLine: (line: string) => void): ((chunk: Buffer) => void) => {
  let held = "";
  return (chunk) => {
    held += chunk.toString("utf8");
    for (let newline = held.indexOf("\n"); newline >= 0; newline = held.indexOf("\n")) {
      onLine(held.slice(0, newline));
      held = held.slice(newline + 1);
    }
  };
};

/**
 * A byte-for-byte forwarder in front of a daemon door that keeps, per connection, every line in
 * each direction in the order it crossed. It runs in the test process, so a door that admits by
 * the kernel's peer record sees this process, as it would an in-process relay. A connection whose
 * door is not there (the daemon is stopped) is closed at once, which the relay reads as a refused
 * attempt and retries.
 */
export const doorTap = async (tapPath: string, doorPath: string) => {
  const lines: TappedLine[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((relaySide) => {
    const connection = connections++;
    const daemonSide = createConnection(doorPath);
    sockets.add(relaySide);
    sockets.add(daemonSide);
    const closeBoth = (): void => {
      relaySide.destroy();
      daemonSide.destroy();
      sockets.delete(relaySide);
      sockets.delete(daemonSide);
    };
    relaySide.on("error", closeBoth);
    daemonSide.on("error", closeBoth);
    relaySide.once("close", closeBoth);
    daemonSide.once("close", closeBoth);
    const toDaemon = splitLines((line) => lines.push({ connection, direction: "toDaemon", line }));
    const fromDaemon = splitLines((line) => lines.push({ connection, direction: "fromDaemon", line }));
    relaySide.on("data", (chunk: Buffer) => {
      toDaemon(chunk);
      daemonSide.write(chunk);
    });
    daemonSide.on("data", (chunk: Buffer) => {
      fromDaemon(chunk);
      relaySide.write(chunk);
    });
  });
  await new Promise<void>((resolve) => server.listen(tapPath, resolve));
  return {
    lines,
    connections: () => connections,
    /** The lines of one connection, parsed, with their direction. */
    of: (connection: number) =>
      lines
        .filter((tapped) => tapped.connection === connection)
        .map((tapped) => ({ direction: tapped.direction, message: JSON.parse(tapped.line) as Record<string, unknown> })),
    close: async (): Promise<void> => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
