import { spawnSync } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { startLanPreview } from "../scripts/lan-preview.mjs";

let directory: string;
let pfxPath: string;
let certificatePath: string;
const password = randomBytes(18).toString("base64url");

it.runIf(process.platform === "win32")("rejects non-origin public URLs before starting the Windows launcher", () => {
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference = 'Stop'
    foreach ($invalidOrigin in @('http://piik.test:5200', 'https://user:password@piik.test:5200',
      'https://piik.test:5200/path', 'https://piik.test:5200/?x=1', 'https://piik.test:5200/#x', 'not-a-url')) {
      try {
        & $env:PIIK_TEST_LAUNCHER -PublicBaseUrl $invalidOrigin -NoBuild
        throw 'Invalid origin was accepted'
      } catch {
        if ($_.Exception.Message -notlike 'PublicBaseUrl must*') { throw }
      }
    }
    exit 0
  `], { windowsHide: true, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, PIIK_TEST_LAUNCHER: resolve("scripts/start-multi-screen-lan.ps1") } });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});

it.runIf(process.platform === "win32")("rejects invalid or occupied SFU configuration before creating preview resources", () => {
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference = 'Stop'
    function Get-NetIPAddress { [pscustomobject]@{ InterfaceIndex = 1; InterfaceAlias = 'test' } }
    function Get-NetAdapter { [pscustomobject]@{ InterfaceIndex = 1; Status = 'Up' } }
    function Get-NetUDPEndpoint {
      param($LocalPort)
      if ($LocalPort -ne 18882) { throw 'Unexpected UDP preflight port' }
      [pscustomobject]@{ LocalPort = $LocalPort }
    }
    function New-Item { throw 'Unexpected preview resource creation' }
    function Start-Process { throw 'Unexpected process start' }
    function Assert-Rejected($arguments, $message) {
      try {
        & $env:PIIK_TEST_LAUNCHER @arguments -NoBuild
        throw 'Invalid SFU configuration was accepted'
      } catch {
        if ($_.Exception.Message -notlike $message) { throw }
      }
    }
    Assert-Rejected @{ Address = '127.0.0.1' } '*physical adapter*'
    Assert-Rejected @{ Address = '::1' } '*physical adapter*'
    Assert-Rejected @{ Address = '192.0.2.1'; SfuPublicIP = '203.0.113.1' } '*requires SfuUdpPort*'
    Assert-Rejected @{ Address = '192.0.2.1'; SfuUdpPort = 18882; SfuPublicIP = 'not-an-ip' } '*must be an IPv4*'
    Assert-Rejected @{ Address = '192.0.2.1'; SfuUdpPort = 18882 } '*is in use*'
    exit 0
  `], { windowsHide: true, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, PIIK_TEST_LAUNCHER: resolve("scripts/start-multi-screen-lan.ps1") } });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "piik-lan-preview-test-"));
  pfxPath = join(directory, "private.pfx"); certificatePath = join(directory, "public.cer");
  if (process.platform === "win32") {
    // Ephemeral keys stay in this test directory; no writes to the OS trust store.
    const script = `
      $ErrorActionPreference = 'Stop'
      $rsa = [System.Security.Cryptography.RSA]::Create(2048)
      try {
        $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=127.0.0.1', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
        $san.AddIpAddress([System.Net.IPAddress]::Loopback)
        $san.AddDnsName('piik.test')
        $request.CertificateExtensions.Add($san.Build())
        $certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-1), [DateTimeOffset]::UtcNow.AddHours(1))
        try {
          [System.IO.File]::WriteAllBytes($env:PIIK_TEST_PFX, $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $env:PIIK_TEST_PASSWORD))
          [System.IO.File]::WriteAllBytes($env:PIIK_TEST_CERTIFICATE, $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
        } finally { $certificate.Dispose() }
      } finally { $rsa.Dispose() }
    `;
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, encoding: "utf8", timeout: 15_000,
      env: { ...process.env, PIIK_TEST_PFX: pfxPath, PIIK_TEST_CERTIFICATE: certificatePath,
        PIIK_TEST_PASSWORD: password },
    });
    if (result.error || result.status !== 0) throw new Error("Test certificate generation failed");
  } else {
    const key = join(directory, "private.pem"), pem = join(directory, "public.pem");
    for (const args of [
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", pem,
        "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:piik.test"],
      ["pkcs12", "-export", "-inkey", key, "-in", pem, "-out", pfxPath, "-passout", "env:PIIK_TEST_PASSWORD"],
      ["x509", "-in", pem, "-outform", "DER", "-out", certificatePath],
    ]) {
      const result = spawnSync("openssl", args, { encoding: "utf8", timeout: 15_000,
        env: { ...process.env, PIIK_TEST_PASSWORD: password } });
      if (result.error || result.status !== 0) throw new Error("Test certificate generation failed");
    }
  }
}, 20_000);

afterAll(async () => {
  if (!directory) return;
  const target = resolve(directory);
  const parent = process.platform === "win32" ? dirname(target).toLowerCase() : dirname(target);
  const temporaryRoot = process.platform === "win32" ? resolve(tmpdir()).toLowerCase() : resolve(tmpdir());
  expect(parent).toBe(temporaryRoot);
  expect(basename(target)).toMatch(/^piik-lan-preview-test-[A-Za-z0-9_-]+$/);
  expect((await lstat(target)).isSymbolicLink()).toBe(false);
  await rm(target, { recursive: true, force: true });
});

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return (server.address() as { port: number }).port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}

