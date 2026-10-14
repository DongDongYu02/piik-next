import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, MultiScreenPeer, ServerMessage, SfuSignalMessage } from "../src/shared/protocol";
import { MULTI_SCREEN_PROFILE, MultiScreenSession } from "../src/client/lib/multi-screen-session";
import { SignalingClient } from "../src/client/lib/signaling";
import { SfuPublisher } from "../src/client/sfu/publisher";
import { SfuSubscriber } from "../src/client/sfu/subscriber";

vi.mock("../src/client/lib/signaling", () => ({
  SignalingClient: vi.fn(function (_identity, events) {
    return { events, start: vi.fn(), stop: vi.fn(), send: vi.fn(() => true) };
  }),
}));

vi.mock("../src/client/sfu/publisher", () => ({
  SfuPublisher: vi.fn(function (events) {
    return { events, connect: vi.fn(async () => true), activate: vi.fn(async () => true),
      acceptSignal: vi.fn(async () => {}), updateConfig: vi.fn(), disconnect: vi.fn(async () => {}) };
  }),
}));
vi.mock("../src/client/sfu/subscriber", () => ({
  SfuSubscriber: vi.fn(function (events) {
    return { events, connect: vi.fn(async () => true), activate: vi.fn(() => true),
      acceptSignal: vi.fn(async () => {}), updateConfig: vi.fn(), disconnect: vi.fn(async () => {}) };
  }),
}));

const self = "self_peer_12345678";
const alice = "alice_peer_12345678";
const bob = "bob_peer_12345678";
const carol = "carol_peer_12345678";
const aliceGeneration = "alice_share_12345678";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(finish => { resolve = finish; });
  return { promise, resolve };
}

class Track extends EventTarget {
  readyState = "live";
  stop = vi.fn(() => { this.readyState = "ended"; });
  getSettings = () => ({ width: 1920, height: 1080 });
  constructor(readonly kind: "video" | "audio" = "video") { super(); }
}

class Stream {
  constructor(private tracks: Track[] = [new Track()]) {}
  getTracks = () => this.tracks;
  getVideoTracks = () => this.tracks.filter(track => track.kind === "video");
  addTrack = (track: Track) => { this.tracks.push(track); };
}

class Peer extends EventTarget {
  static instances: Peer[] = [];
  static plans: Array<{ remote?: Promise<void>; local?: Promise<void>; ice?: Promise<void> }> = [];
  readonly plan = Peer.plans.shift() ?? {};
  remoteDescription: RTCSessionDescriptionInit | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  connectionState = "new";
  close = vi.fn(() => { this.connectionState = "closed"; });
  createOffer = vi.fn(async () => ({ type: "offer" as const, sdp: "offer-sdp" }));
  createAnswer = vi.fn(async () => ({ type: "answer" as const, sdp: "answer-sdp" }));
  setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    await this.plan.local;
    this.localDescription = description;
    this.ice("candidate-local");
  });
  setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    await this.plan.remote;
    this.remoteDescription = description;
  });
  addIceCandidate = vi.fn(async (_candidate: RTCIceCandidateInit) => { await this.plan.ice; });
  addTransceiver = vi.fn((_track: Track, _options: RTCRtpTransceiverInit) => ({}));
  constructor(readonly configuration: RTCConfiguration) { super(); Peer.instances.push(this); }
  ice(candidate: string) {
    this.dispatchEvent(Object.assign(new Event("icecandidate"), {
      candidate: { toJSON: () => ({ candidate, sdpMid: "0", sdpMLineIndex: 0 }) },
    }));
  }
  track(stream: Stream) {
    this.dispatchEvent(Object.assign(new Event("track"), { streams: [stream], track: stream.getTracks()[0] }));
  }
}

beforeEach(() => {
  Peer.instances = [];
  Peer.plans = [];
  vi.mocked(SignalingClient).mockClear();
  vi.mocked(SfuPublisher).mockClear();
  vi.mocked(SfuSubscriber).mockClear();
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("MediaStream", Stream);
});
afterEach(() => { vi.unstubAllGlobals(); });

