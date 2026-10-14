package signal

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
	"github.com/TNTcraftHIM/Piik/internal/server/sfu"
	"github.com/TNTcraftHIM/Piik/internal/server/sfu/sfutest"
	"github.com/pion/webrtc/v4"
)

func nextMultiSfuConfig(t *testing.T, client *testClient) protocol.MultiScreenSfuConfigMessage {
	t.Helper()
	var config protocol.MultiScreenSfuConfigMessage
	if err := json.Unmarshal(client.next("multi-screen-sfu-config").raw, &config); err != nil {
		t.Fatal(err)
	}
	return config
}

func sendMultiSfu(client *testClient, config protocol.MultiScreenSfuConfigMessage, kind string, description *protocol.SessionDescription) {
	message := protocol.SfuSignalMessage{Type: "sfu-signal", Revision: config.Revision,
		PublicationGeneration: config.PublicationGeneration, ConnectionID: config.ConnectionID, Kind: kind, Description: description}
	if kind == "description" && description.Type == "offer" {
		message.Media = &protocol.SfuMedia{Codec: "vp8", Layers: []protocol.SfuLayer{{Width: 640, Height: 360, Bitrate: 500_000}}}
	}
	client.sendJSON(map[string]any{"type": "multi-screen-sfu-signal", "sourcePeerId": config.SourcePeerID, "signal": message})
}

func publishMultiSfu(t *testing.T, client *testClient, generation string) protocol.MultiScreenSfuConfigMessage {
	t.Helper()
	publishScreen(t, client, generation)
	config := nextMultiSfuConfig(t, client)
	sendMultiSfu(client, config, "description", &protocol.SessionDescription{Type: "offer", SDP: "v=0\r\n"})
	client.next("multi-screen-sfu-signal")
	return config
}

func multiSfuAdmissionUsage(h *harness) sfu.Usage {
	var usage sfu.Usage
	h.locked(func() { usage = h.server.sfuFallback.Admission.Usage() })
	return usage
}

