package protocol

import (
	"encoding/json"
	"errors"
)

const MaxMultiScreenParticipants = 4
const MaxMultiScreenSDPBytes = 64 * 1024
const MaxMultiScreenICEBytes = 4 * 1024

type MultiScreenJoinMessage struct {
	Type string `json:"type"`
}

type MultiScreenStateMessage struct {
	Type       string  `json:"type"`
	Generation *string `json:"generation"`
}

// SourcePeerID is the authenticated sender. Generation identifies the publisher:
// the sender for offers, the recipient for answers, either endpoint for ICE.
type MultiScreenSignalMessage struct {
	Type         string `json:"type"`
	TargetPeerID string `json:"targetPeerId"`
	SourcePeerID string `json:"sourcePeerId"`
	Generation   string `json:"generation"`
	Kind         string `json:"kind"`
	Payload      string `json:"payload"`
}

type MultiScreenPeer struct {
	PeerID      string      `json:"peerId"`
	DisplayName DisplayName `json:"displayName"`
	Generation  *string     `json:"generation"`
}

type MultiScreenRosterMessage struct {
	Type      string            `json:"type"`
	PeerID    string            `json:"peerId"`
	Transport string            `json:"transport"`
	Peers     []MultiScreenPeer `json:"peers"`
}

type MultiScreenSfuConfigMessage struct {
	Type                  string `json:"type"`
	SourcePeerID          string `json:"sourcePeerId"`
	Revision              Int    `json:"revision"`
	PublicationGeneration string `json:"publicationGeneration"`
	ConnectionID          string `json:"connectionId"`
}

type MultiScreenSfuSignalMessage struct {
	Type         string           `json:"type"`
	SourcePeerID string           `json:"sourcePeerId"`
	Signal       SfuSignalMessage `json:"signal"`
}

type MultiScreenSfuClosedMessage struct {
	Type                  string `json:"type"`
	SourcePeerID          string `json:"sourcePeerId"`
	PublicationGeneration string `json:"publicationGeneration"`
	ConnectionID          string `json:"connectionId"`
}

type MultiScreenRejectedMessage struct {
	Type    string `json:"type"`
	Command string `json:"command"`
	Reason  string `json:"reason"`
}

func (MultiScreenJoinMessage) isClientMessage()      {}
func (MultiScreenStateMessage) isClientMessage()     {}
func (MultiScreenSignalMessage) isClientMessage()    {}
func (MultiScreenSignalMessage) isServerMessage()    {}
func (MultiScreenRosterMessage) isServerMessage()    {}
func (MultiScreenRejectedMessage) isServerMessage()  {}
func (MultiScreenSfuConfigMessage) isServerMessage() {}
func (MultiScreenSfuSignalMessage) isClientMessage() {}
func (MultiScreenSfuSignalMessage) isServerMessage() {}
func (MultiScreenSfuClosedMessage) isClientMessage() {}
func (MultiScreenSfuClosedMessage) isServerMessage() {}

// MultiScreenCommand identifies an explicitly opted-in command even if its
// fields are malformed, so a local rejection need not close room signaling.
func MultiScreenCommand(data []byte) string {
	typ, _ := typeOf(data, "type")
	switch typ {
	case "multi-screen-join":
		return "join"
	case "multi-screen-state":
		return "state"
	case "multi-screen-signal", "multi-screen-sfu-signal", "multi-screen-sfu-closed":
		return "signal"
	}
	return ""
}

func decodeMultiScreenState(data []byte) (ClientMessage, error) {
	var message MultiScreenStateMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err = present.require("type"); err != nil {
		return nil, err
	}
	if err = present.requireNullable("generation"); err != nil {
		return nil, err
	}
	if message.Generation != nil && !ValidOpaqueID(*message.Generation) {
		return nil, errors.New("invalid screen generation")
	}
	return message, nil
}

func decodeMultiScreenSignal(data []byte) (MultiScreenSignalMessage, error) {
	var message MultiScreenSignalMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return message, err
	}
	if err = present.require("type", "targetPeerId", "sourcePeerId", "generation", "kind", "payload"); err != nil {
		return message, err
	}
	if !ValidOpaqueID(message.TargetPeerID) || !ValidOpaqueID(message.SourcePeerID) || !ValidOpaqueID(message.Generation) ||
		!enumOf(message.Kind, "offer", "answer", "ice") || len(message.Payload) == 0 || len(message.Payload) > MaxMultiScreenSDPBytes ||
		(message.Kind == "ice" && len(message.Payload) > MaxMultiScreenICEBytes) {
		return message, errors.New("invalid screen signal")
	}
	// The complete forwarded frame, including JSON escaping, must fit the same
	// socket bound as its producer. SDP's standalone ceiling is not a frame cap.
	encoded, err := marshalJSON(message)
	if err != nil || len(encoded) > MaxSignalBytes {
		return message, errors.New("screen signal frame is too large")
	}
	return message, nil
}

