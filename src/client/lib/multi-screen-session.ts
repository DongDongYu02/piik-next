import type { ClientMessage, MultiScreenPeer, ServerMessage, SfuSignalMessage } from "../../shared/protocol";
import type { SignalConnectionState } from "../types";
import { QUALITY_PROFILES, QUALITY_RESOLUTIONS } from "../media/quality";
import { SfuPublisher, type SfuConnectionConfig } from "../sfu/publisher";
import { SfuSubscriber } from "../sfu/subscriber";
import { createOpaqueId } from "./opaque-id";
import { SignalingClient } from "./signaling";

export const MULTI_SCREEN_PROFILE = QUALITY_PROFILES["1080p60"];
export type MultiScreenIdentity = ConstructorParameters<typeof SignalingClient>[0];
export type { MultiScreenPeer } from "../../shared/protocol";

export interface MultiScreenEvents {
  onRoster: (peers: MultiScreenPeer[]) => void;
  onStream: (peerId: string, stream: MediaStream | null) => void;
  onStatus: (status: SignalConnectionState) => void;
  onError: (code: string) => void;
  onLocalStopped: () => void;
  onAccessRequired: () => void;
}

interface Publication {
  stream: MediaStream;
  generation: string;
  ended: () => void;
}

interface MediaEdge {
  peerId: string;
  generation: string;
  direction: "send" | "receive";
  connection: RTCPeerConnection;
  stream: MediaStream | null;
  candidates: RTCIceCandidateInit[];
  localCandidates: RTCIceCandidateInit[];
  descriptionSent: boolean;
  descriptionReceived: boolean;
  closed: boolean;
  work: Promise<void>;
}

type SfuSlot = {
  sourcePeerId: string;
  generation: string;
  connectionId: string;
  config: SfuConnectionConfig;
  closed: boolean;
  work: Promise<void>;
} & (
  { direction: "send"; endpoint: SfuPublisher } |
  { direction: "receive"; endpoint: SfuSubscriber }
);

const MAX_PENDING_CANDIDATES = 128;

/** A room uses either direct per-recipient edges or one SFU uplink per source. */
export class MultiScreenSession {
  private readonly signaling: SignalingClient;
  private ownPeerId: string | null = null;
  private connected = false;
  private stopped = false;
  private peers = new Map<string, MultiScreenPeer>();
  private publication: Publication | null = null;
  private configuration: RTCConfiguration = { iceServers: [] };
  private transport: "p2p" | "sfu" | null = null;
  private readonly outgoing = new Map<string, MediaEdge>();
  private readonly incoming = new Map<string, MediaEdge>();
  private publisher: SfuSlot | null = null;
  private readonly subscribers = new Map<string, SfuSlot>();

  constructor(identity: MultiScreenIdentity, private readonly events: MultiScreenEvents) {
    this.signaling = new SignalingClient(identity, {
      onMessage: message => this.receive(message),
      onStatus: status => {
        this.connected = status === "connected";
        if (!this.connected) this.disconnectMedia();
        this.events.onStatus(status);
      },
      onTerminated: reason => this.events.onError(reason),
      onAccessRequired: () => this.events.onAccessRequired(),
    });
  }

  get peerId(): string | null { return this.ownPeerId; }

  get canShare(): boolean {
    return !this.stopped && this.connected && this.ownPeerId !== null && this.peers.has(this.ownPeerId);
  }

  start(): void { this.signaling.start(); }

  stop(): void {
    if (this.stopped) return;
    this.stopLocal(true);
    this.stopped = true;
    this.disconnectMedia();
    this.signaling.stop();
  }

  /** Transfers capture ownership to the session, including all captured tracks. */
  setStream(stream: MediaStream | null): boolean {
    if (!stream) {
      this.stopLocal(true);
      return true;
    }
    if (this.publication?.stream === stream) return true;
    if (!this.canShare || !stream.getVideoTracks().some(track => track.readyState === "live")) {
      for (const track of stream.getTracks()) track.stop();
      this.events.onError("MULTI_SCREEN_NOT_READY");
      return false;
    }
    this.stopLocal(false);
    const publication: Publication = {
      stream,
      generation: createOpaqueId(),
      ended: () => {
        if (this.publication === publication) this.stopLocal(true);
      },
    };
    this.publication = publication;
    for (const track of stream.getVideoTracks()) track.addEventListener("ended", publication.ended);
    if (!this.signaling.send({ type: "multi-screen-state", generation: publication.generation })) {
      this.stopLocal(true);
      this.events.onError("MULTI_SCREEN_SIGNAL_FAILED");
      return false;
    }
    // The roster echo commits this publication before any offer can leave.
    return true;
  }