func TestMultiScreenSFUFourOwnedSourcesAndExactAuthorization(t *testing.T) {
	media := sfutest.New()
	admission := sfu.NewAdmission(sfu.AdmissionOptions{IngressCapacity: 4, EgressCapacity: 12})
	h := startHarness(t, harnessOptions{sfu: &SfuFallback{Media: media, Admission: admission}, sfuOnly: true})
	clients := []*testClient{}
	identities := []string{}
	for index := range 4 {
		client := openClient(t, h)
		role, presence := protocol.RoleViewer, presenceOptions{}
		if index == 0 {
			role, presence = protocol.RoleHost, presenceOptions{roomOnly: true, roomSession: true}
		}
		auth := authenticate(t, client, h.room, role, fmt.Sprintf("multi_sfu_client_%d", index), -1, "", presence)
		roster := joinScreenRoom(t, client, index+1)
		if roster.Transport != "sfu" {
			t.Fatal("SFU-only site did not admit the multi-screen transport")
		}
		clients, identities = append(clients, client), append(identities, auth.PeerID)
	}
	configs := []protocol.MultiScreenSfuConfigMessage{}
	for source, publisher := range clients {
		config := publishMultiSfu(t, publisher, fmt.Sprintf("multi_sfu_generation_%d", source))
		configs = append(configs, config)
		for target, recipient := range clients {
			if target == source {
				continue
			}
			subscriber := nextMultiSfuConfig(t, recipient)
			if subscriber.SourcePeerID != identities[source] || subscriber.ConnectionID == config.ConnectionID || subscriber.PublicationGeneration != config.PublicationGeneration {
				t.Fatal("recipient configuration did not identify the source and exact connection")
			}
			recipient.next("multi-screen-sfu-signal")
			sendMultiSfu(recipient, subscriber, "description", &protocol.SessionDescription{Type: "answer", SDP: "v=0\r\n"})
			// A recipient cannot forge a publisher offer using its subscription.
			sendMultiSfu(recipient, subscriber, "description", &protocol.SessionDescription{Type: "offer", SDP: "v=0\r\n"})
			expectMatch(t, recipient.next("multi-screen-rejected").raw, `{"reason":"forbidden"}`)
		}
	}
	if usage := multiSfuAdmissionUsage(h); usage != (sfu.Usage{Ingress: 4, Egress: 12}) || len(media.Created()) != 4 {
		t.Fatalf("four independent sources usage = %+v, creations = %d", usage, len(media.Created()))
	}
	// A different room cannot inject SDP for any owned source.
	otherRoom, err := h.server.CreateRoom(protocol.CodeEntryOpen, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	outsider := openClient(t, h)
	authenticate(t, outsider, otherRoom, protocol.RoleViewer, "multi_sfu_outsider", -1, "", presenceOptions{})
	joinScreenRoom(t, outsider, 1)
	sendMultiSfu(outsider, configs[0], "candidate", nil)
	expectMatch(t, outsider.next("multi-screen-rejected").raw, `{"reason":"forbidden"}`)
	for index, client := range clients {
		forged := configs[index]
		forged.ConnectionID = "forged_connection_id"
		sendMultiSfu(client, forged, "candidate", nil)
		expectMatch(t, client.next("multi-screen-rejected").raw, `{"reason":"forbidden"}`)
	}
	// The direct-P2P envelope cannot bypass the configured SFU transport.
	screenSignal(clients[0], identities[0], identities[1], configs[0].PublicationGeneration, "offer")
	expectMatch(t, clients[0].next("multi-screen-rejected").raw, `{"reason":"forbidden"}`)
	clients[0].sendJSON(map[string]any{"type": "multi-screen-state", "generation": nil})
	nextScreenRoster(t, clients[0], func(roster protocol.MultiScreenRosterMessage) bool { return roster.Peers[0].Generation == nil })
	if !waitFor(t, defaultWait, func() bool { return multiSfuAdmissionUsage(h) == (sfu.Usage{Ingress: 3, Egress: 9}) }) {
		t.Fatal("stopping one source did not drain only its subscriptions")
	}
	sendMultiSfu(clients[0], configs[0], "candidate", nil)
	expectMatch(t, clients[0].next("multi-screen-rejected").raw, `{"reason":"forbidden"}`)
	h.closeClient(clients[1])
	nextScreenRoster(t, clients[2], func(roster protocol.MultiScreenRosterMessage) bool { return len(roster.Peers) == 3 })
	if !waitFor(t, defaultWait, func() bool { return multiSfuAdmissionUsage(h) == (sfu.Usage{Ingress: 2, Egress: 4}) }) {
		t.Fatal("leaving retained publication or recipient resources")
	}
}

func TestMultiScreenSFUExactCloseAndSessionReplacement(t *testing.T) {
	media := sfutest.New()
	h := startHarness(t, harnessOptions{sfu: &SfuFallback{Media: media,
		Admission: sfu.NewAdmission(sfu.AdmissionOptions{IngressCapacity: 4, EgressCapacity: 12})}})
	first, second := openClient(t, h), openClient(t, h)
	authenticate(t, first, h.room, protocol.RoleViewer, "multi_sfu_source_client", -1, "", presenceOptions{})
	joinScreenRoom(t, first, 1)
	authenticate(t, second, h.room, protocol.RoleViewer, "multi_sfu_recipient_client", -1, "", presenceOptions{})
	joinScreenRoom(t, second, 2)
	publication := publishMultiSfu(t, first, "multi_sfu_close_generation")
	subscription := nextMultiSfuConfig(t, second)
	second.next("multi-screen-sfu-signal")
	closeMessage := map[string]any{"type": "multi-screen-sfu-closed", "sourcePeerId": subscription.SourcePeerID,
		"publicationGeneration": subscription.PublicationGeneration, "connectionId": subscription.ConnectionID}
	second.sendJSON(closeMessage)
	second.next("multi-screen-sfu-closed")
	second.sendJSON(closeMessage)
	if !waitFor(t, defaultWait, func() bool { return multiSfuAdmissionUsage(h) == (sfu.Usage{Ingress: 1}) }) {
		t.Fatal("recipient close did not retire exactly one subscription")
	}
	sendMultiSfu(second, subscription, "candidate", nil)
	expectMatch(t, second.next("multi-screen-rejected").raw, `{"reason":"forbidden"}`)
	second.sendJSON(map[string]any{"type": "multi-screen-join"})
	nextScreenRoster(t, second, func(roster protocol.MultiScreenRosterMessage) bool { return len(roster.Peers) == 2 })
	if _, received := second.tryNext("multi-screen-sfu-config", 20*time.Millisecond); received {
		t.Fatal("retired same-session subscription was silently recreated")
	}
	replacement := openClient(t, h)
	authenticate(t, replacement, h.room, protocol.RoleViewer, "multi_sfu_recipient_client", -1, "", presenceOptions{})
	expectCloseCode(t, second, int(protocol.SignalCloseSessionReplaced))
	joinScreenRoom(t, replacement, 2)
	newSubscription := nextMultiSfuConfig(t, replacement)
	if newSubscription.ConnectionID == subscription.ConnectionID {
		t.Fatal("replacement inherited a retired physical identity")
	}
	replacement.next("multi-screen-sfu-signal")
	first.sendJSON(map[string]any{"type": "multi-screen-sfu-closed", "sourcePeerId": publication.SourcePeerID,
		"publicationGeneration": publication.PublicationGeneration, "connectionId": publication.ConnectionID})
	first.next("multi-screen-sfu-closed")
	nextScreenRoster(t, replacement, func(roster protocol.MultiScreenRosterMessage) bool { return roster.Peers[0].Generation == nil })
	if !waitFor(t, defaultWait, func() bool { return multiSfuAdmissionUsage(h) == (sfu.Usage{}) }) {
		t.Fatal("publisher close retained resources")
	}
}

func TestMultiScreenSFULegacyHostCleanupPreservesIndependentSource(t *testing.T) {
	media := sfutest.New()
	h := startHarness(t, harnessOptions{sfu: &SfuFallback{Media: media,
		Admission: sfu.NewAdmission(sfu.AdmissionOptions{IngressCapacity: 4, EgressCapacity: 12})}})
	legacyHost := openClient(t, h)
	authenticate(t, legacyHost, h.room, protocol.RoleHost, "multi_sfu_switching_host", -1, "", presenceOptions{roomSession: true})
	legacyHost.sendJSON(map[string]any{"type": "stop-sharing"})
	legacyHost.sendJSON(map[string]any{"type": "signaling-challenge", "sequence": 1})
	legacyHost.next("signaling-challenge-response")
	h.closeClient(legacyHost)
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "multi_sfu_switching_host", -1, "", presenceOptions{roomOnly: true, roomSession: true})
	joinScreenRoom(t, host, 1)
	source := openClient(t, h)
	authenticate(t, source, h.room, protocol.RoleViewer, "multi_sfu_surviving_source", -1, "", presenceOptions{})
	joinScreenRoom(t, source, 2)
	publication := publishMultiSfu(t, source, "multi_sfu_surviving_generation")
	nextMultiSfuConfig(t, host)
	host.next("multi-screen-sfu-signal")
	// An ordinary room member keeps a legacy router entry alive. Its graph
	// cleanup on a room-only Host reconnect must stay in the legacy owner group.
	idle := openClient(t, h)
	authenticate(t, idle, h.room, protocol.RoleViewer, "multi_sfu_idle_legacy_member", -1, "", presenceOptions{})
	reconnected := openClient(t, h)
	authenticate(t, reconnected, h.room, protocol.RoleHost, "multi_sfu_switching_host", -1, "", presenceOptions{roomOnly: true, roomSession: true})
	expectCloseCode(t, host, int(protocol.SignalCloseSessionReplaced))
	roster := joinScreenRoom(t, reconnected, 2)
	if roster.Peers[1].Generation == nil || *roster.Peers[1].Generation != publication.PublicationGeneration {
		t.Fatal("Host reconnect withdrew an independently owned source")
	}
	nextMultiSfuConfig(t, reconnected)
	reconnected.next("multi-screen-sfu-signal")
	if !waitFor(t, defaultWait, func() bool { return multiSfuAdmissionUsage(h) == (sfu.Usage{Ingress: 1, Egress: 1}) }) {
		t.Fatal("Host reconnect changed independent publication admission")
	}
	if len(media.Deleted()) != 0 {
		t.Fatal("legacy graph cleanup closed the independent physical publication")
	}
	sendMultiSfu(source, publication, "candidate", nil)
	source.sendJSON(map[string]any{"type": "signaling-challenge", "sequence": 2})
	source.next("signaling-challenge-response")
	if _, rejected := source.tryNext("multi-screen-rejected", 20*time.Millisecond); rejected {
		t.Fatal("Host reconnect revoked the independent source connection")
	}
}

