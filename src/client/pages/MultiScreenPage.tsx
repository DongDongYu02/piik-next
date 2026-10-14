import { useEffect, useRef, useState, type FormEvent } from "react";
import { createRoomResponseSchema, DEFAULT_ROUTE_POLICY } from "../../shared/protocol";
import { AppHeader } from "../components/living/Header";
import { Btn } from "../components/living/primitives";
import { Comic } from "../components/living/Comic";
import { createRoom, ApiError } from "../lib/api";
import { createOpaqueId } from "../lib/opaque-id";
import { readDisplayName, saveDisplayName } from "../lib/display-name";
import { clearViewerGrant, isValidRoomId, type ViewerRoute } from "../lib/session";
import { MULTI_SCREEN_PROFILE, MultiScreenSession, type MultiScreenIdentity, type MultiScreenPeer } from "../lib/multi-screen-session";
import { captureDisplay } from "../media/quality";
import type { SignalConnectionState } from "../types";
import { Glyph } from "../ui/icons";
import { useCopy, type CopyKey } from "../ui/copy";
import "./multi-screen.css";

const OWNER_KEY = "piik:multi-owner:v1";
const ownerSchema = createRoomResponseSchema.pick({ roomId: true, hostToken: true, inviteUrl: true });
type Owner = ReturnType<typeof ownerSchema.parse>;

function readOwner(roomId?: string): Owner | null {
  try {
    const parsed = ownerSchema.safeParse(JSON.parse(sessionStorage.getItem(OWNER_KEY) ?? "null"));
    return parsed.success && parsed.data.roomId === roomId ? parsed.data : null;
  } catch { return null; }
}

function multiInvite(invite: string, roomId: string): string {
  const url = new URL(invite);
  url.pathname = `/multi/r/${roomId}`;
  return url.toString();
}

function errorKey(code: string): CopyKey {
  switch (code) {
    case "ROOM_NOT_FOUND": return "viewer.msg.notFound";
    case "ROOM_ACCESS_DENIED": return "viewer.msg.accessFailed";
    case "INVALID_TOKEN": return "viewer.msg.invalidInvite";
    case "ROOM_FULL": case "MULTI_SCREEN_ROOM_FULL": return "multi.err.full";
    case "HOST_ALREADY_CONNECTED": case "SESSION_REPLACED": return "multi.err.replaced";
    case "STALE_CLIENT": return "multi.unavailable";
    default: return "multi.err.connection";
  }
}