function config(backendPort: number, httpPort = 0, httpsPort = 0) {
  return { address: "127.0.0.1", httpPort, httpsPort, backendPort, pfxPath,
    certificatePath, pfxPassword: password };
}

function get(url: string, headers: Record<string, string> = {}, ca?: string) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>((resolve, reject) => {
    const request = (url.startsWith("https:") ? httpsRequest : httpRequest)(url, { headers, ca }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk)); response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode ?? 0,
        headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on("error", reject); request.setTimeout(3000, () => request.destroy(new Error("Request timeout")));
    request.end();
  });
}

describe("development LAN preview", () => {
  it("proxies HTTP, verified HTTPS and WebSocket traffic while exposing only the public certificate", async () => {
    const requests: Array<{ path?: string; host?: string; origin?: string }> = [];
    const backend = createServer((request, response) => {
      requests.push({ path: request.url, host: request.headers.host, origin: request.headers.origin });
      if (["/multi", "/api/runtime", "/healthz", "/assets/app.js"].includes(request.url ?? "")) {
        response.setHeader("Content-Type", "text/plain"); response.end(`Go route ${request.url}`);
      } else { response.writeHead(404); response.end(); }
    });
    const websocket = new WebSocketServer({ noServer: true });
    backend.on("upgrade", (request, socket, head) => {
      requests.push({ path: request.url, host: request.headers.host, origin: request.headers.origin });
      if (request.headers.origin === "https://denied.example") {
        socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return;
      }
      websocket.handleUpgrade(request, socket, head, client => {
        client.on("message", (data, binary) => client.send(data, { binary }));
      });
    });
    const backendPort = await listen(backend);
    const preview = await startLanPreview(config(backendPort));
    let client: WebSocket | undefined;
    try {
      const certificate = await readFile(certificatePath), ca = new X509Certificate(certificate).toString();
      for (const base of [preview.httpUrl, preview.httpsUrl]) {
        for (const path of ["/multi", "/api/runtime", "/healthz", "/assets/app.js"]) {
          const result = await get(`${base}${path}`, { Host: "piik.test:18788", Origin: "https://piik.test:18788" }, ca);
          expect(result.status).toBe(200); expect(result.body.toString()).toBe(`Go route ${path}`);
          expect(requests.at(-1)).toEqual({ path, host: "piik.test:18788", origin: "https://piik.test:18788" });
        }
        const result = await get(`${base}/piik-lan.cer`, {}, ca);
        expect(result.status).toBe(200); expect(result.headers["content-type"]).toBe("application/pkix-cert");
        expect(result.body).toEqual(certificate);
        for (const path of ["/private.pfx", "/../private.pfx", "/lan-config.json"]) {
          expect((await get(`${base}${path}`, {}, ca)).status).toBe(404);
        }
        const origin = base;
        client = new WebSocket(`${base.replace(/^http/, "ws")}/signal`, { origin, ca });
        await once(client, "open"); const echoed = once(client, "message"); client.send("screen-signal");
        expect((await echoed)[0].toString()).toBe("screen-signal");
        expect(requests.at(-1)).toMatchObject({ path: "/signal", origin, host: new URL(base).host });
        const ended = once(client, "close"); client.close(); await ended;
      }
      const rejection = new WebSocket(`${preview.httpUrl.replace(/^http/, "ws")}/signal`, { origin: "https://denied.example" });
      rejection.on("error", () => undefined);
      const [error] = await once(rejection, "error"); expect(error.message).toContain("403");
      // Open upgraded sockets must be retired by the same owner as the listeners.
      client = new WebSocket(`${preview.httpsUrl.replace(/^http/, "ws")}/signal`, { origin: preview.httpsUrl, ca });
      await once(client, "open"); const ended = once(client, "close");
      await preview.close(); await preview.close(); await ended;
      const replacement = await startLanPreview(config(backendPort,
        Number(new URL(preview.httpUrl).port), Number(new URL(preview.httpsUrl).port)));
      await replacement.close();
    } finally {
      client?.terminate(); await preview.close(); websocket.close(); await close(backend);
    }
  }, 15_000);

  it("releases the HTTP listener if HTTPS cannot bind, and returns bounded backend errors", async () => {
    const backend = createServer((_request, response) => response.end("ready"));
    const backendPort = await listen(backend);
    const holder = createServer(), reserved = createServer();
    const httpsPort = await listen(holder), httpPort = await listen(reserved); await close(reserved);
    try {
      await expect(startLanPreview(config(backendPort, httpPort, httpsPort))).rejects.toMatchObject({ code: "EADDRINUSE" });
      await new Promise<void>((resolve, reject) => {
        reserved.once("error", reject); reserved.listen(httpPort, "127.0.0.1", () => resolve());
      });
      await close(reserved);
      const preview = await startLanPreview(config(backendPort, httpPort));
      try {
        await close(backend);
        expect((await get(`${preview.httpUrl}/healthz`)).status).toBe(502);
      } finally { await preview.close(); }
    } finally { await close(holder); await close(reserved); await close(backend); }
  });
});