type delayedMultiSfuMedia struct {
	*sfutest.FakeMedia
	entered chan struct{}
	release chan struct{}
	closing chan struct{}
}

func (media *delayedMultiSfuMedia) PreparePublication(fence sfu.ResourceFence, connectionID string, metadata sfu.PublicationMedia) error {
	close(media.entered)
	<-media.release
	return media.FakeMedia.PreparePublication(fence, connectionID, metadata)
}

func (media *delayedMultiSfuMedia) ClosePublication(fence sfu.ResourceFence) error {
	if media.closing != nil {
		close(media.closing)
	}
	return media.FakeMedia.ClosePublication(fence)
}

func TestMultiScreenSFURoomEndWaitsForLatePhysicalPreparation(t *testing.T) {
	for _, endAll := range []bool{false, true} {
		t.Run(fmt.Sprintf("endAll=%t", endAll), func(t *testing.T) {
			media := &delayedMultiSfuMedia{FakeMedia: sfutest.New(), entered: make(chan struct{}),
				release: make(chan struct{}), closing: make(chan struct{})}
			h := startHarness(t, harnessOptions{sfu: &SfuFallback{Media: media,
				Admission: sfu.NewAdmission(sfu.AdmissionOptions{IngressCapacity: 1, EgressCapacity: 3})}})
			client := openClient(t, h)
			authenticate(t, client, h.room, protocol.RoleViewer, "multi_sfu_room_end_client", -1, "", presenceOptions{})
			joinScreenRoom(t, client, 1)
			publishScreen(t, client, "multi_sfu_room_end_generation")
			config := nextMultiSfuConfig(t, client)
			sendMultiSfu(client, config, "description", &protocol.SessionDescription{Type: "offer", SDP: "v=0\r\n"})
			select {
			case <-media.entered:
			case <-time.After(defaultWait):
				close(media.release)
				t.Fatal("publication did not enter preparation")
			}
			var err error
			if endAll {
				err = h.server.EndAllRooms()
			} else {
				h.locked(func() { err = h.server.abandonRoom(h.room.RoomID) })
			}
			if err != nil {
				close(media.release)
				t.Fatal(err)
			}
			client.next("room-closed")
			prematureClose := false
			select {
			case <-media.closing:
				prematureClose = true
			case <-time.After(30 * time.Millisecond):
			}
			usage := multiSfuAdmissionUsage(h)
			close(media.release)
			if prematureClose || usage != (sfu.Usage{Ingress: 1}) {
				t.Fatal("room ending closed/released a publication before its delayed preparation")
			}
			if !waitFor(t, defaultWait, func() bool { return multiSfuAdmissionUsage(h) == (sfu.Usage{}) }) {
				t.Fatal("late publication escaped room-end drain")
			}
			if len(media.Created()) != 1 || len(media.Deleted()) != 1 {
				t.Fatal("room ending did not drain the exact late physical publication")
			}
		})
	}
}

