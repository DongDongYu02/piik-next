package signal

import (
	"fmt"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

func nextScreenRoster(t *testing.T, client *testClient, match func(protocol.MultiScreenRosterMessage) bool) protocol.MultiScreenRosterMessage {
	t.Helper()
	for {
		raw := client.next("multi-screen-roster")
		decoded, err := protocol.DecodeServerMessage(raw.raw)
		if err != nil {
			t.Fatal(err)
		}
		roster := decoded.(protocol.MultiScreenRosterMessage)
		if match(roster) {
			return roster
		}
	}
}

func joinScreenRoom(t *testing.T, client *testClient, count int) protocol.MultiScreenRosterMessage {
	t.Helper()
	client.sendJSON(map[string]any{"type": "multi-screen-join"})
	return nextScreenRoster(t, client, func(roster protocol.MultiScreenRosterMessage) bool { return len(roster.Peers) == count })
}

func publishScreen(t *testing.T, client *testClient, generation string) {
	t.Helper()
	client.sendJSON(map[string]any{"type": "multi-screen-state", "generation": generation})
	nextScreenRoster(t, client, func(roster protocol.MultiScreenRosterMessage) bool {
		for _, peer := range roster.Peers {
			if peer.PeerID == roster.PeerID {
				return peer.Generation != nil && *peer.Generation == generation
			}
		}
		return false
	})
}

func screenSignal(client *testClient, sender, target, generation, kind string) {
	payload := "v=0\r\n"
	if kind == "ice" {
		payload = `{"candidate":"candidate:1 1 udp 1 127.0.0.1 1234 typ host","sdpMid":"0"}`
	}
	client.sendJSON(map[string]any{"type": "multi-screen-signal", "sourcePeerId": sender, "targetPeerId": target,
		"generation": generation, "kind": kind, "payload": payload})
}

func TestMultiScreenBoundsOptInAndAuthorizesEachPublisherDirection(t *testing.T) {
	h := startHarness(t, harnessOptions{maxViewersPerRoom: 8})
	clients, identities := []*testClient{}, []string{}
	for index := range 4 {
		client := openClient(t, h)
		role, presence := protocol.RoleViewer, presenceOptions{displayName: fmt.Sprintf("Friend %d", index)}
		if index == 0 {
			role = protocol.RoleHost
			presence.roomOnly = true
			presence.roomSession = true
			presence.viewerPresence = true
		}
		auth := authenticate(t, client, h.room, role, fmt.Sprintf("multi_participant_%d", index), -1, "", presence)
		roster := joinScreenRoom(t, client, index+1)
		if roster.PeerID != auth.PeerID {
			t.Fatal("roster identity did not come from authentication")
		}
		clients, identities = append(clients, client), append(identities, auth.PeerID)
	}
	legacy := openClient(t, h)
	legacyAuth := authenticate(t, legacy, h.room, protocol.RoleViewer, "legacy_multi_viewer", -1, "", presenceOptions{})
	if _, received := legacy.tryNext("multi-screen-roster", 30*time.Millisecond); received {
		t.Fatal("legacy reader received opt-in messages")
	}
	legacy.sendJSON(map[string]any{"type": "multi-screen-join"})
	expectMatch(t, legacy.next("multi-screen-rejected").raw, `{"command":"join","reason":"room-full"}`)
	legacy.sendJSON(map[string]any{"type": "multi-screen-state", "generation": "unjoined_generation"})
	expectMatch(t, legacy.next("multi-screen-rejected").raw, `{"reason":"not-joined"}`)
	for index, client := range clients {
		publishScreen(t, client, fmt.Sprintf("screen_generation_%d", index))
	}
	// All four participants can publish to every other participant, then receive
	// the answer and both ICE directions on that publisher's own generation.
	for publisher, client := range clients {
		generation := fmt.Sprintf("screen_generation_%d", publisher)
		for subscriber, recipient := range clients {
			if publisher == subscriber {
				continue
			}
			screenSignal(client, identities[publisher], identities[subscriber], generation, "offer")
			expectMatch(t, recipient.next("multi-screen-signal").raw, fmt.Sprintf(`{"sourcePeerId":%q,"generation":%q,"kind":"offer"}`, identities[publisher], generation))
			screenSignal(recipient, identities[subscriber], identities[publisher], generation, "answer")
			client.next("multi-screen-signal")
			screenSignal(client, identities[publisher], identities[subscriber], generation, "ice")
			recipient.next("multi-screen-signal")
			screenSignal(recipient, identities[subscriber], identities[publisher], generation, "ice")
			client.next("multi-screen-signal")
		}
	}
	clients[1].sendJSON(map[string]any{"type": "multi-screen-state", "generation": "screen_generation_0"})
	expectMatch(t, clients[1].next("multi-screen-rejected").raw, `{"reason":"invalid-state"}`)
	screenSignal(clients[1], identities[0], identities[2], "screen_generation_0", "offer")
	expectMatch(t, clients[1].next("multi-screen-rejected").raw, `{"reason":"forbidden"}`)
	screenSignal(clients[1], identities[1], identities[0], "screen_generation_0", "offer")
	expectMatch(t, clients[1].next("multi-screen-rejected").raw, `{"reason":"forbidden"}`)
	screenSignal(clients[0], identities[0], identities[1], "screen_generation_0", "answer")
	expectMatch(t, clients[0].next("multi-screen-rejected").raw, `{"reason":"forbidden"}`)
	screenSignal(clients[0], identities[0], legacyAuth.PeerID, "screen_generation_0", "offer")
	expectMatch(t, clients[0].next("multi-screen-rejected").raw, `{"reason":"target-unavailable"}`)
	otherRoom, err := h.server.CreateRoom(protocol.CodeEntryOpen, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	outsider := openClient(t, h)
	other := authenticate(t, outsider, otherRoom, protocol.RoleViewer, "other_multi_room", -1, "", presenceOptions{})
	joinScreenRoom(t, outsider, 1)
	screenSignal(clients[0], identities[0], other.PeerID, "screen_generation_0", "offer")
	expectMatch(t, clients[0].next("multi-screen-rejected").raw, `{"reason":"target-unavailable"}`)
	if _, received := outsider.tryNext("multi-screen-signal", 30*time.Millisecond); received {
		t.Fatal("screen signal escaped room authority")
	}
	clients[0].sendJSON(map[string]any{"type": "multi-screen-state", "generation": nil})
	nextScreenRoster(t, clients[0], func(roster protocol.MultiScreenRosterMessage) bool { return roster.Peers[0].Generation == nil })
	screenSignal(clients[0], identities[0], identities[1], "screen_generation_0", "offer")
	expectMatch(t, clients[0].next("multi-screen-rejected").raw, `{"reason":"invalid-state"}`)
	screenSignal(clients[1], identities[1], identities[2], "screen_generation_1", "offer")
	clients[2].next("multi-screen-signal")
	legacy.sendJSON(map[string]any{"type": "signaling-challenge", "sequence": 123})
	legacy.next("signaling-challenge-response")
}

func TestMultiScreenDisconnectReplacementAndRevocationClearOwnedState(t *testing.T) {
	h := startHarness(t, harnessOptions{viewerDisconnectGraceMs: 2000})
	host, first, second := openClient(t, h), openClient(t, h), openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "multi_owner_lifecycle", -1, "", presenceOptions{roomOnly: true, roomSession: true, viewerPresence: true})
	joinScreenRoom(t, host, 1)
	firstAuth := authenticate(t, first, h.room, protocol.RoleViewer, "multi_replaced_client", -1, "", presenceOptions{})
	joinScreenRoom(t, first, 2)
	secondAuth := authenticate(t, second, h.room, protocol.RoleViewer, "multi_code_client", -1, "", presenceOptions{codeOnly: true})
	joinScreenRoom(t, second, 3)
	publishScreen(t, first, "previous_screen_generation")
	publishScreen(t, second, "surviving_screen_generation")
	var previous *session
	h.locked(func() {
		peer, _ := h.store.GetConnectedViewer(h.room.RoomID, firstAuth.PeerID)
		previous = h.server.sessionsByID[peer.SessionID]
	})
	replacement := openClient(t, h)
	newAuth := authenticate(t, replacement, h.room, protocol.RoleViewer, "multi_replaced_client", -1, "", presenceOptions{})
	expectCloseCode(t, first, int(protocol.SignalCloseSessionReplaced))
	nextScreenRoster(t, host, func(roster protocol.MultiScreenRosterMessage) bool { return len(roster.Peers) == 2 })
	roster := joinScreenRoom(t, replacement, 3)
	for _, peer := range roster.Peers {
		if peer.PeerID == newAuth.PeerID && peer.Generation != nil {
			t.Fatal("replacement inherited a publication")
		}
	}
	h.locked(func() {
		h.server.handleMessage(previous, []byte(fmt.Sprintf(`{"type":"multi-screen-signal","sourcePeerId":%q,"targetPeerId":%q,"generation":"previous_screen_generation","kind":"offer","payload":"v=0"}`, firstAuth.PeerID, secondAuth.PeerID)))
	})
	if _, received := second.tryNext("multi-screen-signal", 30*time.Millisecond); received {
		t.Fatal("replaced session forwarded old screen media")
	}
	h.closeClient(second)
	nextScreenRoster(t, host, func(roster protocol.MultiScreenRosterMessage) bool { return len(roster.Peers) == 2 })
	// The 2-second ordinary Viewer grace does not retain screen presence.
	h.locked(func() {
		if len(h.server.multiScreenPeers(h.room.RoomID)) != 2 {
			t.Fatal("disconnected screen retained grace membership")
		}
	})
	secondAgain := openClient(t, h)
	secondNew := authenticate(t, secondAgain, h.room, protocol.RoleViewer, "multi_code_client", -1, "", presenceOptions{codeOnly: true})
	roster = joinScreenRoom(t, secondAgain, 3)
	for _, peer := range roster.Peers {
		if peer.PeerID == secondNew.PeerID && peer.Generation != nil {
			t.Fatal("reconnect revived a departed publication")
		}
	}
	publishScreen(t, replacement, "replacement_screen_generation")
	publishScreen(t, secondAgain, "remaining_screen_generation")
	h.updateRoomAccess(protocol.RevokeViewerGrantRequest{Action: "revoke-viewer-grant"})
	replacement.next("viewer-grant-revoked")
	expectCloseCode(t, replacement, int(protocol.SignalCloseViewerAccessRevoked))
	roster = nextScreenRoster(t, host, func(roster protocol.MultiScreenRosterMessage) bool {
		return len(roster.Peers) == 2 && roster.Peers[1].PeerID == secondNew.PeerID &&
			roster.Peers[1].Generation != nil && *roster.Peers[1].Generation == "remaining_screen_generation"
	})
	if roster.Peers[1].PeerID != secondNew.PeerID || roster.Peers[1].Generation == nil || *roster.Peers[1].Generation != "remaining_screen_generation" {
		t.Fatal("grant revocation affected a separately code-admitted publisher")
	}
	host.sendJSON(map[string]any{"type": "abandon-room"})
	host.next("room-closed")
	secondAgain.next("room-closed")
	expectCloseCode(t, host, 1000)
	expectCloseCode(t, secondAgain, 1000)
}

func TestMultiScreenModeCannotMixWithLegacyPublication(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "multi_mode_owner", -1, "", presenceOptions{roomOnly: true, roomSession: true, viewerPresence: true})
	joinScreenRoom(t, host, 1)
	host.sendJSON(map[string]any{"type": "start-sharing", "shareGeneration": "legacy_screen_attempt", "routePolicy": protocol.DefaultRoutePolicy})
	expectMatch(t, host.next("sharing-start-failed").raw, `{"code":"FORBIDDEN"}`)
	otherHost := openClient(t, h)
	otherHost.sendJSON(map[string]any{"type": "authenticate", "protocol": protocol.SignalingProtocol, "roomId": h.room.RoomID,
		"role": protocol.RoleHost, "token": h.room.HostToken, "clientId": "legacy_owner_attempt"})
	expectMatch(t, otherHost.next("error").raw, `{"code":"FORBIDDEN"}`)
	expectCloseCode(t, otherHost, int(protocol.SignalCloseAuthenticationFailed))
	h.locked(func() {
		if h.server.activeHostShareGeneration(h.room.RoomID) != "" {
			t.Fatal("multi-screen unexpectedly started the old route graph")
		}
	})
	// The normal one-source product continues to work in another room and
	// explicitly refuses multi-screen participants while its source is active.
	otherRoom, err := h.server.CreateRoom(protocol.CodeEntryOpen, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	standard := openClient(t, h)
	authenticate(t, standard, otherRoom, protocol.RoleHost, "standard_media_owner", -1, "", presenceOptions{})
	viewer := openClient(t, h)
	authenticate(t, viewer, otherRoom, protocol.RoleViewer, "standard_media_viewer", -1, "", presenceOptions{})
	viewer.sendJSON(map[string]any{"type": "multi-screen-join"})
	expectMatch(t, viewer.next("multi-screen-rejected").raw, `{"reason":"forbidden"}`)
}

func TestMultiScreenMalformedCommandIsLocalAndSFUOnlyPolicyIsRespected(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	client := openClient(t, h)
	authenticate(t, client, h.room, protocol.RoleViewer, "malformed_multi_client", -1, "", presenceOptions{})
	joinScreenRoom(t, client, 1)
	client.sendJSON(map[string]any{"type": "multi-screen-state"})
	expectMatch(t, client.next("multi-screen-rejected").raw, `{"command":"state","reason":"invalid-state"}`)
	client.sendJSON(map[string]any{"type": "signaling-challenge", "sequence": 456})
	client.next("signaling-challenge-response")
	h.locked(func() { h.server.router.sfuOnly = true })
	client.sendJSON(map[string]any{"type": "multi-screen-join"})
	expectMatch(t, client.next("multi-screen-rejected").raw, `{"command":"join","reason":"forbidden"}`)
}
