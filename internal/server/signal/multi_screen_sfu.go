package signal

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
	"github.com/TNTcraftHIM/Piik/internal/server/sfu"
	"github.com/pion/webrtc/v4"
)

// The authenticated source session owns its publication and exact recipient
// connections. Media remains the same embedded runtime and global admission.
type multiScreenPublication struct {
	fence         sfu.ResourceFence
	connectionID  string
	ready         bool
	stop          func() bool
	work          sync.WaitGroup
	subscriptions map[string]*multiScreenSubscription
}

type multiScreenSubscription struct {
	fence     sfu.SubscriptionFence
	sessionID string
	cancel    context.CancelFunc
	stop      func() bool
	prepared  chan struct{}
	ready     bool
	closed    bool // Retain the retired identity until this source generation ends.
}

func (s *Server) multiScreenPrepareTimeout() time.Duration {
	value := int64(defaultRouteOperationTimeoutMs)
	if s.sfuFallback.PrepareTimeoutMs > 0 {
		value = s.sfuFallback.PrepareTimeoutMs
	}
	return time.Duration(value) * time.Millisecond
}

func (s *Server) ensureMultiScreenPublication(sess *session, auth *authenticatedSession) {
	if auth.multiScreenPublication != nil || s.closing {
		return
	}
	fence := sfu.ResourceFence{RoomID: auth.roomID, PublisherPeerID: auth.peerID,
		ShareGeneration: auth.multiScreenGeneration, PublicationGeneration: auth.multiScreenGeneration}
	if !s.sfuFallback.Admission.ReservePublication(fence) {
		auth.multiScreenGeneration = ""
		s.rejectMultiScreen(sess, "state", "invalid-state")
		s.sendMultiScreenRoster(auth.roomID)
		return
	}
	publication := &multiScreenPublication{fence: fence, connectionID: opaqueID(),
		subscriptions: map[string]*multiScreenSubscription{}}
	auth.multiScreenPublication = publication
	publication.stop = s.afterFunc(s.multiScreenPrepareTimeout(), func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.currentMultiScreenSource(fence) == sess && auth.multiScreenPublication == publication {
			s.failMultiScreenPublication(sess, publication)
		}
	})
	s.sendMultiScreenSfuConfig(sess, publication, publication.connectionID)
}

func (s *Server) sendMultiScreenSfuConfig(sess *session, publication *multiScreenPublication, connectionID string) {
	s.send(sess, protocol.MultiScreenSfuConfigMessage{Type: "multi-screen-sfu-config",
		SourcePeerID: publication.fence.PublisherPeerID, Revision: 1,
		PublicationGeneration: publication.fence.PublicationGeneration, ConnectionID: connectionID})
}

func (s *Server) currentMultiScreenSource(fence sfu.ResourceFence) *session {
	if s.closing || s.sfuFallback == nil {
		return nil
	}
	for _, sess := range s.multiScreenPeers(fence.RoomID) {
		auth := sess.authenticated
		if auth.peerID == fence.PublisherPeerID && auth.multiScreenGeneration == fence.PublicationGeneration &&
			auth.multiScreenPublication != nil && auth.multiScreenPublication.fence == fence {
			return sess
		}
	}
	return nil
}

func (s *Server) multiScreenSfuAuthorized(sess *session, auth *authenticatedSession, sourcePeerID string,
	message protocol.SfuSignalMessage) (*multiScreenPublication, *multiScreenSubscription) {
	if s.closing || s.sfuFallback == nil || auth == nil || sess.authenticated != auth || !auth.multiScreen ||
		!sess.open() || sess.revoked || !s.isCurrentSession(sess) || message.Revision != 1 {
		return nil, nil
	}
	fence := sfu.ResourceFence{RoomID: auth.roomID, PublisherPeerID: sourcePeerID,
		ShareGeneration: message.PublicationGeneration, PublicationGeneration: message.PublicationGeneration}
	source := s.currentMultiScreenSource(fence)
	if source == nil || !s.sfuFallback.Admission.HasPublication(fence) {
		return nil, nil
	}
	publication := source.authenticated.multiScreenPublication
	if source == sess {
		if publication.connectionID == message.ConnectionID {
			return publication, nil
		}
		return nil, nil
	}
	subscription := publication.subscriptions[auth.peerID]
	if subscription == nil || subscription.closed || subscription.sessionID != sess.sessionID ||
		subscription.fence.ConnectionID != message.ConnectionID || !s.sfuFallback.Admission.HasSubscription(subscription.fence) {
		return nil, nil
	}
	return publication, subscription
}

