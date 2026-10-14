import { strict as assert } from "node:assert";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createSocket } from "node:dgram";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { DEFAULT_ROUTE_POLICY } from "../src/shared/protocol";
import {
  CdpConnection, cleanupRun, createPage, evaluate, fetchJsonBefore, launchChrome,
  reservePort, waitForSample, waitForVersion, withDeadline, type PageHandle,
} from "./browser-gate-harness";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "build", "gates", "multi-screen");
// The default is a lifecycle smoke test. Opt in to the 12-encoder/12-decoder
// single-host workload; it is not a physical-device 1080p60 acceptance test.
const stress = process.env.PIIK_MULTI_SCREEN_GATE_STRESS === "1";
const serverMedia = process.env.PIIK_MULTI_SCREEN_GATE_SFU === "1";
const fixture = String.raw`
import { MultiScreenSession, MULTI_SCREEN_PROFILE } from "./src/client/lib/multi-screen-session";
import { QUALITY_RESOLUTIONS } from "./src/client/media/quality";
const errors = [], pcs = [], sources = [], streams = new Map(), videos = new Map();
let session, peers = [], local = null, status = "offline", stopped = 0;
const PC = RTCPeerConnection;
globalThis.RTCPeerConnection = class extends PC {
  constructor(...args) { super(...args); pcs.push(this); }
};
addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
navigator.mediaDevices.getDisplayMedia = async () => {
  const { width, height } = ${stress} ? QUALITY_RESOLUTIONS[MULTI_SCREEN_PROFILE.resolution] : { width: 640, height: 360 };
  const framerate = ${stress} ? MULTI_SCREEN_PROFILE.maxFramerate : 15;
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d"); let frame = 0;
  const source = { canvas, stream: null, draws: 0, lastDraw: 0 }; sources.push(source);
  const draw = () => {
    source.draws++; source.lastDraw = performance.now();
    context.fillStyle = "#152d32"; context.fillRect(0, 0, width, height);
    context.fillStyle = "#68dab3"; context.fillRect((frame++ * 11) % 580, 30, 60, 180);
    context.fillStyle = "white"; context.font = "48px sans-serif"; context.fillText(String(frame), 30, 300);
  };
  draw(); const timer = setInterval(draw, 1000 / framerate), stream = canvas.captureStream(framerate);
  source.stream = stream;
  for (const track of stream.getTracks()) {
    const stop = track.stop.bind(track); track.stop = () => { clearInterval(timer); stop(); };
  }
  return stream;
};
globalThis.multiGate = {
  connect(identity) {
    session = new MultiScreenSession(identity, {
      onRoster(next) { peers = next; },
      onStatus(next) { status = next; },
      onError(error) { errors.push(error); },
      onAccessRequired() { errors.push("ACCESS_REQUIRED"); },
      onLocalStopped() { stopped++; local = null; },
      onStream(peerId, stream) {
        if (stream && streams.get(peerId) === stream) return;
        const old = videos.get(peerId); if (old) { old.srcObject = null; old.remove(); }
        streams.delete(peerId); videos.delete(peerId);
        if (!stream) return;
        streams.set(peerId, stream);
        const video = document.createElement("video");
        video.autoplay = true; video.muted = true; video.playsInline = true; video.srcObject = stream;
        document.body.append(video); videos.set(peerId, video);
        void video.play().catch(error => { if (videos.get(peerId) === video) errors.push(String(error)); });
      },
    });
    session.start();
  },
  async share() {
    const stream = await navigator.mediaDevices.getDisplayMedia();
    if (!session.setStream(stream)) throw new Error("Publication was not accepted");
    local = stream;
  },
  stop() { session.setStream(null); },
  leave() { session.stop(); },
  async diagnostics() {
    return {
      sources: sources.map(source => ({ draws: source.draws, sinceLastDrawMs: performance.now() - source.lastDraw,
        tracks: source.stream.getTracks().map(track => ({ state: track.readyState, settings: track.getSettings() })) })),
      stats: await Promise.all(pcs.filter(pc => pc.connectionState !== "closed").map(async pc => {
        const report = await pc.getStats();
        return [...report.values()].filter(value => ["media-source", "outbound-rtp", "inbound-rtp", "codec"].includes(value.type));
      })),
    };
  },
  sample() {
    return {
      peerId: session.peerId, canShare: session.canShare, status, peers, errors, stopped, transport: session.transport,
      localLive: local?.getVideoTracks().some(track => track.readyState === "live") ?? false,
      receives: [...videos].map(([peerId, video]) => ({
        peerId, frames: video.getVideoPlaybackQuality().totalVideoFrames,
        width: video.videoWidth, live: streams.get(peerId).getVideoTracks().some(track => track.readyState === "live"),
      })),
      connections: pcs.filter(pc => pc.connectionState !== "closed").map(pc => pc.connectionState),
      publications: pcs.filter(pc => pc.connectionState !== "closed" && pc.getTransceivers().some(
        transceiver => transceiver.direction === "sendonly" && transceiver.sender.track?.kind === "video")).length,
    };
  },
};`;