export function MultiScreenPage({ route, available, onAuthorizationRequired }: {
  route?: ViewerRoute; available: boolean; onAuthorizationRequired?: () => void;
}) {
  const { t, vis } = useCopy();
  const [owner, setOwner] = useState(() => readOwner(route?.roomId));
  const [name, setName] = useState<string>(() => readDisplayName());
  const [code, setCode] = useState(route?.roomId ?? "");
  const [password, setPassword] = useState("");
  const [identity, setIdentity] = useState<MultiScreenIdentity | null>(null);
  const [peers, setPeers] = useState<MultiScreenPeer[]>([]);
  const [streams, setStreams] = useState<Record<string, MediaStream>>({});
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<SignalConnectionState>("offline");
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [failure, setFailure] = useState<CopyKey | null>(null);
  const [notice, setNotice] = useState<CopyKey | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const session = useRef<MultiScreenSession | null>(null);
  const epoch = useRef(0);
  const mounted = useRef(true);
  const accessCallback = useRef(onAuthorizationRequired);
  accessCallback.current = onAuthorizationRequired;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++epoch.current; }; }, []);
  useEffect(() => {
    if (!identity) return;
    setFailure(null);
    setPeers([]);
    const connection = new MultiScreenSession(identity, {
      onRoster: next => {
        setPeers(next);
        setFocused(current => next.some(peer => peer.peerId === current) ? current : null);
      },
      onStream: (peerId, stream) => setStreams(current => {
        const next = { ...current };
        if (stream) next[peerId] = stream; else delete next[peerId];
        return next;
      }),
      onStatus: next => {
        if (next !== "connected") { ++epoch.current; setCapturing(false); }
        setStatus(next);
      },
      onError: error => setFailure(errorKey(error)),
      onLocalStopped: () => { ++epoch.current; setLocal(null); setCapturing(false); },
      onAccessRequired: () => { setFailure("gate.expired"); accessCallback.current?.(); },
    });
    session.current = connection;
    connection.start();
    return () => {
      ++epoch.current;
      connection.stop();
      if (session.current === connection) session.current = null;
    };
  }, [identity, retry]);

  function participantName() {
    const displayName = saveDisplayName(name);
    if (!displayName) setFailure("multi.err.name");
    return displayName;
  }

  function connect(roomId: string, owned: Owner | null = null) {
    const displayName = participantName();
    if (!displayName) return;
    setNotice(null);
    setFailure(null);
    history.replaceState(history.state, "", `/multi/r/${roomId}`);
    setIdentity(owned ? {
      role: "host", roomId, token: owned.hostToken, clientId: createOpaqueId(),
      roomOnly: true, roomSession: true, routePolicy: DEFAULT_ROUTE_POLICY, viewerPresence: true, displayName,
    } : {
      role: "viewer", roomId, clientId: createOpaqueId(), viewerPresence: true, displayName,
      ...(route?.roomId === roomId && route.viewerGrant ? { viewerGrant: route.viewerGrant } : {}),
      ...(password ? { viewerPassword: password } : {}),
    });
    setPassword("");
  }

  async function create() {
    if (!participantName()) return;
    setBusy(true); setFailure(null);
    try {
      const created = await createRoom("open", null);
      if (!mounted.current) return;
      const next = { roomId: created.roomId, hostToken: created.hostToken, inviteUrl: multiInvite(created.inviteUrl, created.roomId) };
      try { sessionStorage.setItem(OWNER_KEY, JSON.stringify(next)); } catch { /* Current page retains its identity. */ }
      setOwner(next); setCode(next.roomId);
      history.replaceState(history.state, "", `/multi/r/${next.roomId}`);
      connect(next.roomId, next);
    } catch (error) {
      if (!mounted.current) return;
      setFailure(error instanceof ApiError && error.status === 401 ? "gate.expired" : "host.err.serverError");
      if (error instanceof ApiError && error.status === 401) accessCallback.current?.();
    } finally { if (mounted.current) setBusy(false); }
  }

  function join(event: FormEvent) {
    event.preventDefault();
    if (!isValidRoomId(code)) { setFailure("gate.malformed"); return; }
    if (route?.roomId !== code) clearViewerGrant(code);
    connect(code, owner?.roomId === code ? owner : null);
  }

  async function share() {
    const connection = session.current;
    if (!connection?.canShare || capturing) return;
    const operation = ++epoch.current;
    setCapturing(true); setFailure(null); setNotice(null);
    try {
      const stream = await captureDisplay(MULTI_SCREEN_PROFILE);
      if (epoch.current !== operation || session.current !== connection || !connection.canShare) {
        stream.getTracks().forEach(track => track.stop()); return;
      }
      if (connection.setStream(stream)) setLocal(stream);
      else { stream.getTracks().forEach(track => track.stop()); setFailure("multi.err.connection"); }
    } catch (error) {
      if (epoch.current === operation && mounted.current && !(error instanceof DOMException && error.name === "NotAllowedError")) setFailure("multi.err.capture");
    } finally { if (epoch.current === operation && mounted.current) setCapturing(false); }
  }

  function stopShare() { ++epoch.current; session.current?.setStream(null); setLocal(null); setCapturing(false); }
  function leave() {
    stopShare(); session.current?.stop(); setIdentity(null); setPeers([]); setStreams({}); setFocused(null);
    setFailure(null); setNotice(null);
    // Leave keeps the tab's room credential so it can rejoin without allocating another room.
  }
  async function copyInvite() {
    if (!owner || owner.roomId !== identity?.roomId) return;
    try { await navigator.clipboard.writeText(owner.inviteUrl); setNotice("common.copied"); }
    catch { setFailure("common.copyFailed"); }
  }

  const self = session.current?.peerId;
  const ready = status === "connected" && peers.some(peer => peer.peerId === self);
  const mediaSupported = !!navigator.mediaDevices?.getDisplayMedia;
  const visible = focused ? peers.filter(peer => peer.peerId === focused) : peers;
  return <div className="lr-app">
    <AppHeader />
    <main className="multi-room">
      <div className="multi-heading"><Glyph name="users" size={28} /><h1>{t("multi.title")}</h1></div>
      {!vis && <p className="multi-intro">{t("multi.hint")}</p>}
      {!available ? <div className="multi-entry"><Comic kind="warning" theme="paper" tone="warn" /><p role="alert">{t("multi.unavailable")}</p></div>
      : !identity ? <form className="multi-entry" onSubmit={join}>
        <label>{t("multi.name")}<input value={name} maxLength={48} onChange={event => setName(event.target.value)} autoComplete="nickname" /></label>
        {!route && <Btn icon="users" cap="multi.create" title="multi.create" tone="primary" busy={busy} disabled={busy} onClick={() => void create()} />}
        <label>{t("common.roomCode")}<input value={code} inputMode="numeric" pattern="[1-9][0-9]{3}" maxLength={4} required onChange={event => setCode(event.target.value.replace(/\D/g, ""))} /></label>
        {!(route?.roomId === code && route.viewerGrant) && owner?.roomId !== code && <label>{t("multi.password")}<input type="password" value={password} maxLength={128} onChange={event => setPassword(event.target.value)} autoComplete="off" /></label>}
        <Btn icon="door" type="submit" cap="multi.join" title="multi.join" disabled={busy} />
      </form> : <>
        <div className="multi-toolbar">
          <span className="multi-code">{t("common.roomCode")} <strong>{identity.roomId}</strong></span>
          <span role="status">{ready ? `${peers.length} / 4` : t(status === "reconnecting" ? "multi.reconnecting" : status === "offline" ? "multi.disconnected" : "multi.connecting")}</span>
          {owner?.roomId === identity.roomId && <Btn icon="link" cap="host.invite.copy" title="host.invite.copy" onClick={() => void copyInvite()} />}
          <Btn icon={local ? "stop" : "cast"} tone={local ? "danger" : "primary"} cap={local ? "multi.stop" : "multi.share"} title={local ? "multi.stop" : "multi.share"}
            busy={capturing} disabled={!local && (!ready || capturing || !mediaSupported)} onClick={() => local ? stopShare() : void share()} />
          <Btn icon="refresh" cap="common.retry" title="common.retry" onClick={() => { stopShare(); setStreams({}); setRetry(value => value + 1); }} />
          <Btn icon="door" cap="multi.leave" title="multi.leave" onClick={leave} />
        </div>
        {!mediaSupported && <p className="multi-notice">{t("multi.noCapture")}</p>}
        {focused && <Btn icon="contract" cap="multi.grid" title="multi.grid" onClick={() => setFocused(null)} />}
        <section className={`multi-grid${focused ? " is-focused" : ""}`} aria-label={t("multi.screens")}>
          {visible.map(peer => <ScreenTile key={`${peer.peerId}:${peer.generation ?? "idle"}`} peer={peer}
            stream={peer.peerId === self ? local : streams[peer.peerId] ?? null} local={peer.peerId === self}
            focused={peer.peerId === focused} onFocus={() => setFocused(current => current === peer.peerId ? null : peer.peerId)} />)}
        </section>
        {ready && peers.length === 1 && <p className="multi-notice">{t("multi.inviteHint")}</p>}
      </>}
      {failure && <p className="multi-error" role="alert">{t(failure)}</p>}
      {notice && <p role="status">{t(notice)}</p>}
    </main>
  </div>;
}