  private receive(message: ServerMessage): void {
    if (this.stopped) return;
    if (message.type === "authenticated") {
      this.ownPeerId = message.peerId;
      this.configuration = { iceServers: message.iceConfig.iceServers };
      this.signaling.send({ type: "multi-screen-join" });
    } else if (message.type === "multi-screen-roster") {
      if (message.peerId !== this.ownPeerId) return;
      const publication = this.publication;
      const withdrawn = publication && this.peers.get(this.ownPeerId)?.generation === publication.generation &&
        message.peers.find(peer => peer.peerId === this.ownPeerId)?.generation !== publication.generation;
      this.transport = message.transport;
      this.peers = new Map(message.peers.map(peer => [peer.peerId, peer]));
      if (withdrawn) this.stopLocal(true);
      this.reconcileEdges();
      this.events.onRoster(message.peers);
    } else if (message.type === "multi-screen-signal") {
      this.receiveSignal(message);
    } else if (message.type === "multi-screen-sfu-config") {
      this.receiveSfuConfig(message);
    } else if (message.type === "multi-screen-sfu-signal") {
      this.receiveSfuSignal(message);
    } else if (message.type === "multi-screen-sfu-closed") {
      const slot = message.sourcePeerId === this.ownPeerId
        ? this.publisher : this.subscribers.get(message.sourcePeerId);
      if (slot && message.publicationGeneration === slot.generation && message.connectionId === slot.connectionId) {
        this.failSfu(slot, false);
      }
    } else if (message.type === "multi-screen-rejected") {
      if (message.command === "state") this.stopLocal(true);
      this.events.onError(`MULTI_SCREEN_${message.reason.toUpperCase().replaceAll("-", "_")}`);
    } else if (message.type === "error") {
      this.events.onError(message.code);
    } else if (message.type === "room-closed" || message.type === "viewer-grant-revoked") {
      this.stop();
      this.events.onError(message.type === "room-closed" ? "ROOM_NOT_FOUND" : "ROOM_ACCESS_DENIED");
    }
  }

  private reconcileEdges(): void {
    if (this.publisher && !this.currentSfu(this.publisher)) this.retireSfu(this.publisher);
    for (const slot of this.subscribers.values()) {
      if (!this.currentSfu(slot, true)) this.retireSfu(slot);
    }
    for (const edge of this.incoming.values()) {
      if (this.transport !== "p2p" || this.peers.get(edge.peerId)?.generation !== edge.generation) this.retire(edge);
    }
    for (const edge of this.outgoing.values()) {
      if (this.transport !== "p2p" || !this.peers.has(edge.peerId) || this.publication?.generation !== edge.generation ||
        this.peers.get(this.ownPeerId!)?.generation !== edge.generation) this.retire(edge);
    }
    const publication = this.publication;
    if (this.transport !== "p2p" || !this.canShare || !publication || this.peers.get(this.ownPeerId!)?.generation !== publication.generation) return;
    for (const peer of this.peers.values()) {
      if (peer.peerId === this.ownPeerId || this.outgoing.has(peer.peerId)) continue;
      const edge = this.createEdge(peer.peerId, publication.generation, "send");
      this.queue(edge, async () => {
        const resolution = QUALITY_RESOLUTIONS[MULTI_SCREEN_PROFILE.resolution];
        for (const track of publication.stream.getTracks()) {
          const { width = resolution.width, height = resolution.height } = track.getSettings();
          edge.connection.addTransceiver(track, {
            direction: "sendonly", streams: [publication.stream],
            ...(track.kind === "video" ? {
              sendEncodings: [{
                maxBitrate: MULTI_SCREEN_PROFILE.maxBitrate, maxFramerate: MULTI_SCREEN_PROFILE.maxFramerate,
                scaleResolutionDownBy: Math.max(1, width / resolution.width, height / resolution.height),
              }],
            } : {}),
          });
        }
        const offer = await edge.connection.createOffer();
        if (!this.current(edge)) return;
        await edge.connection.setLocalDescription(offer);
        if (!this.current(edge)) return;
        this.sendDescription(edge, "offer");
      });
    }
  }

