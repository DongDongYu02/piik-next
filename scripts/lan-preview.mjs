// Development-only LAN TLS front end; the Go service still owns all app routes.
import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** @typedef {{address: string, httpPort: number, httpsPort: number, backendPort: number,
 * pfxPath: string, certificatePath: string, pfxPassword: string}} LanConfig */

const certificateRoute = "/piik-lan.cer";
const hopHeaders = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade"];

function responseHeaders(headers) {
  const forwarded = { ...headers };
  for (const name of [...hopHeaders, ...(headers.connection ?? "").split(",")]) {
    delete forwarded[name.trim().toLowerCase()];
  }
  return forwarded;
}

function upgradeHead(response) {
  let result = `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`;
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    result += `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`;
  }
  return `${result}\r\n`;
}

/** Starts the two development listeners and returns their single resource owner.
 * @param {LanConfig} config */
export async function startLanPreview(config) {
  if (!isIP(config.address) || ![config.httpPort, config.httpsPort, config.backendPort]
    .every(port => Number.isInteger(port) && port >= 0 && port <= 65535) || !config.backendPort ||
    typeof config.pfxPassword !== "string") throw new Error("Invalid LAN preview configuration");
  const [pfx, certificateFile] = await Promise.all([
    readFile(config.pfxPath), readFile(config.certificatePath),
  ]);
  // Parse and re-export the public certificate: this route can never serve key material.
  const certificate = new X509Certificate(certificateFile).raw;
  const sockets = new Set();
  let closing = false;
  let closed;
  const track = socket => {
    if (closing) { socket.destroy(); return; }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  };
  const proxyOptions = request => ({
    host: "127.0.0.1", port: config.backendPort, method: request.method,
    path: request.url, headers: request.headers,
  });
  const handle = (request, response) => {
    if (request.url?.split("?")[0] === certificateRoute) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return;
      }
      response.writeHead(200, { "Content-Type": "application/pkix-cert",
        "Content-Disposition": 'attachment; filename="piik-lan.cer"',
        "Content-Length": certificate.length, "Cache-Control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : certificate); return;
    }
    const upstream = httpRequest({ ...proxyOptions(request),
      headers: responseHeaders(request.headers) }, incoming => {
      response.writeHead(incoming.statusCode ?? 502, responseHeaders(incoming.headers));
      incoming.on("error", () => response.destroy()); incoming.pipe(response);
    });
    upstream.on("socket", track);
    upstream.on("error", () => {
      if (response.headersSent) response.destroy();
      else { response.writeHead(502); response.end("LAN backend unavailable"); }
    });
    upstream.setTimeout(30_000, () => upstream.destroy());
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => { if (!response.writableFinished) upstream.destroy(); });
    request.pipe(upstream);
  };
  const servers = [createHttpServer(handle), createHttpsServer({ pfx, passphrase: config.pfxPassword }, handle)];
  const close = () => {
    if (closed) return closed;
    closing = true;
    for (const socket of sockets) socket.destroy();
    closed = Promise.all(servers.map(server => new Promise(resolveClose => {
      server.close(() => resolveClose());
    }))).then(() => undefined);
    return closed;
  };
  for (const server of servers) {
    server.requestTimeout = 60_000; server.headersTimeout = 30_000;
    server.on("connection", track);
    server.on("upgrade", (request, client, head) => {
      if (request.url?.split("?")[0] !== "/signal") {
        client.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
      }
      const upstream = httpRequest(proxyOptions(request));
      upstream.on("socket", track);
      upstream.on("upgrade", (response, remote, upstreamHead) => {
        remote.setTimeout(0); client.setTimeout(0);
        client.write(upgradeHead(response));
        if (upstreamHead.length) client.write(upstreamHead);
        if (head.length) remote.write(head);
        client.on("error", () => remote.destroy()); remote.on("error", () => client.destroy());
        client.once("close", () => remote.destroy()); remote.once("close", () => client.destroy());
        client.pipe(remote); remote.pipe(client);
      });
      upstream.on("response", response => {
        client.write(upgradeHead(response)); response.pipe(client);
        response.on("error", () => client.destroy());
      });
      upstream.on("error", () => client.destroy());
      upstream.setTimeout(30_000, () => upstream.destroy());
      client.once("close", () => upstream.destroy());
      upstream.end();
    });
  }
  try {
    for (const [index, port] of [config.httpPort, config.httpsPort].entries()) {
      const server = servers[index];
      await new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(port, config.address, () => {
          server.off("error", rejectListen); resolveListen();
        });
      });
      server.on("error", () => { void close(); });
    }
  } catch (error) { await close(); throw error; }
  const host = isIP(config.address) === 6 ? `[${config.address}]` : config.address;
  return { close,
    httpUrl: `http://${host}:${servers[0].address().port}`,
    httpsUrl: `https://${host}:${servers[1].address().port}`,
  };
}

async function main() {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/lan-preview.mjs <config.json>");
  const preview = await startLanPreview(JSON.parse(await readFile(process.argv[2], "utf8")));
  const stop = async () => {
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    await preview.close();
  };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  console.log(`HTTP: ${preview.httpUrl}/multi`);
  console.log(`HTTPS: ${preview.httpsUrl}/multi`);
  console.log(`Public certificate: ${preview.httpUrl}${certificateRoute}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error("LAN preview could not start; check configuration, certificate and ports."); process.exitCode = 1; });
}