interface Sample {
  peerId: string | null; canShare: boolean; status: string;
  transport: "p2p" | "sfu" | null;
  peers: Array<{ peerId: string; generation: string | null }>;
  errors: string[]; stopped: number; localLive: boolean;
  receives: Array<{ peerId: string; frames: number; width: number; live: boolean }>;
  connections: string[];
  publications: number;
}

async function browserExecutable(): Promise<string> {
  if (process.env.CHROME_PATH?.trim()) return process.env.CHROME_PATH.trim();
  const candidates = process.platform === "win32" ? [
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
  ] : process.platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ] : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* Try the next standard install. */ }
  }
  throw new Error("Chrome or Edge was not found; set CHROME_PATH to its executable");
}

async function startFixture(port: number, serverPort: number): Promise<Server> {
  const bundled = await build({ stdin: { contents: fixture, resolveDir: root },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022" });
  const javascript = bundled.outputFiles[0]!.contents;
  const server = createServer((request, response) => {
    if (request.url === "/__multi-gate") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end('<!doctype html><meta charset="utf-8"><title>Piik synthetic multi-screen gate</title><style>video{width:240px}</style><script type="module" src="/__multi-gate.js"></script>');
      return;
    }
    if (request.url === "/__multi-gate.js") {
      response.setHeader("Content-Type", "text/javascript"); response.end(javascript); return;
    }
    const upstream = httpRequest({ host: "127.0.0.1", port: serverPort, method: request.method,
      path: request.url, headers: request.headers }, incoming => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response);
    });
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  server.on("upgrade", (request, socket, head) => {
    const upstream = httpRequest({ host: "127.0.0.1", port: serverPort,
      path: request.url, headers: request.headers });
    upstream.on("upgrade", (response, remote, upstreamHead) => {
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n` +
        Object.entries(response.headers).map(([key, value]) => `${key}: ${value}\r\n`).join("") + "\r\n");
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) remote.write(head);
      socket.on("error", () => remote.destroy()); remote.on("error", () => socket.destroy());
      socket.pipe(remote); remote.pipe(socket);
    });
    upstream.on("error", () => socket.destroy()); upstream.end();
  });
  server.listen(port, "127.0.0.1"); await once(server, "listening");
  return server;
}

async function run() {
  await mkdir(output, { recursive: true });
  const chromePath = await browserExecutable();
  const profile = await mkdtemp(join(tmpdir(), "piik-client-media-"));
  const [serverPort, fixturePort, debugPort] = await Promise.all([reservePort(), reservePort(), reservePort()]);
  assert.equal(new Set([serverPort, fixturePort, debugPort]).size, 3);
  const origin = `http://127.0.0.1:${fixturePort}`;
  async function reserveUdpPort() {
    const socket = createSocket("udp4");
    try {
      socket.bind(0, "127.0.0.1"); await once(socket, "listening");
      return socket.address().port;
    } finally { await new Promise<void>(done => socket.close(() => done())); }
  }
  const mediaPort = serverMedia ? await reserveUdpPort() : null;
  let server: ChildProcessWithoutNullStreams | null = null;
  let chrome: ChildProcessWithoutNullStreams | null = null;
  let cdp: CdpConnection | null = null;
  let proxy: Server | null = null;
  let stage = "build-server", failure: unknown;
  const pages: PageHandle[] = [];
  const evidence: Record<string, unknown> = { transport: serverMedia ? "sfu" : "p2p",
    workload: stress ? "synthetic-1920x1080-60fps" : "synthetic-640x360-15fps-lifecycle" };
  try {
    const executable = join(output, process.platform === "win32" ? "piik-server.exe" : "piik-server");
    const compiled = spawnSync(process.env.PIIK_GO?.trim() || "go", ["build", "-trimpath", "-o", executable, "./cmd/piik-server"],
      { cwd: root, encoding: "utf8", windowsHide: true, timeout: 120_000 });
    if (compiled.error) throw compiled.error;
    if (compiled.status !== 0) throw new Error(compiled.stderr || "Server build failed");
    stage = "start-server";
    server = spawn(executable, [], { cwd: profile, windowsHide: true, stdio: "pipe", env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      PIIK_ENV: "development", ROOM_DATABASE_PATH: ":memory:", LISTEN_HOST: "127.0.0.1",
      PORT: String(serverPort), PUBLIC_BASE_URL: origin, ALLOWED_ORIGINS: origin,
      ...(mediaPort ? { SFU_UDP_PORT: String(mediaPort), SFU_LISTEN_HOST: "127.0.0.1", SFU_PUBLIC_IP: "127.0.0.1", SFU_ONLY: "true" } : {}),
    } });
    server.stdout.resume(); server.stderr.resume(); await once(server, "spawn");
    await waitForSample(deadline => fetchJsonBefore<{ status: string }>(`http://127.0.0.1:${serverPort}/healthz`, deadline),
      sample => sample.status === "ok", 20_000);
    proxy = await startFixture(fixturePort, serverPort);
    const response = await fetch(`${origin}/api/rooms`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ codeEntryPolicy: "open" }) });
    assert.equal(response.status, 201);
    const room = await response.json() as { roomId: string; hostToken: string; inviteUrl: string };
    assert.ok(room.roomId && room.hostToken && room.inviteUrl);
    const viewerGrant = new URLSearchParams(new URL(room.inviteUrl).hash.slice(1)).get("v");
    assert.ok(viewerGrant);
    stage = "start-browser";
    chrome = await launchChrome(chromePath, debugPort, profile, [
      "--headless=new", "--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--autoplay-policy=no-user-gesture-required",
    ]);
    chrome.stdout.resume(); chrome.stderr.resume();
    const version = await waitForVersion(debugPort, chrome); evidence.browser = version.Browser;
    cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, Date.now() + 10_000);
    async function participant(index: number) {
      const context = await cdp!.call<{ browserContextId: string }>("Target.createBrowserContext", {}, undefined, Date.now() + 5000);
      const page = await createPage(cdp!, `${origin}/__multi-gate`, undefined, true, context.browserContextId);
      pages.push(page);
      const identity = index === 0 ? {
        role: "host", roomId: room.roomId, token: room.hostToken, clientId: `gate_host_${index}_12345678`,
        roomOnly: true, roomSession: true, viewerPresence: true, displayName: "Gate Host",
        routePolicy: DEFAULT_ROUTE_POLICY,
      } : {
        role: "viewer", roomId: room.roomId, viewerGrant, clientId: `gate_viewer_${index}_12345678`,
        viewerPresence: true, displayName: `Gate Viewer ${index}`,
      };
      await evaluate(cdp!, page, `multiGate.connect(${JSON.stringify(identity)})`, Date.now() + 5000);
      return page;
    }
    const sample = (page: PageHandle, deadline = Date.now() + 5000) => evaluate<Sample>(cdp!, page, "multiGate.sample()", deadline);
    const samples = () => Promise.all(pages.map(page => sample(page)));
    async function ready(targets: PageHandle[], participants: number, remoteScreens: (index: number) => number) {
      await waitForSample(deadline => Promise.all(targets.map(page => sample(page, deadline))), next =>
        next.every((value, index) => value.canShare && value.peers.length === participants &&
          value.receives.length === remoteScreens(index) && value.receives.every(video => video.live && video.width > 0 && video.frames > 2)), 25_000);
    }
    async function progress(targets: PageHandle[]) {
      const before = await Promise.all(targets.map(page => sample(page)));
      await waitForSample(deadline => Promise.all(targets.map(page => sample(page, deadline))), next =>
        next.every((value, index) => before[index]!.receives.every(previous => {
          const current = value.receives.find(video => video.peerId === previous.peerId);
          return current?.live && current.frames > previous.frames + 2;
        })), 10_000);
      return Promise.all(targets.map(page => sample(page)));
    }
    stage = "four-joined";
    for (let index = 0; index < 4; index++) await participant(index);
    await waitForSample(deadline => Promise.all(pages.map(page => sample(page, deadline))), next =>
      next.every(value => value.canShare && value.peers.length === 4), 15_000);
    stage = "four-simultaneous-publications";
    await Promise.all(pages.map(page => evaluate(cdp!, page, "multiGate.share()", Date.now() + 5000)));
    await ready(pages, 4, () => 3);
    evidence.simultaneous = await progress(pages);
    const initial = evidence.simultaneous as Sample[], hostId = initial[0]!.peerId!;
    const originalGeneration = initial[0]!.peers.find(peer => peer.peerId === hostId)!.generation;
    assert.ok(originalGeneration);
    assert.ok(initial.every(value => value.transport === (serverMedia ? "sfu" : "p2p")));
    assert.ok(initial.every(value => value.connections.length === (serverMedia ? 4 : 6)));
    assert.ok(initial.every(value => value.publications === (serverMedia ? 1 : 3)));
    stage = "independent-stop";
    await evaluate(cdp, pages[0]!, "multiGate.stop()", Date.now() + 5000);
    await ready(pages, 4, index => index === 0 ? 3 : 2);
    const stopped = await progress(pages);
    assert.equal(stopped[0]!.localLive, false);
    assert.equal(stopped[0]!.publications, 0);
    assert.ok(stopped.every(value => value.peers.find(peer => peer.peerId === hostId)!.generation === null));
    evidence.independentStop = stopped;
    stage = "fresh-publication-generation";
    await evaluate(cdp, pages[0]!, "multiGate.share()", Date.now() + 5000);
    await ready(pages, 4, () => 3);
    const restarted = await progress(pages);
    assert.notEqual(restarted[0]!.peers.find(peer => peer.peerId === hostId)!.generation, originalGeneration);
    evidence.restart = restarted;
    stage = "fifth-rejected";
    const fifth = await participant(4);
    await waitForSample(deadline => sample(fifth, deadline), value => value.errors.includes("MULTI_SCREEN_ROOM_FULL"), 10_000);
    const rejected = await sample(fifth); assert.equal(rejected.canShare, false); assert.equal(rejected.connections.length, 0);
    evidence.fifthRejected = rejected;
    stage = "leave-and-newcomer";
    await evaluate(cdp, fifth, "multiGate.leave()", Date.now() + 5000);
    await evaluate(cdp, pages[3]!, "multiGate.leave()", Date.now() + 5000);
    const remaining = pages.slice(0, 3);
    await ready(remaining, 3, () => 2); await progress(remaining);
    const newcomer = await participant(5);
    await waitForSample(deadline => sample(newcomer, deadline), value => value.canShare && value.peers.length === 4, 10_000);
    await evaluate(cdp, newcomer, "multiGate.share()", Date.now() + 5000);
    const current = [...remaining, newcomer]; await ready(current, 4, () => 3);
    evidence.newcomer = await progress(current);
    assert.ok((evidence.newcomer as Sample[]).every(value => value.connections.length === (serverMedia ? 4 : 6)));
    for (const value of [...initial, ...stopped, ...restarted, ...(evidence.newcomer as Sample[])]) assert.deepEqual(value.errors, []);
    if (stress) {
      evidence.mediaStats = await Promise.all(current.map(page => evaluate(cdp!, page,
        "multiGate.diagnostics()", Date.now() + 10_000).catch(error => ({ error: String(error) }))));
    }
    stage = "retire-all";
    await Promise.all(pages.map(page => evaluate(cdp!, page, "multiGate.leave()", Date.now() + 5000)));
    const retired = await samples();
    assert.ok(retired.every(value => !value.localLive && !value.canShare && value.connections.length === 0 && value.receives.length === 0));
    evidence.retired = retired;
    stage = "passed";
  } catch (error) {
    failure = error;
    if (cdp) evidence.atFailure = await Promise.all(pages.map(page => evaluate<Sample>(cdp!, page, "multiGate.sample()", Date.now() + 10_000).catch(error => ({ error: String(error) }))));
    if (cdp) evidence.diagnostics = await Promise.all(pages.map(page => evaluate(cdp!, page, "multiGate.diagnostics()", Date.now() + 10_000).catch(error => ({ error: String(error) }))));
  } finally {
    const fixtureClosed = proxy ? new Promise<void>(resolveClose => {
      proxy!.closeAllConnections(); proxy!.close(() => resolveClose());
    }) : Promise.resolve();
    const cleanup = await cleanupRun({ cdp, chrome, native: null, server, profile, ports: [serverPort, fixturePort, debugPort] });
    let proxyClosed = true;
    try { await withDeadline(() => fixtureClosed, Date.now() + 5000); } catch { proxyClosed = false; }
    evidence.cleanup = { ...cleanup, fixtureClosed: proxyClosed };
    let udpClosed = true;
    if (mediaPort) {
      const socket = createSocket("udp4");
      try { socket.bind(mediaPort, "127.0.0.1"); await once(socket, "listening"); }
      catch { udpClosed = false; }
      finally { try { await new Promise<void>(done => socket.close(() => done())); } catch { } }
    }
    evidence.udpClosed = udpClosed;
    const passed = stage === "passed" && proxyClosed && udpClosed && Object.values(cleanup).every(Boolean);
    const evidencePath = join(output, `multi-screen${serverMedia ? "-sfu" : ""}${stress ? "-1080p60" : ""}.json`);
    await writeFile(evidencePath, JSON.stringify({ passed, stage,
      ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}), ...evidence }, null, 2));
    console.log(JSON.stringify({ passed, stage, evidence: evidencePath, cleanup, udpClosed }));
    if (!passed) { console.error(failure ?? "Gate cleanup failed"); process.exitCode = 1; }
  }
}

await run();
