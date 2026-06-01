import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { LobbySnapshot, WebRtcChannel, WebRtcSignal } from "../../shared/types";

type UseWebRtcOptions = {
  socket: Socket;
  lobby: LobbySnapshot | null;
  selfId: string;
  isInLobby: boolean;
  isHost: boolean;
  cameraEnabled: boolean;
  micEnabled: boolean;
};

type PeerKey = `${WebRtcChannel}:${string}`;

const rtcConfig: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

function peerKey(channel: WebRtcChannel, participantId: string): PeerKey {
  return `${channel}:${participantId}`;
}

function peerIdFromKey(key: string) {
  return key.slice(key.indexOf(":") + 1);
}

function addMissingTracks(peer: RTCPeerConnection, stream: MediaStream | null) {
  if (!stream) return false;

  let changed = false;
  const existingTrackIds = new Set(peer.getSenders().map((sender) => sender.track?.id).filter(Boolean));

  for (const track of stream.getTracks()) {
    if (!existingTrackIds.has(track.id)) {
      peer.addTrack(track, stream);
      changed = true;
    }
  }

  return changed;
}

export function useWebRtc({
  socket,
  lobby,
  selfId,
  isInLobby,
  isHost,
  cameraEnabled,
  micEnabled
}: UseWebRtcOptions) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteMediaStreams, setRemoteMediaStreams] = useState<Record<string, MediaStream>>({});
  const [remoteMovieStream, setRemoteMovieStream] = useState<MediaStream | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);

  const localStreamRef = useRef<MediaStream | null>(null);
  const movieStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<PeerKey, RTCPeerConnection>>(new Map());
  const makingOfferRef = useRef<Set<PeerKey>>(new Set());
  const pendingCandidatesRef = useRef<Map<PeerKey, RTCIceCandidateInit[]>>(new Map());
  const isHostRef = useRef(isHost);

  useEffect(() => {
    isHostRef.current = isHost;
  }, [isHost]);

  useEffect(() => {
    if (!isInLobby) return;

    let cancelled = false;

    async function startLocalMedia() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Camera and microphone are not available in this browser.");
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: {
            width: { ideal: 960 },
            height: { ideal: 540 },
            frameRate: { ideal: 24, max: 30 }
          }
        });

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        localStreamRef.current = stream;
        setLocalStream(stream);
        setMediaError(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to start camera or microphone.";
        setMediaError(message);
        socket.emit("permission:error", { message });
      }
    }

    startLocalMedia();

    return () => {
      cancelled = true;
    };
  }, [isInLobby, socket]);

  useEffect(() => {
    if (!localStream) return;

    for (const track of localStream.getVideoTracks()) {
      track.enabled = cameraEnabled;
    }

    for (const track of localStream.getAudioTracks()) {
      track.enabled = micEnabled;
    }
  }, [cameraEnabled, localStream, micEnabled]);

  const closePeer = useCallback((key: PeerKey) => {
    const peer = peersRef.current.get(key);
    if (!peer) return;

    peer.onicecandidate = null;
    peer.ontrack = null;
    peer.onnegotiationneeded = null;
    peer.close();
    peersRef.current.delete(key);
    makingOfferRef.current.delete(key);
    pendingCandidatesRef.current.delete(key);
  }, []);

  const flushCandidates = useCallback(async (key: PeerKey, peer: RTCPeerConnection) => {
    const candidates = pendingCandidatesRef.current.get(key);
    if (!candidates?.length) return;

    pendingCandidatesRef.current.delete(key);

    for (const candidate of candidates) {
      try {
        await peer.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // Late candidates can arrive after a peer has already been replaced.
      }
    }
  }, []);

  const negotiate = useCallback(
    async (channel: WebRtcChannel, participantId: string) => {
      const key = peerKey(channel, participantId);
      const peer = peersRef.current.get(key);
      if (!peer || peer.signalingState === "closed" || makingOfferRef.current.has(key)) return;

      try {
        makingOfferRef.current.add(key);
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        socket.emit("webrtc:offer", {
          to: participantId,
          channel,
          description: peer.localDescription
        });
      } catch {
        closePeer(key);
      } finally {
        makingOfferRef.current.delete(key);
      }
    },
    [closePeer, socket]
  );

  const ensurePeer = useCallback(
    (channel: WebRtcChannel, participantId: string) => {
      const key = peerKey(channel, participantId);
      const existing = peersRef.current.get(key);
      if (existing) return existing;

      const peer = new RTCPeerConnection(rtcConfig);

      peer.onicecandidate = (event) => {
        if (!event.candidate) return;
        socket.emit("webrtc:ice-candidate", {
          to: participantId,
          channel,
          candidate: event.candidate.toJSON()
        });
      };

      peer.ontrack = (event) => {
        const [stream] = event.streams;
        const mediaStream = stream ?? new MediaStream([event.track]);

        if (channel === "movie") {
          setRemoteMovieStream(mediaStream);
          return;
        }

        setRemoteMediaStreams((current) => ({
          ...current,
          [participantId]: mediaStream
        }));
      };

      peer.onconnectionstatechange = () => {
        if (["failed", "closed", "disconnected"].includes(peer.connectionState)) {
          if (channel === "media") {
            setRemoteMediaStreams((current) => {
              const next = { ...current };
              delete next[participantId];
              return next;
            });
          }

          if (channel === "movie") {
            setRemoteMovieStream(null);
          }
        }
      };

      peer.onnegotiationneeded = () => {
        if (channel === "movie" && isHostRef.current) {
          void negotiate(channel, participantId);
        }

        if (channel === "media" && selfId < participantId) {
          void negotiate(channel, participantId);
        }
      };

      peersRef.current.set(key, peer);
      return peer;
    },
    [negotiate, selfId, socket]
  );

  useEffect(() => {
    if (!isInLobby || !lobby) return;

    const activeParticipantIds = new Set(lobby.participants.filter((participant) => participant.id !== selfId).map((participant) => participant.id));

    for (const key of peersRef.current.keys()) {
      if (!activeParticipantIds.has(peerIdFromKey(key))) {
        closePeer(key);
      }
    }

    for (const participant of lobby.participants) {
      if (participant.id === selfId) continue;

      const mediaPeer = ensurePeer("media", participant.id);
      const addedMediaTracks = addMissingTracks(mediaPeer, localStreamRef.current);

      if ((addedMediaTracks || !mediaPeer.localDescription) && selfId < participant.id) {
        void negotiate("media", participant.id);
      }

      if (isHost && movieStreamRef.current && participant.role === "guest") {
        const moviePeer = ensurePeer("movie", participant.id);
        const addedMovieTracks = addMissingTracks(moviePeer, movieStreamRef.current);

        if (addedMovieTracks || !moviePeer.localDescription) {
          void negotiate("movie", participant.id);
        }
      }
    }
  }, [closePeer, ensurePeer, isHost, isInLobby, lobby, localStream, negotiate, selfId]);

  useEffect(() => {
    function queueCandidate(key: PeerKey, candidate: RTCIceCandidateInit) {
      const queued = pendingCandidatesRef.current.get(key) ?? [];
      queued.push(candidate);
      pendingCandidatesRef.current.set(key, queued);
    }

    async function handleOffer(signal: WebRtcSignal) {
      if (!signal.description) return;

      const key = peerKey(signal.channel, signal.from);
      const peer = ensurePeer(signal.channel, signal.from);

      if (signal.channel === "media") {
        addMissingTracks(peer, localStreamRef.current);
      }

      const offerCollision = makingOfferRef.current.has(key) || peer.signalingState !== "stable";
      const polite = selfId > signal.from || signal.channel === "movie";

      if (offerCollision && !polite) return;

      try {
        await peer.setRemoteDescription(new RTCSessionDescription(signal.description));
        await flushCandidates(key, peer);

        if (signal.channel === "media") {
          addMissingTracks(peer, localStreamRef.current);
        }

        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        socket.emit("webrtc:answer", {
          to: signal.from,
          channel: signal.channel,
          description: peer.localDescription
        });
      } catch {
        closePeer(key);
      }
    }

    async function handleAnswer(signal: WebRtcSignal) {
      if (!signal.description) return;

      const key = peerKey(signal.channel, signal.from);
      const peer = peersRef.current.get(key);
      if (!peer || peer.signalingState === "closed") return;

      try {
        await peer.setRemoteDescription(new RTCSessionDescription(signal.description));
        await flushCandidates(key, peer);
      } catch {
        closePeer(key);
      }
    }

    async function handleCandidate(signal: WebRtcSignal) {
      if (!signal.candidate) return;

      const key = peerKey(signal.channel, signal.from);
      const peer = ensurePeer(signal.channel, signal.from);

      if (!peer.remoteDescription) {
        queueCandidate(key, signal.candidate);
        return;
      }

      try {
        await peer.addIceCandidate(new RTCIceCandidate(signal.candidate));
      } catch {
        queueCandidate(key, signal.candidate);
      }
    }

    socket.on("webrtc:offer", handleOffer);
    socket.on("webrtc:answer", handleAnswer);
    socket.on("webrtc:ice-candidate", handleCandidate);

    return () => {
      socket.off("webrtc:offer", handleOffer);
      socket.off("webrtc:answer", handleAnswer);
      socket.off("webrtc:ice-candidate", handleCandidate);
    };
  }, [closePeer, ensurePeer, flushCandidates, selfId, socket]);

  const clearMovieStream = useCallback(() => {
    movieStreamRef.current = null;
    setRemoteMovieStream(null);

    for (const key of Array.from(peersRef.current.keys())) {
      if (key.startsWith("movie:")) {
        closePeer(key);
      }
    }
  }, [closePeer]);

  const publishMovieStream = useCallback(
    (stream: MediaStream) => {
      movieStreamRef.current = stream;

      if (!lobby || !isHostRef.current) return;

      for (const participant of lobby.participants) {
        if (participant.id === selfId || participant.role !== "guest") continue;

        const moviePeer = ensurePeer("movie", participant.id);
        const addedTracks = addMissingTracks(moviePeer, stream);

        if (addedTracks || !moviePeer.localDescription) {
          void negotiate("movie", participant.id);
        }
      }
    },
    [ensurePeer, lobby, negotiate, selfId]
  );

  useEffect(() => {
    if (isInLobby) return;

    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setRemoteMediaStreams({});
    clearMovieStream();

    for (const key of Array.from(peersRef.current.keys())) {
      closePeer(key);
    }
  }, [clearMovieStream, closePeer, isInLobby]);

  return {
    localStream,
    remoteMediaStreams,
    remoteMovieStream,
    mediaError,
    publishMovieStream,
    clearMovieStream
  };
}