func TestMultiScreenSFUReplacementWaitsForLatePhysicalPrepareBeforeReleasingCapacity(t *testing.T) {
	media := &delayedMultiSfuMedia{FakeMedia: sfutest.New(), entered: make(chan struct{}), release: make(chan struct{})}
	h := startHarness(t, harnessOptions{sfu: &SfuFallback{Media: media,
		Admission: sfu.NewAdmission(sfu.AdmissionOptions{IngressCapacity: 1, EgressCapacity: 3})}})
	first := openClient(t, h)
	authenticate(t, first, h.room, protocol.RoleViewer, "multi_sfu_delayed_client", -1, "", presenceOptions{})
	joinScreenRoom(t, first, 1)
	publishScreen(t, first, "multi_sfu_delayed_generation")
	config := nextMultiSfuConfig(t, first)
	sendMultiSfu(first, config, "description", &protocol.SessionDescription{Type: "offer", SDP: "v=0\r\n"})
	select {
	case <-media.entered:
	case <-time.After(defaultWait):
		close(media.release)
		t.Fatal("publication did not enter physical preparation")
	}
	replacement := openClient(t, h)
	authenticate(t, replacement, h.room, protocol.RoleViewer, "multi_sfu_delayed_client", -1, "", presenceOptions{})
	joinScreenRoom(t, replacement, 1)
	usage, created, retired := multiSfuAdmissionUsage(h), len(media.Created()), len(media.Deleted())
	close(media.release)
	if usage.Ingress != 1 || created != 0 || retired != 0 {
		t.Fatal("retirement released admission before the late prepare settled")
	}
	if !waitFor(t, defaultWait, func() bool { return multiSfuAdmissionUsage(h) == (sfu.Usage{}) }) {
		t.Fatal("late physical publication did not finish its fenced drain")
	}
	if len(media.Created()) != 1 || len(media.Deleted()) != 1 {
		t.Fatal("late physical publication escaped cleanup")
	}
}

