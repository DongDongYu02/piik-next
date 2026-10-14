package signal

import "github.com/TNTcraftHIM/Piik/internal/server/protocol"

// Existing room membership owns one independent source per opted-in session.
// A configured embedded SFU forwards these sources; otherwise peers connect directly.
func (s *Server) multiScreenPeers(roomID string) []*session {
	peers := []*session{}
	add := func(sessionID string) {
		sess := s.sessionsByID[sessionID]
		if sess != nil && sess.open() && !sess.revoked && sess.authenticated != nil &&
			sess.authenticated.roomID == roomID && sess.authenticated.multiScreen && s.isCurrentSession(sess) {
			peers = append(peers, sess)
		}
	}
	if host, ok := s.store.GetConnectedHost(roomID); ok {
		add(host.SessionID)
	}
	for _, viewer := range s.store.GetConnectedViewers(roomID) {
		add(viewer.SessionID)
	}
	return peers
}

func (s *Server) rejectMultiScreen(sess *session, command, reason string) {
	s.send(sess, protocol.MultiScreenRejectedMessage{Type: "multi-screen-rejected", Command: command, Reason: reason})
}

func multiScreenName(authenticated *authenticatedSession) protocol.DisplayName {
	if authenticated.displayName != nil {
		return protocol.DisplayName(*authenticated.displayName)
	}
	if authenticated.role == protocol.RoleHost {
		return protocol.DisplayName(protocol.DefaultHostDisplayNamePrefix)
	}
	return protocol.DisplayName(protocol.DefaultViewerDisplayName)
}

func (s *Server) sendMultiScreenRoster(roomID string) {
	sessions := s.multiScreenPeers(roomID)
	peers := make([]protocol.MultiScreenPeer, 0, len(sessions))
	for _, sess := range sessions {
		authenticated := sess.authenticated
		var generation *string
		if authenticated.multiScreenGeneration != "" {
			value := authenticated.multiScreenGeneration
			generation = &value
		}
		peers = append(peers, protocol.MultiScreenPeer{
			PeerID: authenticated.peerID, DisplayName: multiScreenName(authenticated), Generation: generation,
		})
	}
	for _, sess := range sessions {
		transport := "p2p"
		if s.sfuFallback != nil {
			transport = "sfu"
		}
		s.send(sess, protocol.MultiScreenRosterMessage{Type: "multi-screen-roster", PeerID: sess.authenticated.peerID, Peers: peers, Transport: transport})
	}
}

func (s *Server) joinMultiScreen(sess *session, authenticated *authenticatedSession) {
	if (s.router.sfuOnly && s.sfuFallback == nil) || s.activeHostShareGeneration(authenticated.roomID) != "" ||
		(authenticated.role == protocol.RoleHost && (!authenticated.roomOnly || !authenticated.roomSession)) {
		s.rejectMultiScreen(sess, "join", "forbidden")
		return
	}
	if !authenticated.multiScreen && len(s.multiScreenPeers(authenticated.roomID)) >= protocol.MaxMultiScreenParticipants {
		s.rejectMultiScreen(sess, "join", "room-full")
		return
	}
	authenticated.multiScreen = true
	if authenticated.role == protocol.RoleViewer {
		// Viewer authentication may have prepared an idle legacy route. The
		// explicit mode owns its independent source connections after opt-in.
		s.router.removeViewer(authenticated.roomID, authenticated.peerID)
	}
	s.sendMultiScreenRoster(authenticated.roomID)
	s.prepareMultiScreenSubscriptions(authenticated.roomID)
}

func (s *Server) setMultiScreenState(sess *session, authenticated *authenticatedSession, message protocol.MultiScreenStateMessage) {
	if !authenticated.multiScreen {
		s.rejectMultiScreen(sess, "state", "not-joined")
		return
	}
	generation := ""
	if message.Generation != nil {
		generation = *message.Generation
		for _, peer := range s.multiScreenPeers(authenticated.roomID) {
			if peer != sess && peer.authenticated.multiScreenGeneration == generation {
				s.rejectMultiScreen(sess, "state", "invalid-state")
				return
			}
		}
	}
	if authenticated.multiScreenGeneration != generation {
		s.retireMultiScreenPublication(authenticated)
		authenticated.multiScreenGeneration = generation
	}
	s.sendMultiScreenRoster(authenticated.roomID)
	if generation != "" && s.sfuFallback != nil {
		s.ensureMultiScreenPublication(sess, authenticated)
	}
}

func (s *Server) relayMultiScreenSignal(sess *session, authenticated *authenticatedSession, message protocol.MultiScreenSignalMessage) {
	if !authenticated.multiScreen {
		s.rejectMultiScreen(sess, "signal", "not-joined")
		return
	}
	if s.sfuFallback != nil {
		s.rejectMultiScreen(sess, "signal", "forbidden")
		return
	}
	if message.SourcePeerID != authenticated.peerID || message.TargetPeerID == authenticated.peerID {
		s.rejectMultiScreen(sess, "signal", "forbidden")
		return
	}
	var target *session
	for _, peer := range s.multiScreenPeers(authenticated.roomID) {
		if peer.authenticated.peerID == message.TargetPeerID {
			target = peer
			break
		}
	}
	if target == nil {
		s.rejectMultiScreen(sess, "signal", "target-unavailable")
		return
	}
	senderPublishes := authenticated.multiScreenGeneration == message.Generation
	targetPublishes := target.authenticated.multiScreenGeneration == message.Generation
	if !senderPublishes && !targetPublishes {
		s.rejectMultiScreen(sess, "signal", "invalid-state")
		return
	}
	if (message.Kind == "offer" && !senderPublishes) || (message.Kind == "answer" && !targetPublishes) {
		s.rejectMultiScreen(sess, "signal", "forbidden")
		return
	}
	message.SourcePeerID = authenticated.peerID
	s.send(target, message)
}

// Removal is immediate, including session replacement and grant revocation.
// Reauthentication creates a fresh opt-in with no inherited publication.
func (s *Server) removeMultiScreen(sess *session) {
	if sess.authenticated == nil || !sess.authenticated.multiScreen {
		return
	}
	authenticated := sess.authenticated
	authenticated.multiScreen = false
	authenticated.multiScreenGeneration = ""
	s.retireMultiScreenPublication(authenticated)
	for _, publisher := range s.multiScreenPeers(authenticated.roomID) {
		publication := publisher.authenticated.multiScreenPublication
		if publication != nil {
			s.retireMultiScreenSubscription(publication, authenticated.peerID)
			delete(publication.subscriptions, authenticated.peerID)
		}
	}
	s.sendMultiScreenRoster(authenticated.roomID)
}