func (s *Server) handleMultiScreenSfuSignal(sess *session, auth *authenticatedSession, envelope protocol.MultiScreenSfuSignalMessage) {
	message := envelope.Signal
	publication, subscription := s.multiScreenSfuAuthorized(sess, auth, envelope.SourcePeerID, message)
	if publication == nil {
		s.rejectMultiScreen(sess, "signal", "forbidden")
		return
	}
	publisher := subscription == nil
	if message.Kind == "layers" || (message.Kind == "media" && !publisher) ||
		(message.Kind == "subscribe" && (publisher || !subscription.ready)) ||
		(message.Kind == "description" && ((publisher && message.Description.Type != "offer") ||
			(!publisher && (message.Description.Type != "answer" || !subscription.ready)))) {
		s.rejectMultiScreen(sess, "signal", "forbidden")
		return
	}
	media := s.sfuFallback.Media
	var description webrtc.SessionDescription
	var err error
	newPublication := false
	publication.work.Add(1)
	s.router.io(func() {
		defer publication.work.Done()
		switch message.Kind {
		case "media":
			err = media.UpdatePublication(publication.fence, message.ConnectionID, sfuPublicationMedia(message.Media))
		case "description":
			incoming := webrtc.SessionDescription{Type: webrtc.NewSDPType(message.Description.Type), SDP: message.Description.SDP}
			if publisher {
				if !media.HasPublication(publication.fence, message.ConnectionID) {
					if message.Media == nil {
						return
					}
					err = media.PreparePublication(publication.fence, message.ConnectionID, sfuPublicationMedia(message.Media))
					newPublication = err == nil
				}
				if err == nil {
					description, err = media.AcceptPublisherOffer(publication.fence, message.ConnectionID, incoming)
				}
			} else {
				err = media.ApplySubscriberAnswer(subscription.fence, message.ConnectionID, incoming)
			}
		case "candidate":
			var candidate webrtc.ICECandidateInit
			if message.Candidate != nil {
				encoded, _ := json.Marshal(message.Candidate)
				_ = json.Unmarshal(encoded, &candidate)
			}
			if publisher {
				err = media.AddPublisherICE(publication.fence, message.ConnectionID, candidate)
			} else {
				err = media.AddSubscriberICE(subscription.fence, message.ConnectionID, candidate)
			}
		case "subscribe":
			description, err = media.RestartSubscriber(subscription.fence, message.ConnectionID)
		}
	})
	if current, _ := s.multiScreenSfuAuthorized(sess, auth, envelope.SourcePeerID, message); current != publication {
		return
	}
	if err != nil {
		if publisher {
			s.failMultiScreenPublication(sess, publication)
		} else {
			s.failMultiScreenSubscription(publication, subscription)
		}
		return
	}
	if description.SDP != "" {
		message.Kind = "description"
		message.Description = &protocol.SessionDescription{Type: description.Type.String(), SDP: description.SDP}
		message.Candidate, message.Media = nil, nil
		s.send(sess, protocol.MultiScreenSfuSignalMessage{Type: "multi-screen-sfu-signal", SourcePeerID: envelope.SourcePeerID, Signal: message})
	}
	if newPublication {
		if _, committed := s.sfuFallback.Admission.CommitPublication(publication.fence); !committed {
			s.failMultiScreenPublication(sess, publication)
			return
		}
		publication.ready = true
		s.prepareMultiScreenSubscriptions(auth.roomID)
	}
}