func (peer *MultiScreenPeer) UnmarshalJSON(data []byte) error {
	type plain MultiScreenPeer
	var value plain
	present, err := decodeObject(data, &value)
	if err != nil {
		return err
	}
	if err = present.require("peerId", "displayName"); err != nil {
		return err
	}
	if err = present.requireNullable("generation"); err != nil {
		return err
	}
	if !ValidOpaqueID(value.PeerID) || (value.Generation != nil && !ValidOpaqueID(*value.Generation)) {
		return errors.New("invalid screen peer")
	}
	*peer = MultiScreenPeer(value)
	return nil
}

func decodeMultiScreenRoster(data []byte) (ServerMessage, error) {
	var message MultiScreenRosterMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err = present.require("type", "peerId", "transport", "peers"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.PeerID) || !enumOf(message.Transport, "p2p", "sfu") || len(message.Peers) < 1 || len(message.Peers) > MaxMultiScreenParticipants {
		return nil, errors.New("invalid screen roster")
	}
	peers, generations := map[string]bool{}, map[string]bool{}
	for _, peer := range message.Peers {
		if peers[peer.PeerID] {
			return nil, errors.New("duplicate screen peer")
		}
		peers[peer.PeerID] = true
		if peer.Generation != nil {
			if generations[*peer.Generation] {
				return nil, errors.New("duplicate screen generation")
			}
			generations[*peer.Generation] = true
		}
	}
	if !peers[message.PeerID] {
		return nil, errors.New("screen roster omits recipient")
	}
	return message, nil
}

func decodeMultiScreenSfuConfig(data []byte) (MultiScreenSfuConfigMessage, error) {
	var message MultiScreenSfuConfigMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return message, err
	}
	if err = present.require("type", "sourcePeerId", "revision", "publicationGeneration", "connectionId"); err != nil {
		return message, err
	}
	if !ValidOpaqueID(message.SourcePeerID) || !validRevision(message.Revision) ||
		!ValidOpaqueID(message.PublicationGeneration) || !ValidOpaqueID(message.ConnectionID) {
		return message, errors.New("invalid screen SFU configuration")
	}
	return message, nil
}

func decodeMultiScreenSfuSignal(data []byte) (MultiScreenSfuSignalMessage, error) {
	var raw struct {
		Type         string          `json:"type"`
		SourcePeerID string          `json:"sourcePeerId"`
		Signal       json.RawMessage `json:"signal"`
	}
	var message MultiScreenSfuSignalMessage
	present, err := decodeObject(data, &raw)
	if err != nil {
		return message, err
	}
	if err = present.require("type", "sourcePeerId", "signal"); err != nil {
		return message, err
	}
	signal, err := decodeSfuSignal(raw.Signal)
	if err != nil {
		return message, err
	}
	if !ValidOpaqueID(raw.SourcePeerID) || signal.Type != "sfu-signal" {
		return message, errors.New("invalid screen SFU signal")
	}
	message = MultiScreenSfuSignalMessage{Type: raw.Type, SourcePeerID: raw.SourcePeerID, Signal: signal}
	encoded, err := marshalJSON(message)
	if err != nil || len(encoded) > MaxSignalBytes {
		return message, errors.New("screen SFU signal frame is too large")
	}
	return message, nil
}

func decodeMultiScreenSfuClosed(data []byte) (MultiScreenSfuClosedMessage, error) {
	var message MultiScreenSfuClosedMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return message, err
	}
	if err = present.require("type", "sourcePeerId", "publicationGeneration", "connectionId"); err != nil {
		return message, err
	}
	if !ValidOpaqueID(message.SourcePeerID) || !ValidOpaqueID(message.PublicationGeneration) || !ValidOpaqueID(message.ConnectionID) {
		return message, errors.New("invalid screen SFU closure")
	}
	return message, nil
}

func decodeMultiScreenRejected(data []byte) (ServerMessage, error) {
	var message MultiScreenRejectedMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err = present.require("type", "command", "reason"); err != nil {
		return nil, err
	}
	if !enumOf(message.Command, "join", "state", "signal") ||
		!enumOf(message.Reason, "room-full", "not-joined", "invalid-state", "target-unavailable", "forbidden") {
		return nil, errors.New("invalid screen rejection")
	}
	return message, nil
}
