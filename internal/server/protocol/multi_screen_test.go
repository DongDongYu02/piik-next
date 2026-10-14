package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestMultiScreenSignalBoundsIncludeTheEncodedFrame(t *testing.T) {
	for _, test := range []struct {
		name, kind, payload string
		valid               bool
	}{
		{"offer", "offer", "v=0\r\n", true},
		{"ice-at-bound", "ice", strings.Repeat("x", MaxMultiScreenICEBytes), true},
		{"ice-above-bound", "ice", strings.Repeat("x", MaxMultiScreenICEBytes+1), false},
		{"ice-multibyte-above-bound", "ice", strings.Repeat("界", MaxMultiScreenICEBytes/3+1), false},
		{"sdp-frame-with-overhead", "offer", strings.Repeat("x", MaxMultiScreenSDPBytes), false},
		{"sdp-escaping-exceeds-frame", "offer", strings.Repeat("\n", MaxSignalBytes/2), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			encoded, err := json.Marshal(MultiScreenSignalMessage{Type: "multi-screen-signal",
				SourcePeerID: "source_peer_1234", TargetPeerID: "target_peer_1234", Generation: "screen_generation_1234",
				Kind: test.kind, Payload: test.payload})
			if err != nil {
				t.Fatal(err)
			}
			_, err = DecodeClientMessage(encoded)
			if (err == nil) != test.valid {
				t.Fatalf("accepted = %v, want %v (%v)", err == nil, test.valid, err)
			}
		})
	}
}

func TestMultiScreenRosterRequiresUniquePeersGenerationsAndRecipient(t *testing.T) {
	for _, raw := range []string{
		`{"type":"multi-screen-roster","peerId":"receiver_1234","peers":[]}`,
		`{"type":"multi-screen-roster","peerId":"receiver_1234","peers":[{"peerId":"other_peer_1234","displayName":"Friend","generation":null}]}`,
		`{"type":"multi-screen-roster","peerId":"receiver_1234","peers":[{"peerId":"receiver_1234","displayName":"Friend","generation":null},{"peerId":"receiver_1234","displayName":"Duplicate","generation":null}]}`,
		`{"type":"multi-screen-roster","peerId":"receiver_1234","peers":[{"peerId":"receiver_1234","displayName":"Friend","generation":"screen_generation_1234"},{"peerId":"other_peer_1234","displayName":"Duplicate","generation":"screen_generation_1234"}]}`,
	} {

		raw = strings.Replace(raw, `"peerId":"receiver_1234"`, `"transport":"p2p","peerId":"receiver_1234"`, 1)
		if _, err := DecodeServerMessage([]byte(raw)); err == nil {
			t.Fatalf("invalid roster accepted: %s", raw)
		}
	}
}

func TestMultiScreenSFUNestedSignalBoundsAndTransport(t *testing.T) {
	for _, valid := range []bool{true, false} {
		payload := "v=0\r\n"
		if !valid {
			payload = strings.Repeat("\n", MaxSignalBytes/2)
		}
		data, err := json.Marshal(MultiScreenSfuSignalMessage{Type: "multi-screen-sfu-signal", SourcePeerID: "source_peer_1234", Signal: SfuSignalMessage{
			Type: "sfu-signal", Revision: 1, PublicationGeneration: "screen_generation_1234", ConnectionID: "sfu_connection_1234",
			Kind: "description", Description: &SessionDescription{Type: "offer", SDP: payload},
		}})
		if err != nil {
			t.Fatal(err)
		}
		_, err = DecodeClientMessage(data)
		if (err == nil) != valid {
			t.Fatalf("SFU frame accepted=%v, want=%v: %v", err == nil, valid, err)
		}
	}
	base := `{"type":"multi-screen-roster","peerId":"receiver_1234","transport":"p2p","peers":[{"peerId":"receiver_1234","displayName":"Friend","generation":null}]}`
	if _, err := DecodeServerMessage([]byte(base)); err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeServerMessage([]byte(strings.Replace(base, `"p2p"`, `"invalid"`, 1))); err == nil {
		t.Fatal("invalid transport accepted")
	}
}