function fixture(mode: "p2p" | "sfu" = "p2p") {
  const events = {
    onRoster: vi.fn(), onStream: vi.fn(), onStatus: vi.fn(), onError: vi.fn(),
    onLocalStopped: vi.fn(), onAccessRequired: vi.fn(),
  };
  const session = new MultiScreenSession({ role: "viewer", roomId: "1234", clientId: "client_12345678" }, events);
  const transport = vi.mocked(SignalingClient).mock.results.at(-1)!.value as {
    events: ConstructorParameters<typeof SignalingClient>[1];
    send: ReturnType<typeof vi.fn<(message: ClientMessage) => boolean>>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
  const message = (value: object) => transport.events.onMessage(value as ServerMessage);
  const authenticated = () => {
    transport.events.onStatus("connected");
    message({ type: "authenticated", peerId: self, iceConfig: { iceServers: [{ urls: "stun:share.test:3478" }] } });
  };
  const roster = (peers: MultiScreenPeer[]) => message({ type: "multi-screen-roster", peerId: self, transport: mode, peers });
  const member = (peerId: string, generation: string | null = null): MultiScreenPeer => ({ peerId, generation, displayName: peerId });
  const join = () => { authenticated(); roster([member(self), member(alice)]); };
  const stateMessages = () => transport.send.mock.calls.map(([sent]) => sent).filter(sent => sent.type === "multi-screen-state");
  const signals = () => transport.send.mock.calls.map(([sent]) => sent).filter(sent => sent.type === "multi-screen-signal");
  const publish = (stream = new Stream(), others = [member(alice)]) => {
    expect(session.setStream(stream as unknown as MediaStream)).toBe(true);
    const generation = stateMessages().at(-1)!.generation!;
    roster([member(self, generation), ...others]);
    return { stream, generation };
  };
  const signal = (kind: "offer" | "answer" | "ice", generation = aliceGeneration, payload = kind === "ice" ? '{"candidate":"candidate-remote"}' : `${kind}-sdp`, sourcePeerId = alice) => {
    message({ type: "multi-screen-signal", sourcePeerId, targetPeerId: self, generation, kind, payload });
  };
  const sfuConfig = (sourcePeerId: string, generation: string, connectionId = `sfu_connection_${sourcePeerId}`) => {
    const config = { revision: 1, publicationGeneration: generation, connectionId };
    message({ type: "multi-screen-sfu-config", sourcePeerId, ...config });
    return config;
  };
  const sfuSignal = (sourcePeerId: string, config: ReturnType<typeof sfuConfig>, kind: SfuSignalMessage["kind"] = "description") => {
    const signal: SfuSignalMessage = { type: "sfu-signal", ...config, kind,
      ...(kind === "description" ? { description: { type: sourcePeerId === self ? "answer" : "offer", sdp: "sfu-sdp" } } : {}) };
    message({ type: "multi-screen-sfu-signal", sourcePeerId, signal });
    return signal;
  };
  const sfuClosed = (sourcePeerId: string, config: ReturnType<typeof sfuConfig>) => {
    message({ type: "multi-screen-sfu-closed", sourcePeerId,
      publicationGeneration: config.publicationGeneration, connectionId: config.connectionId });
  };
  return { session, events, transport, message, authenticated, roster, member, join, publish, stateMessages, signals, signal, sfuConfig, sfuSignal, sfuClosed };
}

describe("browser multi-screen publication lifecycle", () => {
  it("joins after room authentication and waits for roster commit before sending bounded mesh offers", async () => {
    const f = fixture();
    f.session.start();
    expect(f.transport.start).toHaveBeenCalledOnce();
    expect(f.session.canShare).toBe(false);
    f.authenticated();
    expect(f.transport.send).toHaveBeenLastCalledWith({ type: "multi-screen-join" });
    expect(f.session.canShare).toBe(false);
    f.roster([f.member(self), f.member(alice), f.member(bob), f.member(carol)]);
    const stream = new Stream([new Track(), new Track("audio")]);
    f.session.setStream(stream as unknown as MediaStream);
    expect(Peer.instances).toHaveLength(0);
    const generation = f.stateMessages().at(-1)!.generation!;
    f.roster([f.member(self, generation), f.member(alice), f.member(bob), f.member(carol)]);
    await vi.waitFor(() => expect(f.signals().filter(sent => sent.kind === "offer")).toHaveLength(3));
    for (const peer of Peer.instances) {
      expect(peer.configuration).toEqual({ iceServers: [{ urls: "stun:share.test:3478" }] });
      expect(peer.addTransceiver).toHaveBeenCalledTimes(2);
      expect(peer.addTransceiver.mock.calls[0]![1].direction).toBe("sendonly");
      expect(peer.addTransceiver.mock.calls[0]![1].sendEncodings).toEqual([{ maxBitrate: 8_000_000, maxFramerate: 60, scaleResolutionDownBy: 1 }]);
      expect(peer.addTransceiver.mock.calls[1]![1].sendEncodings).toBeUndefined();
    }
    // Local trickle gathered during setLocalDescription follows its offer.
    for (const peerId of [alice, bob, carol]) expect(f.signals().filter(sent => sent.targetPeerId === peerId).map(sent => sent.kind)).toEqual(["offer", "ice"]);
    f.session.stop();
    for (const track of stream.getTracks()) expect(track.stop).toHaveBeenCalledOnce();
  });

  it("scales a 4K source to the shared 1080p60 publication profile", async () => {
    const f = fixture(); f.join();
    const track = new Track();
    track.getSettings = () => ({ width: 3840, height: 2160 });
    f.publish(new Stream([track]));
    await vi.waitFor(() => expect(Peer.instances[0]?.addTransceiver).toHaveBeenCalledOnce());
    expect(Peer.instances[0]!.addTransceiver.mock.calls[0]![1].sendEncodings).toEqual([
      { maxBitrate: 8_000_000, maxFramerate: 60, scaleResolutionDownBy: 2 },
    ]);
    f.session.stop();
  });

  it("keeps receiving a friend's screen when local sharing stops and keeps sending when the friend stops", async () => {
    const f = fixture(); f.join();
    const local = f.publish(new Stream(), [f.member(alice, aliceGeneration)]);
    await vi.waitFor(() => expect(f.signals().some(sent => sent.kind === "offer")).toBe(true));
    const outgoing = Peer.instances[0]!;
    f.signal("offer");
    await vi.waitFor(() => expect(f.signals().some(sent => sent.kind === "answer")).toBe(true));
    const incoming = Peer.instances[1]!;
    const remoteStream = new Stream(); incoming.track(remoteStream);
    expect(f.events.onStream).toHaveBeenLastCalledWith(alice, remoteStream);
    f.session.setStream(null);
    expect(outgoing.close).toHaveBeenCalledOnce();
    expect(local.stream.getTracks()[0]!.stop).toHaveBeenCalledOnce();
    expect(incoming.close).not.toHaveBeenCalled();
    const restarted = f.publish(new Stream(), [f.member(alice, aliceGeneration)]);
    await vi.waitFor(() => expect(Peer.instances[2]?.setLocalDescription).toHaveBeenCalledOnce());
    f.roster([f.member(self, restarted.generation), f.member(alice)]);
    expect(incoming.close).toHaveBeenCalledOnce();
    expect(remoteStream.getTracks()[0]!.stop).toHaveBeenCalledOnce();
    expect(f.events.onStream).toHaveBeenLastCalledWith(alice, null);
    expect(Peer.instances[2]!.close).not.toHaveBeenCalled();
    f.session.stop();
  });

  it("queues ICE before the offer and drains candidates arriving during a pending flush exactly once", async () => {
    const f = fixture(); f.join(); f.roster([f.member(self), f.member(alice, aliceGeneration)]);
    const candidateGate = deferred(); Peer.plans.push({ ice: candidateGate.promise });
    f.signal("ice", aliceGeneration, '{"candidate":"first"}');
    const incoming = Peer.instances[0]!;
    await Promise.resolve();
    expect(incoming.addIceCandidate).not.toHaveBeenCalled();
    f.signal("offer");
    await vi.waitFor(() => expect(incoming.addIceCandidate).toHaveBeenCalledOnce());
    f.signal("ice", aliceGeneration, '{"candidate":"second"}');
    f.signal("ice", aliceGeneration, '{"candidate":"third"}');
    candidateGate.resolve();
    await vi.waitFor(() => expect(incoming.addIceCandidate).toHaveBeenCalledTimes(3));
    expect(incoming.addIceCandidate.mock.calls.map(([candidate]) => candidate.candidate)).toEqual(["first", "second", "third"]);
    await vi.waitFor(() => expect(f.signals().map(sent => sent.kind)).toEqual(["answer", "ice"]));
    f.session.stop();
  });

  it("fences a pending incoming offer and stale candidates after the publisher changes generation", async () => {
    const f = fixture(); f.join(); f.roster([f.member(self), f.member(alice, aliceGeneration)]);
    const remoteGate = deferred(); Peer.plans.push({ remote: remoteGate.promise });
    f.signal("offer");
    await vi.waitFor(() => expect(Peer.instances[0]?.setRemoteDescription).toHaveBeenCalledOnce());
    const newGeneration = "alice_share_new_12345678";
    f.roster([f.member(self), f.member(alice, newGeneration)]);
    f.signal("ice"); f.signal("offer");
    expect(Peer.instances).toHaveLength(1);
    f.signal("offer", newGeneration);
    await vi.waitFor(() => expect(f.signals().filter(sent => sent.kind === "answer")).toHaveLength(1));
    Peer.instances[0]!.ice("candidate-stale"); remoteGate.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(Peer.instances[0]!.close).toHaveBeenCalledOnce();
    expect(f.signals().every(sent => sent.generation === newGeneration)).toBe(true);
    f.session.stop();
  });

  it("does not emit a late outgoing offer after stopping or apply an answer from the previous publication", async () => {
    const f = fixture(); f.join();
    const localGate = deferred(); Peer.plans.push({ local: localGate.promise });
    const old = f.publish();
    await vi.waitFor(() => expect(Peer.instances[0]?.setLocalDescription).toHaveBeenCalledOnce());
    f.session.setStream(null);
    const current = f.publish();
    await vi.waitFor(() => expect(f.signals().some(sent => sent.kind === "offer")).toBe(true));
    f.signal("answer", old.generation); f.signal("ice", old.generation);
    expect(Peer.instances[1]!.setRemoteDescription).not.toHaveBeenCalled();
    localGate.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.signals().every(sent => sent.generation === current.generation)).toBe(true);
    f.signal("answer", current.generation); f.signal("answer", current.generation);
    await vi.waitFor(() => expect(Peer.instances[1]!.setRemoteDescription).toHaveBeenCalledOnce());
    f.session.stop();
  });

  it("stops capture and every media edge on reconnect and requires an explicit new share after rejoining", async () => {
    const f = fixture(); f.join();
    const local = f.publish(new Stream(), [f.member(alice, aliceGeneration)]);
    f.signal("offer");
    await vi.waitFor(() => expect(Peer.instances).toHaveLength(2));
    f.transport.events.onStatus("reconnecting");
    expect(local.stream.getTracks()[0]!.stop).toHaveBeenCalledOnce();
    expect(f.events.onLocalStopped).toHaveBeenCalledOnce();
    expect(f.events.onRoster).toHaveBeenLastCalledWith([]);
    for (const peer of Peer.instances) expect(peer.close).toHaveBeenCalledOnce();
    expect(f.session.peerId).toBeNull(); expect(f.session.canShare).toBe(false);
    f.authenticated(); f.roster([f.member(self), f.member(alice)]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.session.canShare).toBe(true);
    expect(Peer.instances).toHaveLength(2);
    expect(f.stateMessages().filter(sent => sent.generation !== null)).toHaveLength(1);
    f.session.stop();
  });

  it("cleans up browser-ended capture and locally rejected publication while preserving the joined room", async () => {
    const f = fixture(); f.join();
    const capture = f.publish();
    capture.stream.getVideoTracks()[0]!.dispatchEvent(new Event("ended"));
    expect(f.events.onLocalStopped).toHaveBeenCalledOnce();
    expect(f.stateMessages().at(-1)).toEqual({ type: "multi-screen-state", generation: null });
    const second = f.publish();
    f.message({ type: "multi-screen-rejected", command: "state", reason: "invalid-state" });
    expect(second.stream.getTracks()[0]!.stop).toHaveBeenCalledOnce();
    expect(f.events.onError).toHaveBeenLastCalledWith("MULTI_SCREEN_INVALID_STATE");
    expect(f.session.canShare).toBe(true); expect(f.transport.stop).not.toHaveBeenCalled();
    f.session.stop();
  });

  it("rejects capture before opt-in, isolates a failed edge, and releases departed recipients", async () => {
    const f = fixture(); const early = new Stream();
    expect(f.session.setStream(early as unknown as MediaStream)).toBe(false);
    expect(early.getTracks()[0]!.stop).toHaveBeenCalledOnce();
    f.join(); const local = f.publish(new Stream(), [f.member(alice), f.member(bob)]);
    await vi.waitFor(() => expect(f.signals().filter(sent => sent.kind === "offer")).toHaveLength(2));
    Peer.instances[0]!.connectionState = "failed";
    Peer.instances[0]!.dispatchEvent(new Event("connectionstatechange"));
    expect(f.events.onError).toHaveBeenLastCalledWith("MULTI_SCREEN_CONNECTION_FAILED");
    expect(local.stream.getTracks()[0]!.stop).not.toHaveBeenCalled();
    expect(Peer.instances[1]!.close).not.toHaveBeenCalled();
    // An unrelated roster update cannot reuse a failed connection generation.
    f.roster([f.member(self, local.generation), f.member(alice), f.member(bob)]);
    f.signal("answer", local.generation);
    await Promise.resolve();
    expect(Peer.instances).toHaveLength(2);
    expect(Peer.instances[0]!.setRemoteDescription).not.toHaveBeenCalled();
    f.roster([f.member(self, local.generation)]);
    expect(Peer.instances[1]!.close).toHaveBeenCalledOnce();
    f.session.stop();
  });
});