function ScreenTile({ peer, stream, local, focused, onFocus }: {
  peer: MultiScreenPeer; stream: MediaStream | null; local: boolean; focused: boolean; onFocus: () => void;
}) {
  const { t } = useCopy();
  const video = useRef<HTMLVideoElement>(null);
  const [proved, setProved] = useState(false);
  const [playRequired, setPlayRequired] = useState(false);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let active = true;
    let frame: number | undefined;
    setProved(false); setPlayRequired(false); element.srcObject = stream;
    if (stream) {
      if (element.requestVideoFrameCallback) frame = element.requestVideoFrameCallback(() => { if (active) setProved(true); });
      void element.play().catch(() => { if (active) setPlayRequired(true); });
    }
    return () => { active = false; if (frame !== undefined) element.cancelVideoFrameCallback(frame); element.srcObject = null; };
  }, [stream]);
  const pending = !proved && (peer.generation !== null || stream !== null);
  return <article className="multi-tile">
    <div className="multi-tile-head"><span>{peer.displayName} {local && <small>({t("multi.you")})</small>}</span>
      <Btn icon={focused ? "contract" : "expand"} title={focused ? "multi.grid" : "multi.focus"} onClick={onFocus} /></div>
    <div className="multi-stage">
      <video ref={video} autoPlay playsInline muted controls={!local && stream !== null} aria-label={peer.displayName}
        onLoadedData={() => { if (!video.current?.requestVideoFrameCallback) setProved(true); }} />
      {!proved && <div className="multi-placeholder">
        <Glyph name={pending ? "loader" : "tv"} size={40} className={pending ? "lr-spin" : undefined} />
        <span>{t(pending ? "multi.receiving" : "multi.notSharing")}</span>
        {playRequired && <Btn icon="play" cap="playback.play" title="playback.play" onClick={() => void video.current?.play().then(() => setPlayRequired(false)).catch(() => setPlayRequired(true))} />}
      </div>}
    </div>
  </article>;
}