func (s *Server) prepareMultiScreenSubscriptions(roomID string) {
	if s.sfuFallback == nil || s.closing {
		return
	}
	peers := s.multiScreenPeers(roomID)
	for _, source := range peers {
		publication := source.authenticated.multiScreenPublication
		if publication == nil || !publication.ready {
			continue
		}
		for _, recipient := range peers {
			previous := publication.subscriptions[recipient.authenticated.peerID]
			if recipient == source || (previous != nil && previous.sessionID == recipient.sessionID) {
				continue
			}
			fence := sfu.SubscriptionFence{ResourceFence: publication.fence,
				ViewerPeerID: recipient.authenticated.peerID, ConnectionID: opaqueID()}
			if !s.sfuFallback.Admission.ReserveSubscription(fence) {
				s.rejectMultiScreen(recipient, "signal", "invalid-state")
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), s.multiScreenPrepareTimeout())
			subscription := &multiScreenSubscription{fence: fence, sessionID: recipient.sessionID,
				cancel: cancel, prepared: make(chan struct{})}
			publication.subscriptions[fence.ViewerPeerID] = subscription
			subscription.stop = s.afterFunc(s.multiScreenPrepareTimeout(), func() {
				s.mu.Lock()
				defer s.mu.Unlock()
				if s.currentMultiScreenSource(publication.fence) != nil && !subscription.closed {
					s.failMultiScreenSubscription(publication, subscription)
				}
			})
			s.sendMultiScreenSfuConfig(recipient, publication, fence.ConnectionID)
			publication.work.Add(1)
			s.router.inflight++
			go func() {
				defer cancel()
				description, err := s.sfuFallback.Media.PrepareSubscriber(ctx, fence, fence.ConnectionID)
				publication.work.Done()
				close(subscription.prepared)
				s.mu.Lock()
				defer s.mu.Unlock()
				s.router.inflight--
				message := protocol.SfuSignalMessage{Type: "sfu-signal", Kind: "description", Revision: 1,
					PublicationGeneration: fence.PublicationGeneration, ConnectionID: fence.ConnectionID}
				if current, exact := s.multiScreenSfuAuthorized(recipient, recipient.authenticated, fence.PublisherPeerID, message); current != publication || exact != subscription {
					return
				}
				if err != nil {
					s.failMultiScreenSubscription(publication, subscription)
					return
				}
				subscription.ready = true
				message.Description = &protocol.SessionDescription{Type: description.Type.String(), SDP: description.SDP}
				s.send(recipient, protocol.MultiScreenSfuSignalMessage{Type: "multi-screen-sfu-signal", SourcePeerID: fence.PublisherPeerID, Signal: message})
			}()
		}
	}
}

func (s *Server) retireMultiScreenSubscription(publication *multiScreenPublication, peerID string) {
	subscription := publication.subscriptions[peerID]
	if subscription == nil || subscription.closed {
		return
	}
	subscription.closed = true
	subscription.cancel()
	if subscription.stop != nil {
		subscription.stop()
	}
	if s.sfuFallback.Admission.BeginSubscriptionDrain(subscription.fence) {
		s.router.scheduleSfuDrainAfter(drainSubscription, subscription.fence, subscription.prepared)
	}
}

func (s *Server) retireMultiScreenPublication(auth *authenticatedSession) {
	publication := auth.multiScreenPublication
	if publication == nil {
		return
	}
	auth.multiScreenPublication = nil
	if publication.stop != nil {
		publication.stop()
	}
	for _, subscription := range publication.subscriptions {
		subscription.closed = true
		subscription.cancel()
		if subscription.stop != nil {
			subscription.stop()
		}
	}
	if s.sfuFallback.Admission.BeginDrain(publication.fence) {
		settled := make(chan struct{})
		go func() { publication.work.Wait(); close(settled) }()
		s.router.scheduleSfuDrainAfter(drainPublication, sfu.SubscriptionFence{ResourceFence: publication.fence}, settled)
	}
}