  private receiveSignal(message: Extract<ServerMessage, { type: "multi-screen-signal" }>): void {
    if (this.transport !== "p2p" || !this.canShare || message.targetPeerId !== this.ownPeerId ||
      message.sourcePeerId === this.ownPeerId || !this.peers.has(message.sourcePeerId)) return;
    const ownPublication = this.publication?.generation === message.generation;
    let edge = ownPublication ? this.outgoing.get(message.sourcePeerId) : this.incoming.get(message.sourcePeerId);
    if (!ownPublication && this.peers.get(message.sourcePeerId)?.generation !== message.generation) return;
    if (!edge && !ownPublication && message.kind !== "answer") {
      edge = this.createEdge(message.sourcePeerId, message.generation, "receive");
    }
    if (!edge || edge.generation !== message.generation || !this.current(edge)) return;
    if (message.kind === "ice") {
      try {
        const candidate: unknown = JSON.parse(message.payload);
        if (!candidate || typeof candidate !== "object" || !("candidate" in candidate) ||
          typeof candidate.candidate !== "string") throw new Error("Invalid ICE candidate");
        if (edge.candidates.length >= MAX_PENDING_CANDIDATES) throw new Error("Too many ICE candidates");
        edge.candidates.push(candidate as RTCIceCandidateInit);
        this.queue(edge, () => this.flushCandidates(edge!));
      } catch {
        this.fail(edge);
      }
      return;
    }
    if ((message.kind === "answer") !== ownPublication || edge.descriptionReceived) return;
    edge.descriptionReceived = true;
    this.queue(edge, async () => {
      await edge.connection.setRemoteDescription({ type: message.kind as "offer" | "answer", sdp: message.payload });
      if (!this.current(edge)) return;
      await this.flushCandidates(edge);
      if (!this.current(edge) || message.kind === "answer") return;
      const answer = await edge.connection.createAnswer();
      if (!this.current(edge)) return;
      await edge.connection.setLocalDescription(answer);
      if (this.current(edge)) this.sendDescription(edge, "answer");
    });
  }

  private createEdge(peerId: string, generation: string, direction: MediaEdge["direction"]): MediaEdge {
    const connection = new RTCPeerConnection(this.configuration);
    const edge: MediaEdge = {
      peerId, generation, direction, connection, stream: null, candidates: [], localCandidates: [],
      descriptionSent: false, descriptionReceived: false, closed: false, work: Promise.resolve(),
    };
    (direction === "send" ? this.outgoing : this.incoming).set(peerId, edge);
    connection.addEventListener("icecandidate", event => {
      if (!this.current(edge) || !event.candidate) return;
      const candidate = event.candidate.toJSON();
      if (edge.descriptionSent) this.sendSignal(edge, "ice", JSON.stringify(candidate));
      else if (edge.localCandidates.length < MAX_PENDING_CANDIDATES) edge.localCandidates.push(candidate);
      else this.fail(edge);
    });
    connection.addEventListener("track", event => {
      if (!this.current(edge) || direction !== "receive") return;
      edge.stream ??= event.streams[0] ?? new MediaStream();
      if (!edge.stream.getTracks().includes(event.track)) edge.stream.addTrack(event.track);
      this.events.onStream(peerId, edge.stream);
    });
    connection.addEventListener("connectionstatechange", () => {
      if (this.current(edge) && connection.connectionState === "failed") this.fail(edge);
    });
    return edge;
  }

  private current(edge: MediaEdge): boolean {
    const edges = edge.direction === "send" ? this.outgoing : this.incoming;
    return this.transport === "p2p" && !edge.closed && this.canShare && edges.get(edge.peerId) === edge &&
      (edge.direction === "send" ? this.publication?.generation : this.peers.get(edge.peerId)?.generation) === edge.generation;
  }