interface SfuEndpointMock {
  events: { send: (signal: SfuSignalMessage) => boolean; onDisconnected: () => void;
    onStream?: (stream: MediaStream | null) => void };
  connect: ReturnType<typeof vi.fn>;
  activate: ReturnType<typeof vi.fn>;
  acceptSignal: ReturnType<typeof vi.fn>;
  updateConfig: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}
const publisher = (index = 0) => vi.mocked(SfuPublisher).mock.results[index]!.value as SfuEndpointMock;
const subscriber = (index = 0) => vi.mocked(SfuSubscriber).mock.results[index]!.value as SfuEndpointMock;

describe("browser multi-screen server forwarding", () => {
  it("waits for committed sources, publishes one uplink, and subscribes to at most the three other sources", async () => {
    const f = fixture("sfu"); f.join();
    f.session.setStream(new Stream() as unknown as MediaStream);
    const generation = f.stateMessages().at(-1)!.generation!;
    f.sfuConfig(self, generation);
    expect(SfuPublisher).not.toHaveBeenCalled();
    f.roster([f.member(self, generation), f.member(alice, aliceGeneration),
      f.member(bob, "bob_share_12345678"), f.member(carol, "carol_share_12345678")]);
    const own = f.sfuConfig(self, generation);
    const first = f.sfuConfig(alice, aliceGeneration);
    f.sfuConfig(bob, "bob_share_12345678"); f.sfuConfig(carol, "carol_share_12345678");
    f.sfuConfig("outsider_peer_12345678", "outsider_share_12345678");
    const ownAnswer = f.sfuSignal(self, own);
    const incomingOffer = f.sfuSignal(alice, first);
    await vi.waitFor(() => expect(subscriber().acceptSignal).toHaveBeenCalledWith(incomingOffer));
    expect(SfuPublisher).toHaveBeenCalledOnce(); expect(SfuSubscriber).toHaveBeenCalledTimes(3);
    expect(Peer.instances).toHaveLength(0);
    expect(publisher().activate).toHaveBeenCalledWith(expect.anything(), MULTI_SCREEN_PROFILE);
    expect(publisher().acceptSignal).toHaveBeenCalledWith(ownAnswer);
    for (const index of [0, 1, 2]) expect(subscriber(index).activate).toHaveBeenCalledOnce();
    const stream = new Stream() as unknown as MediaStream;
    subscriber().events.onStream?.(stream);
    expect(f.events.onStream).toHaveBeenLastCalledWith(alice, stream);
    const candidate: SfuSignalMessage = { type: "sfu-signal", ...first, kind: "candidate", candidate: { candidate: "candidate-sfu" } };
    expect(subscriber().events.send(candidate)).toBe(true);
    expect(f.transport.send).toHaveBeenLastCalledWith({ type: "multi-screen-sfu-signal", sourcePeerId: alice, signal: candidate });
    f.message({ type: "multi-screen-sfu-config", sourcePeerId: alice, ...first, revision: 2 });
    expect(subscriber().updateConfig).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }));
    expect(SfuSubscriber).toHaveBeenCalledTimes(3);
    // Direct-peer signals cannot open a second media transport in SFU rooms.
    f.signal("offer"); expect(Peer.instances).toHaveLength(0);
    f.session.stop();
  });

  it("stops only its own publication and retires only the departed source's subscription", async () => {
    const f = fixture("sfu"); f.join();
    const local = f.publish(new Stream(), [f.member(alice, aliceGeneration), f.member(bob, "bob_share_12345678")]);
    f.sfuConfig(self, local.generation); f.sfuConfig(alice, aliceGeneration); f.sfuConfig(bob, "bob_share_12345678");
    await vi.waitFor(() => expect(publisher().activate).toHaveBeenCalledOnce());
    f.session.setStream(null);
    expect(publisher().disconnect).toHaveBeenCalledOnce();
    expect(local.stream.getTracks()[0]!.stop).toHaveBeenCalledOnce();
    expect(subscriber().disconnect).not.toHaveBeenCalled(); expect(subscriber(1).disconnect).not.toHaveBeenCalled();
    f.roster([f.member(self), f.member(alice), f.member(bob, "bob_share_12345678")]);
    expect(subscriber().disconnect).toHaveBeenCalledOnce();
    expect(f.events.onStream).toHaveBeenLastCalledWith(alice, null);
    expect(subscriber(1).disconnect).not.toHaveBeenCalled();
    f.session.stop(); expect(subscriber(1).disconnect).toHaveBeenCalledOnce();
  });

  it("uses the latest configuration when an earlier endpoint connect is still pending", async () => {
    const f = fixture("sfu"); f.join(); f.roster([f.member(self), f.member(alice, aliceGeneration)]);
    const first = f.sfuConfig(alice, aliceGeneration);
    const gate = deferred(); subscriber().connect.mockImplementation(async () => { await gate.promise; return true; });
    await vi.waitFor(() => expect(subscriber().connect).toHaveBeenCalledOnce());
    const latest = { type: "multi-screen-sfu-config", sourcePeerId: alice, ...first, revision: 2 };
    f.message(latest); subscriber().updateConfig.mockClear();
    gate.resolve();
    await vi.waitFor(() => expect(subscriber().activate).toHaveBeenCalledOnce());
    expect(subscriber().updateConfig).toHaveBeenCalledExactlyOnceWith(latest);
    expect(subscriber().updateConfig.mock.invocationCallOrder[0]).toBeLessThan(subscriber().activate.mock.invocationCallOrder[0]!);
    f.session.stop();
  });

  it.each(["p2p", "sfu"] as const)("ends a committed %s capture when the authoritative roster withdraws it before closure", async mode => {
    const f = fixture(mode); f.join();
    const local = f.publish(new Stream(), [f.member(alice, aliceGeneration)]);
    const ownConfig = mode === "sfu" ? f.sfuConfig(self, local.generation) : null;
    if (mode === "sfu") {
      f.sfuConfig(alice, aliceGeneration);
      await vi.waitFor(() => expect(publisher().activate).toHaveBeenCalledOnce());
    } else await vi.waitFor(() => expect(f.signals().some(sent => sent.kind === "offer")).toBe(true));
    f.roster([f.member(self), f.member(alice, aliceGeneration)]);
    expect(local.stream.getTracks()[0]!.stop).toHaveBeenCalledOnce();
    expect(f.events.onLocalStopped).toHaveBeenCalledOnce();
    expect(f.stateMessages().at(-1)).toEqual({ type: "multi-screen-state", generation: null });
    expect(f.session.canShare).toBe(true);
    if (ownConfig) {
      f.sfuClosed(self, ownConfig);
      expect(subscriber().disconnect).not.toHaveBeenCalled();
      expect(publisher().disconnect).toHaveBeenCalledOnce();
    } else expect(Peer.instances[0]!.close).toHaveBeenCalledOnce();
    expect(f.events.onLocalStopped).toHaveBeenCalledOnce();
    f.session.stop();
  });

  it.each(["p2p", "sfu"] as const)("preserves a pending replacement %s capture when the old stop's roster echo arrives", async mode => {
    const f = fixture(mode); f.join();
    const first = f.publish();
    const ownConfig = mode === "sfu" ? f.sfuConfig(self, first.generation) : null;
    if (mode === "sfu") await vi.waitFor(() => expect(publisher().activate).toHaveBeenCalledOnce());
    else await vi.waitFor(() => expect(f.signals().some(sent => sent.kind === "offer")).toBe(true));
    const replacement = new Stream();
    f.session.setStream(replacement as unknown as MediaStream);
    const nextGeneration = f.stateMessages().at(-1)!.generation!;
    expect(nextGeneration).not.toBe(first.generation);
    f.roster([f.member(self), f.member(alice)]);
    if (ownConfig) f.sfuClosed(self, ownConfig);
    expect(replacement.getTracks()[0]!.stop).not.toHaveBeenCalled();
    expect(f.events.onLocalStopped).not.toHaveBeenCalled();
    expect(f.stateMessages().at(-1)!.generation).toBe(nextGeneration);
    f.roster([f.member(self, nextGeneration), f.member(alice)]);
    if (mode === "sfu") {
      f.sfuConfig(self, nextGeneration, "replacement_connection_12345678");
      await vi.waitFor(() => expect(publisher(1).activate).toHaveBeenCalledOnce());
    } else await vi.waitFor(() => expect(f.signals().filter(sent => sent.kind === "offer")).toHaveLength(2));
    expect(replacement.getTracks()[0]!.stop).not.toHaveBeenCalled();
    f.session.stop();
  });

  it("fences pending connects, late signals, closure and stream callbacks after source replacement", async () => {
    const f = fixture("sfu"); f.join(); f.roster([f.member(self), f.member(alice, aliceGeneration)]);
    const old = f.sfuConfig(alice, aliceGeneration);
    const gate = deferred(); subscriber().connect.mockImplementation(async () => { await gate.promise; return true; });
    f.sfuSignal(alice, old);
    await vi.waitFor(() => expect(subscriber().connect).toHaveBeenCalledOnce());
    const nextGeneration = "alice_new_share_12345678";
    f.roster([f.member(self), f.member(alice, nextGeneration)]);
    const next = f.sfuConfig(alice, nextGeneration, "new_connection_12345678");
    f.sfuConfig(alice, aliceGeneration); f.sfuSignal(alice, old); f.sfuClosed(alice, old);
    await vi.waitFor(() => expect(subscriber(1).activate).toHaveBeenCalledOnce());
    const stream = new Stream() as unknown as MediaStream;
    subscriber(1).events.onStream?.(stream);
    subscriber().events.onStream?.(null); subscriber().events.onDisconnected();
    gate.resolve(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(subscriber().disconnect).toHaveBeenCalledOnce();
    expect(subscriber().activate).not.toHaveBeenCalled(); expect(subscriber().acceptSignal).not.toHaveBeenCalled();
    expect(f.events.onStream).toHaveBeenLastCalledWith(alice, stream);
    expect(f.events.onError).not.toHaveBeenCalled();
    const answer = f.sfuSignal(alice, next);
    await vi.waitFor(() => expect(subscriber(1).acceptSignal).toHaveBeenCalledWith(answer));
    f.session.stop();
  });

  it("reports an exact failed subscription once and does not reuse its closed connection identity", async () => {
    const f = fixture("sfu"); f.join();
    const local = f.publish(new Stream(), [f.member(alice, aliceGeneration), f.member(bob, "bob_share_12345678")]);
    f.sfuConfig(self, local.generation); const first = f.sfuConfig(alice, aliceGeneration); f.sfuConfig(bob, "bob_share_12345678");
    await vi.waitFor(() => expect(subscriber(1).activate).toHaveBeenCalledOnce());
    subscriber().events.onDisconnected(); subscriber().events.onDisconnected();
    expect(subscriber().disconnect).toHaveBeenCalledOnce();
    expect(f.events.onError).toHaveBeenCalledExactlyOnceWith("MULTI_SCREEN_CONNECTION_FAILED");
    expect(f.transport.send).toHaveBeenLastCalledWith({ type: "multi-screen-sfu-closed", sourcePeerId: alice,
      publicationGeneration: first.publicationGeneration, connectionId: first.connectionId });
    expect(publisher().disconnect).not.toHaveBeenCalled(); expect(subscriber(1).disconnect).not.toHaveBeenCalled();
    expect(local.stream.getTracks()[0]!.stop).not.toHaveBeenCalled();
    f.roster([f.member(self, local.generation), f.member(alice, aliceGeneration), f.member(bob, "bob_share_12345678")]);
    f.sfuConfig(alice, aliceGeneration); f.sfuSignal(alice, first); f.sfuClosed(alice, first);
    await Promise.resolve(); expect(SfuSubscriber).toHaveBeenCalledTimes(2);
    expect(subscriber().acceptSignal).not.toHaveBeenCalled();
    // Only a fresh server-owned identity can prepare a replacement.
    f.sfuConfig(alice, aliceGeneration, "replacement_connection_12345678");
    await vi.waitFor(() => expect(subscriber(2).activate).toHaveBeenCalledOnce());
    f.session.stop();
  });

  it("stops capture after publisher failure while preserving the other screens and fences a late close", async () => {
    const f = fixture("sfu"); f.join();
    const local = f.publish(new Stream(), [f.member(alice, aliceGeneration)]);
    const first = f.sfuConfig(self, local.generation); f.sfuConfig(alice, aliceGeneration);
    await vi.waitFor(() => expect(publisher().activate).toHaveBeenCalledOnce());
    publisher().events.onDisconnected();
    expect(local.stream.getTracks()[0]!.stop).toHaveBeenCalledOnce();
    expect(f.events.onLocalStopped).toHaveBeenCalledOnce();
    expect(subscriber().disconnect).not.toHaveBeenCalled();
    expect(f.stateMessages().at(-1)).toEqual({ type: "multi-screen-state", generation: null });
    expect(f.transport.send.mock.calls.map(([sent]) => sent)).toContainEqual({ type: "multi-screen-sfu-closed", sourcePeerId: self,
      publicationGeneration: first.publicationGeneration, connectionId: first.connectionId });
    const next = f.publish(new Stream(), [f.member(alice, aliceGeneration)]);
    f.sfuConfig(self, next.generation, "new_own_connection_12345678");
    await vi.waitFor(() => expect(publisher(1).activate).toHaveBeenCalledOnce());
    f.sfuClosed(self, first);
    expect(next.stream.getTracks()[0]!.stop).not.toHaveBeenCalled();
    expect(publisher(1).disconnect).not.toHaveBeenCalled();
    f.session.stop();
  });

  it("accepts server closure without echo and closes every media resource when signaling reconnects", async () => {
    const f = fixture("sfu"); f.join();
    const local = f.publish(new Stream(), [f.member(alice, aliceGeneration), f.member(bob, "bob_share_12345678")]);
    f.sfuConfig(self, local.generation); const first = f.sfuConfig(alice, aliceGeneration); f.sfuConfig(bob, "bob_share_12345678");
    await vi.waitFor(() => expect(subscriber(1).activate).toHaveBeenCalledOnce());
    const beforeClose = f.transport.send.mock.calls.length;
    f.sfuClosed(alice, first);
    expect(f.transport.send.mock.calls).toHaveLength(beforeClose);
    expect(subscriber().disconnect).toHaveBeenCalledOnce(); expect(subscriber(1).disconnect).not.toHaveBeenCalled();
    f.transport.events.onStatus("reconnecting");
    expect(publisher().disconnect).toHaveBeenCalledOnce(); expect(subscriber(1).disconnect).toHaveBeenCalledOnce();
    expect(local.stream.getTracks()[0]!.stop).toHaveBeenCalledOnce(); expect(f.session.canShare).toBe(false);
    f.authenticated(); f.roster([f.member(self), f.member(alice)]);
    f.sfuConfig(self, local.generation);
    expect(SfuPublisher).toHaveBeenCalledOnce();
    expect(f.session.canShare).toBe(true); f.session.stop();
  });
});