func (s *Server) failMultiScreenPublication(source *session, publication *multiScreenPublication) {
	s.sendMultiScreenSfuClosed(source, publication.fence, publication.connectionID)
	auth := source.authenticated
	auth.multiScreenGeneration = ""
	s.retireMultiScreenPublication(auth)
	s.sendMultiScreenRoster(auth.roomID)
}

func (s *Server) failMultiScreenSubscription(publication *multiScreenPublication, subscription *multiScreenSubscription) {
	if recipient := s.sessionsByID[subscription.sessionID]; recipient != nil {
		s.sendMultiScreenSfuClosed(recipient, publication.fence, subscription.fence.ConnectionID)
	}
	s.retireMultiScreenSubscription(publication, subscription.fence.ViewerPeerID)
}

func (s *Server) sendMultiScreenSfuClosed(sess *session, fence sfu.ResourceFence, connectionID string) {
	s.send(sess, protocol.MultiScreenSfuClosedMessage{Type: "multi-screen-sfu-closed", SourcePeerID: fence.PublisherPeerID,
		PublicationGeneration: fence.PublicationGeneration, ConnectionID: connectionID})
}

func (s *Server) handleMultiScreenSfuClosed(sess *session, auth *authenticatedSession, message protocol.MultiScreenSfuClosedMessage) {
	publication, subscription := s.multiScreenSfuAuthorized(sess, auth, message.SourcePeerID, protocol.SfuSignalMessage{
		Revision: 1, PublicationGeneration: message.PublicationGeneration, ConnectionID: message.ConnectionID})
	if publication == nil {
		return // Exact closure is idempotent; retired handles never authorize new work.
	}
	if subscription == nil {
		s.failMultiScreenPublication(sess, publication)
	} else {
		s.failMultiScreenSubscription(publication, subscription)
	}
}

func (s *Server) handleMultiScreenSfuMediaEvent(event sfu.MediaEvent) {
	source := s.currentMultiScreenSource(event.Fence)
	if source == nil {
		return
	}
	recipient := source
	if event.ViewerPeerID != "" {
		peer, connected := s.connectedPeer(event.Fence.RoomID, event.ViewerPeerID)
		if !connected {
			return
		}
		recipient = s.sessionsByID[peer.SessionID]
		if recipient == nil {
			return
		}
	}
	message := protocol.SfuSignalMessage{Type: "sfu-signal", Kind: "candidate", Revision: 1,
		PublicationGeneration: event.Fence.PublicationGeneration, ConnectionID: event.ConnectionID}
	publication, subscription := s.multiScreenSfuAuthorized(recipient, recipient.authenticated, event.Fence.PublisherPeerID, message)
	if publication == nil {
		return
	}
	if event.State == webrtc.PeerConnectionStateConnected {
		if subscription == nil {
			publication.stop()
		} else {
			subscription.stop()
			s.sfuFallback.Admission.CommitSubscription(subscription.fence)
		}
		return
	}
	if event.State == webrtc.PeerConnectionStateFailed {
		if subscription == nil {
			s.failMultiScreenPublication(source, publication)
		} else {
			s.failMultiScreenSubscription(publication, subscription)
		}
		return
	}
	if event.ActiveCount != nil {
		message.Kind = "layers"
		count := protocol.Int(*event.ActiveCount)
		message.ActiveCount = &count
	} else if event.State == webrtc.PeerConnectionStateUnknown {
		if event.Candidate != nil {
			encoded, _ := json.Marshal(event.Candidate)
			_ = json.Unmarshal(encoded, &message.Candidate)
		}
	} else {
		return
	}
	s.send(recipient, protocol.MultiScreenSfuSignalMessage{Type: "multi-screen-sfu-signal", SourcePeerID: event.Fence.PublisherPeerID, Signal: message})
}