  private queue(edge: MediaEdge, work: () => Promise<void>): void {
    edge.work = edge.work.then(() => this.current(edge) ? work() : undefined).catch(() => this.fail(edge));
  }

  private async flushCandidates(edge: MediaEdge): Promise<void> {
    while (this.current(edge) && edge.connection.remoteDescription && edge.candidates.length) {
      await edge.connection.addIceCandidate(edge.candidates.shift()!);
    }
  }

  private sendDescription(edge: MediaEdge, kind: "offer" | "answer"): void {
    const sdp = edge.connection.localDescription?.sdp;
    if (!sdp || !this.sendSignal(edge, kind, sdp)) return;
    edge.descriptionSent = true;
    for (const candidate of edge.localCandidates.splice(0)) {
      if (!this.sendSignal(edge, "ice", JSON.stringify(candidate))) break;
    }
  }

  private sendSignal(edge: MediaEdge, kind: "offer" | "answer" | "ice", payload: string): boolean {
    if (!this.current(edge) || !this.ownPeerId) return false;
    const message: ClientMessage = {
      type: "multi-screen-signal", sourcePeerId: this.ownPeerId, targetPeerId: edge.peerId,
      generation: edge.generation, kind, payload,
    };
    if (this.signaling.send(message)) return true;
    this.fail(edge);
    return false;
  }

  private fail(edge: MediaEdge): void {
    if (!this.current(edge)) return;
    // Keep the failed slot until the publication or recipient retires. Reusing
    // its generation for a new PC would admit late answers from the old PC.
    this.closeEdge(edge);
    this.events.onError("MULTI_SCREEN_CONNECTION_FAILED");
  }

  private retire(edge: MediaEdge): void {
    const edges = edge.direction === "send" ? this.outgoing : this.incoming;
    if (edges.get(edge.peerId) !== edge) return;
    edges.delete(edge.peerId);
    this.closeEdge(edge);
  }

  private closeEdge(edge: MediaEdge): void {
    if (edge.closed) return;
    edge.closed = true;
    edge.connection.close();
    edge.candidates.length = 0;
    edge.localCandidates.length = 0;
    if (edge.direction === "receive") {
      for (const track of edge.stream?.getTracks() ?? []) track.stop();
      edge.stream = null;
      this.events.onStream(edge.peerId, null);
    }
  }

  private receiveSfuConfig(message: Extract<ServerMessage, { type: "multi-screen-sfu-config" }>): void {
    const sourcePeerId = message.sourcePeerId;
    const generation = message.publicationGeneration;
    if (this.transport !== "sfu" || !this.canShare ||
      this.peers.get(sourcePeerId)?.generation !== generation) return;
    const sending = sourcePeerId === this.ownPeerId;
    if (sending && this.publication?.generation !== generation) return;
    const previous = sending ? this.publisher : this.subscribers.get(sourcePeerId);
    if (previous?.generation === generation && previous.connectionId === message.connectionId) {
      if (!previous.closed) {
        previous.config = message;
        previous.endpoint.updateConfig(message);
      }
      return;
    }
    if (previous) this.retireSfu(previous);
    let slot: SfuSlot;
    const common = { sourcePeerId, generation, connectionId: message.connectionId, config: message, closed: false, work: Promise.resolve() };
    slot = sending
      ? { ...common, direction: "send", endpoint: new SfuPublisher({
        send: signal => this.sendSfuSignal(slot, signal),
        onDisconnected: () => this.failSfu(slot),
      }) }
      : { ...common, direction: "receive", endpoint: new SfuSubscriber({
        send: signal => this.sendSfuSignal(slot, signal),
        onStream: stream => {
          if (this.currentSfu(slot)) this.events.onStream(sourcePeerId, stream);
        },
        onDisconnected: () => this.failSfu(slot),
      }) };
    if (sending) this.publisher = slot;
    else this.subscribers.set(sourcePeerId, slot);
    this.queueSfu(slot, async () => {
      const connected = await slot.endpoint.connect(slot.config);
      if (!this.currentSfu(slot)) return;
      if (!connected) { this.failSfu(slot); return; }
      slot.endpoint.updateConfig(slot.config);
      const activated = slot.direction === "send"
        ? await slot.endpoint.activate(this.publication!.stream, MULTI_SCREEN_PROFILE)
        : slot.endpoint.activate();
      if (!activated && this.currentSfu(slot)) this.failSfu(slot);
    });
  }