func TestMultiScreenSFUUnpreparedPublisherTimesOutAndWithdrawsSource(t *testing.T) {
	h := startHarness(t, harnessOptions{sfu: &SfuFallback{Media: sfutest.New(), PrepareTimeoutMs: 100,
		Admission: sfu.NewAdmission(sfu.AdmissionOptions{IngressCapacity: 1, EgressCapacity: 3})}})
	client := openClient(t, h)
	authenticate(t, client, h.room, protocol.RoleViewer, "multi_sfu_timeout_client", -1, "", presenceOptions{})
	joinScreenRoom(t, client, 1)
	publishScreen(t, client, "multi_sfu_timeout_generation")
	config := nextMultiSfuConfig(t, client)
	expectMatch(t, client.next("multi-screen-sfu-closed").raw, fmt.Sprintf(`{"connectionId":%q}`, config.ConnectionID))
	nextScreenRoster(t, client, func(roster protocol.MultiScreenRosterMessage) bool { return roster.Peers[0].Generation == nil })
	if !waitFor(t, defaultWait, func() bool { return multiSfuAdmissionUsage(h) == (sfu.Usage{}) }) {
		t.Fatal("unprepared publisher retained admission after its deadline")
	}
}

// A prepared subscriber waiting for source media obeys the same retirement
// deadline. Its canceled operation cannot publish an offer after departure.
type waitingMultiSfuMedia struct {
	*sfutest.FakeMedia
	entered chan struct{}
}

func (media *waitingMultiSfuMedia) PrepareSubscriber(ctx context.Context, _ sfu.SubscriptionFence, _ string) (webrtc.SessionDescription, error) {
	close(media.entered)
	<-ctx.Done()
	return webrtc.SessionDescription{}, ctx.Err()
}

func TestMultiScreenSFUSubscriberDepartureCancelsWaitingPreparation(t *testing.T) {
	media := &waitingMultiSfuMedia{FakeMedia: sfutest.New(), entered: make(chan struct{})}
	h := startHarness(t, harnessOptions{sfu: &SfuFallback{Media: media,
		Admission: sfu.NewAdmission(sfu.AdmissionOptions{IngressCapacity: 2, EgressCapacity: 3})}})
	first, second := openClient(t, h), openClient(t, h)
	authenticate(t, first, h.room, protocol.RoleViewer, "multi_sfu_waiting_source", -1, "", presenceOptions{})
	joinScreenRoom(t, first, 1)
	authenticate(t, second, h.room, protocol.RoleViewer, "multi_sfu_waiting_recipient", -1, "", presenceOptions{})
	joinScreenRoom(t, second, 2)
	publishMultiSfu(t, first, "multi_sfu_waiting_generation")
	nextMultiSfuConfig(t, second)
	select {
	case <-media.entered:
	case <-time.After(defaultWait):
		t.Fatal("subscriber did not wait for publication readiness")
	}
	h.closeClient(second)
	if !waitFor(t, defaultWait, func() bool { return multiSfuAdmissionUsage(h) == (sfu.Usage{Ingress: 1}) }) {
		t.Fatal("departure did not cancel and drain pending subscriber")
	}
}