  private receiveSfuSignal(message: Extract<ServerMessage, { type: "multi-screen-sfu-signal" }>): void {
    const slot = message.sourcePeerId === this.ownPeerId
      ? this.publisher : this.subscribers.get(message.sourcePeerId);
    if (!slot || !this.currentSfu(slot) || message.signal.connectionId !== slot.connectionId ||
      message.signal.publicationGeneration !== slot.generation) return;
    this.queueSfu(slot, () => slot.endpoint.acceptSignal(message.signal));
  }

  private currentSfu(slot: SfuSlot, includeClosed = false): boolean {
    return this.transport === "sfu" && (includeClosed || !slot.closed) && this.canShare &&
      (slot.direction === "send" ? this.publisher === slot && this.publication?.generation === slot.generation
        : this.subscribers.get(slot.sourcePeerId) === slot) &&
      this.peers.get(slot.sourcePeerId)?.generation === slot.generation;
  }

  private queueSfu(slot: SfuSlot, work: () => Promise<void>): void {
    slot.work = slot.work.then(() => this.currentSfu(slot) ? work() : undefined).catch(() => this.failSfu(slot));
  }

  private sendSfuSignal(slot: SfuSlot, signal: SfuSignalMessage): boolean {
    if (!this.currentSfu(slot) || signal.connectionId !== slot.connectionId ||
      signal.publicationGeneration !== slot.generation) return false;
    if (this.signaling.send({ type: "multi-screen-sfu-signal", sourcePeerId: slot.sourcePeerId, signal })) return true;
    this.failSfu(slot);
    return false;
  }

  private failSfu(slot: SfuSlot, notifyServer = true): void {
    if (!this.currentSfu(slot)) return;
    if (notifyServer) this.signaling.send({
      type: "multi-screen-sfu-closed", sourcePeerId: slot.sourcePeerId,
      publicationGeneration: slot.generation, connectionId: slot.connectionId,
    });
    // A failed subscription retains its slot until a new connection identity or
    // source generation arrives; old SDP cannot revive its closed endpoint.
    this.closeSfu(slot);
    if (slot.direction === "send") this.stopLocal(true);
    this.events.onError("MULTI_SCREEN_CONNECTION_FAILED");
  }

  private retireSfu(slot: SfuSlot): void {
    if (slot.direction === "send") {
      if (this.publisher !== slot) return;
      this.publisher = null;
    } else {
      if (this.subscribers.get(slot.sourcePeerId) !== slot) return;
      this.subscribers.delete(slot.sourcePeerId);
    }
    this.closeSfu(slot);
  }

  private closeSfu(slot: SfuSlot): void {
    if (slot.closed) return;
    slot.closed = true;
    void slot.endpoint.disconnect();
    if (slot.direction === "receive") this.events.onStream(slot.sourcePeerId, null);
  }

  private stopLocal(notify: boolean): void {
    const publication = this.publication;
    if (!publication) return;
    this.publication = null;
    if (this.publisher) this.retireSfu(this.publisher);
    for (const edge of this.outgoing.values()) this.retire(edge);
    for (const track of publication.stream.getVideoTracks()) track.removeEventListener("ended", publication.ended);
    for (const track of publication.stream.getTracks()) track.stop();
    if (this.canShare) this.signaling.send({ type: "multi-screen-state", generation: null });
    if (notify) this.events.onLocalStopped();
  }

  private disconnectMedia(): void {
    this.stopLocal(true);
    for (const slot of this.subscribers.values()) this.retireSfu(slot);
    for (const edge of this.incoming.values()) this.retire(edge);
    for (const edge of this.outgoing.values()) this.retire(edge);
    this.peers.clear();
    this.transport = null;
    this.ownPeerId = null;
    this.events.onRoster([]);
  }
}
