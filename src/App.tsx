import {
  BadgeCheck,
  Check,
  Clapperboard,
  Copy,
  DoorOpen,
  Film,
  Gauge,
  LogOut,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  MonitorPlay,
  Pause,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Settings2,
  SkipBack,
  SkipForward,
  Upload,
  UserMinus,
  UserPlus,
  Users,
  Video,
  VideoOff,
  Volume2,
  X
} from "lucide-react";
import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import type {
  FilterId,
  JoinRequest,
  LobbySnapshot,
  MovieScreenPayload,
  MovieStatePayload,
  Participant,
  Role,
  ServerAck
} from "../shared/types";
import { useWebRtc } from "./hooks/useWebRtc";

type ViewState = "home" | "waiting" | "lobby" | "ended";

type ActiveSession = {
  code: string;
  name: string;
  role: Role;
};

type CreateLobbyAck = ServerAck<{
  snapshot: LobbySnapshot;
  participant: Participant;
}>;

type JoinLobbyAck = ServerAck<
  | {
      status: "waiting";
      requestId: string;
    }
  | {
      status: "approved";
      snapshot: LobbySnapshot;
      participant: Participant;
    }
>;

const signalUrl = import.meta.env.VITE_SIGNAL_URL ?? (window.location.port === "5173" ? "http://localhost:4000" : window.location.origin);
const socket = io(signalUrl, { transports: ["websocket", "polling"] });

const sessionKey = "chillwatch.sessionId";
const activeSessionKey = "chillwatch.activeSession";

const filters: Array<{ id: FilterId; label: string }> = [
  { id: "none", label: "Clean" },
  { id: "warm", label: "Warm" },
  { id: "noir", label: "Noir" },
  { id: "soft", label: "Soft" },
  { id: "cinema", label: "Cinema" }
];

function getSessionId() {
  const existing = sessionStorage.getItem(sessionKey);
  if (existing) return existing;

  const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  sessionStorage.setItem(sessionKey, id);
  return id;
}

function saveActiveSession(session: ActiveSession) {
  sessionStorage.setItem(activeSessionKey, JSON.stringify(session));
}

function loadActiveSession() {
  const stored = sessionStorage.getItem(activeSessionKey);
  if (!stored) return null;

  try {
    return JSON.parse(stored) as ActiveSession;
  } catch {
    sessionStorage.removeItem(activeSessionKey);
    return null;
  }
}

function clearActiveSession() {
  sessionStorage.removeItem(activeSessionKey);
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function formatTime(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0:00";

  const totalSeconds = Math.floor(value);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function captureVideoElement(video: HTMLVideoElement) {
  const captureTarget = video as HTMLVideoElement & {
    captureStream?: () => MediaStream;
    mozCaptureStream?: () => MediaStream;
  };

  return captureTarget.captureStream?.() ?? captureTarget.mozCaptureStream?.() ?? null;
}

function mergeMovie(snapshot: LobbySnapshot | null, movie: MovieStatePayload | null) {
  if (!snapshot) return snapshot;
  return { ...snapshot, movie };
}

function App() {
  const [sessionId] = useState(getSessionId);
  const [view, setView] = useState<ViewState>("home");
  const [connected, setConnected] = useState(socket.connected);
  const [lobby, setLobby] = useState<LobbySnapshot | null>(null);
  const [hostName, setHostName] = useState("");
  const [guestName, setGuestName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [role, setRole] = useState<Role>("guest");
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [micEnabled, setMicEnabled] = useState(true);
  const [selectedFilter, setSelectedFilter] = useState<FilterId>("none");
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [movieUrl, setMovieUrl] = useState<string | null>(null);
  const [movieFileName, setMovieFileName] = useState<string | null>(null);
  const [movieCompatibility, setMovieCompatibility] = useState<string | null>(null);

  const hostMovieRef = useRef<HTMLVideoElement | null>(null);
  const guestMovieRef = useRef<HTMLVideoElement | null>(null);
  const movieInputRef = useRef<HTMLInputElement | null>(null);
  const movieShellRef = useRef<HTMLDivElement | null>(null);
  const lastMovieSyncRef = useRef(0);

  const self = useMemo(() => lobby?.participants.find((participant) => participant.id === sessionId) ?? null, [lobby, sessionId]);
  const isInLobby = view === "lobby" && Boolean(self);
  const isHost = self?.role === "host";
  const isTheaterMode = Boolean(lobby?.theaterMode);

  const { localStream, remoteMediaStreams, remoteMovieStream, mediaError, publishMovieStream, clearMovieStream } = useWebRtc({
    socket,
    lobby,
    selfId: sessionId,
    isInLobby,
    isHost,
    cameraEnabled,
    micEnabled
  });

  const activeParticipants = lobby?.participants ?? [];
  const leftRail = activeParticipants.filter((_, index) => index % 2 === 0);
  const rightRail = activeParticipants.filter((_, index) => index % 2 === 1);

  const applySnapshot = useCallback(
    (snapshot: LobbySnapshot) => {
      setLobby(snapshot);

      const participant = snapshot.participants.find((item) => item.id === sessionId);
      if (!participant) return;

      setRole(participant.role);
      if (participant.role === "host") {
        setHostName(participant.name);
      } else {
        setGuestName(participant.name);
      }
      setCameraEnabled(participant.cameraEnabled);
      setMicEnabled(participant.micEnabled);
      setSelectedFilter(participant.filter);
      setView("lobby");
      saveActiveSession({ code: snapshot.code, name: participant.name, role: participant.role });
    },
    [sessionId]
  );

  const resumeSession = useCallback(() => {
    const activeSession = loadActiveSession();
    if (!activeSession) return;

    if (activeSession.role === "host") {
      setHostName(activeSession.name);
    } else {
      setGuestName(activeSession.name);
    }
    setJoinCode(activeSession.code);
    setRole(activeSession.role);
    setNotice("Rejoining lobby...");

    socket.emit("lobby:resume", { code: activeSession.code, sessionId }, (ack: JoinLobbyAck) => {
      if (!ack.ok) {
        clearActiveSession();
        setView("home");
        setLobby(null);
        setNotice(ack.error);
        return;
      }

      if (ack.status === "waiting") {
        setView("waiting");
        setNotice("Waiting for host approval.");
        return;
      }

      applySnapshot(ack.snapshot);
      setNotice(null);
    });
  }, [applySnapshot, sessionId]);

  useEffect(() => {
    const handleConnect = () => {
      setConnected(true);
      resumeSession();
    };

    const handleDisconnect = () => {
      setConnected(false);
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);

    if (socket.connected) {
      handleConnect();
    }

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
    };
  }, [resumeSession]);

  useEffect(() => {
    function handleSnapshot(snapshot: LobbySnapshot) {
      setLobby(snapshot);

      const participant = snapshot.participants.find((item) => item.id === sessionId);
      if (participant) {
        setCameraEnabled(participant.cameraEnabled);
        setMicEnabled(participant.micEnabled);
        setSelectedFilter(participant.filter);
      }
    }

    function handlePending(pendingRequests: JoinRequest[]) {
      setLobby((current) => (current ? { ...current, pendingRequests } : current));
    }

    function handleApproved(payload: { snapshot: LobbySnapshot; participant: Participant }) {
      applySnapshot(payload.snapshot);
      setNotice("Joined lobby.");
    }

    function leaveCurrentLobby(message: string) {
      clearActiveSession();
      setLobby(null);
      setView("ended");
      setNotice(message);
      setMovieUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
      setMovieFileName(null);
      clearMovieStream();
    }

    function handleMoviePayload(payload: MovieStatePayload) {
      setLobby((current) => mergeMovie(current, payload));
    }

    function handleMovieScreen(payload: MovieScreenPayload) {
      setLobby((current) => (current ? { ...current, theaterMode: payload.theaterMode } : current));
    }

    socket.on("participant:list", handleSnapshot);
    socket.on("lobby:pending", handlePending);
    socket.on("join:approved", handleApproved);
    socket.on("join:rejected", () => leaveCurrentLobby("The host rejected your request."));
    socket.on("participant:removed", () => leaveCurrentLobby("The host removed you from the lobby."));
    socket.on("lobby:ended", () => leaveCurrentLobby("The lobby has ended."));
    socket.on("host:disconnected", () => leaveCurrentLobby("The host disconnected."));
    socket.on("movie:ready", handleMoviePayload);
    socket.on("movie:state", handleMoviePayload);
    socket.on("movie:ended", handleMoviePayload);
    socket.on("movie:unloaded", () => setLobby((current) => (current ? { ...current, movie: null, theaterMode: false } : current)));
    socket.on("movie:screen", handleMovieScreen);
    socket.on("permission:error", (payload: { participantId: string; message: string }) => {
      const participant = lobby?.participants.find((item) => item.id === payload.participantId);
      setNotice(`${participant?.name ?? "A participant"} has a media permission issue.`);
    });

    return () => {
      socket.off("participant:list", handleSnapshot);
      socket.off("lobby:pending", handlePending);
      socket.off("join:approved", handleApproved);
      socket.off("join:rejected");
      socket.off("participant:removed");
      socket.off("lobby:ended");
      socket.off("host:disconnected");
      socket.off("movie:ready", handleMoviePayload);
      socket.off("movie:state", handleMoviePayload);
      socket.off("movie:ended", handleMoviePayload);
      socket.off("movie:unloaded");
      socket.off("movie:screen", handleMovieScreen);
      socket.off("permission:error");
    };
  }, [applySnapshot, clearMovieStream, lobby?.participants, sessionId]);

  useEffect(() => {
    const video = guestMovieRef.current;
    if (!video) return;

    if (remoteMovieStream) {
      video.srcObject = remoteMovieStream;
      void video.play().catch(() => undefined);
      return;
    }

    video.srcObject = null;
  }, [remoteMovieStream]);

  useEffect(() => {
    return () => {
      if (movieUrl) URL.revokeObjectURL(movieUrl);
    };
  }, [movieUrl]);

  useEffect(() => {
    function handleFullscreenChange() {
      if (!isHost || !lobby?.theaterMode || document.fullscreenElement) return;

      socket.emit("movie:screen", { theaterMode: false });
      setLobby((current) => (current ? { ...current, theaterMode: false } : current));
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, [isHost, lobby?.theaterMode]);

  function currentMovieState() {
    const video = hostMovieRef.current;

    return {
      fileName: movieFileName ?? lobby?.movie?.fileName ?? "Selected movie",
      duration: video && Number.isFinite(video.duration) ? video.duration : lobby?.movie?.duration ?? 0,
      isPlaying: video ? !video.paused && !video.ended : lobby?.movie?.isPlaying ?? false,
      currentTime: video ? video.currentTime : lobby?.movie?.currentTime ?? 0,
      playbackRate: video?.playbackRate ?? lobby?.movie?.playbackRate ?? 1
    };
  }

  function emitMovieState(eventName: "movie:ready" | "movie:state" | "movie:ended") {
    const payload = currentMovieState();
    socket.emit(eventName, payload);
    setLobby((current) => mergeMovie(current, payload));
  }

  function handleCreateLobby(event: FormEvent) {
    event.preventDefault();
    const name = hostName.trim();

    if (!name) {
      setFormError("Enter your name.");
      return;
    }

    setFormError(null);
    setNotice("Creating lobby...");

    socket.emit("lobby:create", { name, sessionId }, (ack: CreateLobbyAck) => {
      if (!ack.ok) {
        setNotice(null);
        setFormError(ack.error);
        return;
      }

      applySnapshot(ack.snapshot);
      setNotice("Lobby ready.");
    });
  }

  function handleJoinLobby(event: FormEvent) {
    event.preventDefault();
    const name = guestName.trim();
    const code = joinCode.trim().toUpperCase();

    if (!name || !code) {
      setFormError("Enter your name and lobby code.");
      return;
    }

    setFormError(null);
    setNotice("Sending request...");
    setRole("guest");
    saveActiveSession({ code, name, role: "guest" });

    socket.emit("lobby:join-request", { code, name, sessionId }, (ack: JoinLobbyAck) => {
      if (!ack.ok) {
        clearActiveSession();
        setNotice(null);
        setFormError(ack.error);
        return;
      }

      if (ack.status === "waiting") {
        setView("waiting");
        setNotice("Waiting for host approval.");
        return;
      }

      applySnapshot(ack.snapshot);
      setNotice("Joined lobby.");
    });
  }

  function approveRequest(requestId: string) {
    socket.emit("lobby:approve", { requestId });
  }

  function rejectRequest(requestId: string) {
    socket.emit("lobby:reject", { requestId });
  }

  function updateParticipant(update: Partial<Pick<Participant, "cameraEnabled" | "micEnabled" | "filter">>) {
    socket.emit("participant:update", update);
  }

  function toggleCamera() {
    const next = !cameraEnabled;
    setCameraEnabled(next);
    updateParticipant({ cameraEnabled: next });
  }

  function toggleMic() {
    const next = !micEnabled;
    setMicEnabled(next);
    updateParticipant({ micEnabled: next });
  }

  function changeFilter(filter: FilterId) {
    setSelectedFilter(filter);
    updateParticipant({ filter });
  }

  function removeParticipant(participantId: string) {
    socket.emit("participant:remove", { participantId });
  }

  function leaveLobby() {
    if (isHost) {
      socket.emit("lobby:end");
      setNotice("Lobby ended.");
    } else {
      socket.emit("participant:left");
      setNotice("Left lobby.");
    }

    clearActiveSession();
    setLobby(null);
    setView("home");
    clearMovieStream();
  }

  function handleMovieFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    clearMovieStream();
    setMovieCompatibility(null);
    setMovieFileName(file.name);
    setMovieUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return URL.createObjectURL(file);
    });
  }

  function handleMovieLoaded() {
    const video = hostMovieRef.current;
    if (!video) return;

    const stream = captureVideoElement(video);
    if (!stream) {
      setMovieCompatibility("Movie streaming needs a Chromium browser with captureStream support.");
      return;
    }

    publishMovieStream(stream);
    emitMovieState("movie:ready");
  }

  async function toggleMoviePlayback() {
    const video = hostMovieRef.current;
    if (!video) return;

    if (video.paused) {
      await video.play().catch(() => undefined);
    } else {
      video.pause();
    }

    emitMovieState("movie:state");
  }

  function skipMovie(seconds: number) {
    const video = hostMovieRef.current;
    if (!video) return;

    video.currentTime = Math.min(Math.max(video.currentTime + seconds, 0), Number.isFinite(video.duration) ? video.duration : video.currentTime + seconds);
    emitMovieState("movie:state");
  }

  function changePlaybackRate(rate: number) {
    const video = hostMovieRef.current;
    if (!video) return;

    video.playbackRate = rate;
    emitMovieState("movie:state");
  }

  function seekMovie(time: number) {
    const video = hostMovieRef.current;
    if (!video || !Number.isFinite(time)) return;

    const maxTime = Number.isFinite(video.duration) ? video.duration : time;
    video.currentTime = Math.min(Math.max(time, 0), maxTime);
    emitMovieState("movie:state");
  }

  async function setMovieScreen(theaterMode: boolean) {
    setLobby((current) => (current ? { ...current, theaterMode } : current));
    socket.emit("movie:screen", { theaterMode });

    if (!isHost) return;

    try {
      if (theaterMode) {
        await movieShellRef.current?.requestFullscreen?.();
      } else if (document.fullscreenElement) {
        await document.exitFullscreen();
      }
    } catch {
      setNotice(theaterMode ? "Theater mode synced. Native fullscreen was blocked by the browser." : "Theater mode synced.");
    }
  }

  function unloadMovie() {
    setMovieUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
    setMovieFileName(null);
    setMovieCompatibility(null);
    clearMovieStream();
    socket.emit("movie:unloaded");
    socket.emit("movie:screen", { theaterMode: false });
    setLobby((current) => mergeMovie(current, null));
    if (movieInputRef.current) movieInputRef.current.value = "";
  }

  function handleTimeUpdate() {
    const now = Date.now();
    if (now - lastMovieSyncRef.current < 1_000) return;
    lastMovieSyncRef.current = now;
    emitMovieState("movie:state");
  }

  function copyLobbyCode() {
    if (!lobby?.code) return;
    void navigator.clipboard?.writeText(lobby.code);
    setNotice("Lobby code copied.");
  }

  if (view === "waiting") {
    return (
      <main className="appShell centeredShell">
        <section className="statusPanel">
          <div className="statusIcon">
            <Radio size={34} />
          </div>
          <p className="eyebrow">Lobby {joinCode}</p>
          <h1>Waiting for host approval</h1>
          <p className="statusCopy">{notice ?? "Your request is queued."}</p>
          <button className="secondaryButton" onClick={() => setView("home")} type="button">
            <DoorOpen size={18} />
            Back home
          </button>
        </section>
      </main>
    );
  }

  if (view === "ended") {
    return (
      <main className="appShell centeredShell">
        <section className="statusPanel">
          <div className="statusIcon danger">
            <LogOut size={34} />
          </div>
          <p className="eyebrow">Session closed</p>
          <h1>{notice ?? "Lobby ended"}</h1>
          <button className="primaryButton" onClick={() => setView("home")} type="button">
            <Clapperboard size={18} />
            Start again
          </button>
        </section>
      </main>
    );
  }

  if (view === "lobby" && lobby && self) {
    return (
      <main className={`lobbyShell ${isTheaterMode ? "theaterMode" : ""}`}>
        <header className="lobbyTopbar">
          <div className="brandLockup">
            <div className="brandMark">
              <Film size={22} />
            </div>
            <div>
              <p className="eyebrow">ChillWatch</p>
              <h1>Lobby {lobby.code}</h1>
            </div>
          </div>

          <div className="topbarActions">
            <button className="iconTextButton" type="button" onClick={copyLobbyCode}>
              <Copy size={17} />
              Copy code
            </button>
            <span className={`connectionPill ${connected ? "online" : "offline"}`}>{connected ? "Live" : "Offline"}</span>
            <button className={isHost ? "dangerButton" : "secondaryButton"} type="button" onClick={leaveLobby}>
              {isHost ? <X size={18} /> : <DoorOpen size={18} />}
              {isHost ? "End lobby" : "Leave"}
            </button>
          </div>
        </header>

        {notice && <div className="noticeBar">{notice}</div>}
        {mediaError && <div className="noticeBar warning">{mediaError}</div>}

        <section className="watchGrid">
          <aside className="peopleRail leftRail">
            {leftRail.map((participant) => (
              <ParticipantTile
                key={participant.id}
                participant={participant}
                selfId={sessionId}
                stream={participant.id === sessionId ? localStream : remoteMediaStreams[participant.id]}
                canRemove={isHost && participant.role === "guest"}
                onRemove={removeParticipant}
              />
            ))}
          </aside>

          <section className="movieStage">
            <MoviePanel
              isHost={isHost}
              lobby={lobby}
              movieUrl={movieUrl}
              movieFileName={movieFileName}
              movieCompatibility={movieCompatibility}
              hostMovieRef={hostMovieRef}
              guestMovieRef={guestMovieRef}
              movieInputRef={movieInputRef}
              movieShellRef={movieShellRef}
              hasRemoteMovie={Boolean(remoteMovieStream)}
              isTheaterMode={isTheaterMode}
              onMovieFile={handleMovieFile}
              onLoaded={handleMovieLoaded}
              onPlay={() => emitMovieState("movie:state")}
              onPause={() => emitMovieState("movie:state")}
              onEnded={() => emitMovieState("movie:ended")}
              onTimeUpdate={handleTimeUpdate}
              onTogglePlayback={toggleMoviePlayback}
              onSkip={skipMovie}
              onSeek={seekMovie}
              onRate={changePlaybackRate}
              onScreen={setMovieScreen}
              onUnload={unloadMovie}
            />
          </section>

          <aside className="peopleRail rightRail">
            {rightRail.map((participant) => (
              <ParticipantTile
                key={participant.id}
                participant={participant}
                selfId={sessionId}
                stream={participant.id === sessionId ? localStream : remoteMediaStreams[participant.id]}
                canRemove={isHost && participant.role === "guest"}
                onRemove={removeParticipant}
              />
            ))}
          </aside>
        </section>

        <footer className="controlDock">
          <button className={cameraEnabled ? "controlButton active" : "controlButton"} type="button" onClick={toggleCamera}>
            {cameraEnabled ? <Video size={19} /> : <VideoOff size={19} />}
            Camera
          </button>
          <button className={micEnabled ? "controlButton active" : "controlButton"} type="button" onClick={toggleMic}>
            {micEnabled ? <Mic size={19} /> : <MicOff size={19} />}
            Mic
          </button>

          <div className="filterGroup" aria-label="Camera filter">
            <Settings2 size={18} />
            {filters.map((filter) => (
              <button
                key={filter.id}
                className={selectedFilter === filter.id ? "filterButton selected" : "filterButton"}
                type="button"
                onClick={() => changeFilter(filter.id)}
              >
                {filter.label}
              </button>
            ))}
          </div>

          <div className="dockMeta">
            <Users size={18} />
            {lobby.participants.length}/6
          </div>
        </footer>

        {isHost && lobby.pendingRequests.length > 0 && (
          <section className="approvalDock" aria-label="Join requests">
            <div className="approvalHeader">
              <UserPlus size={19} />
              <span>Join requests</span>
            </div>
            {lobby.pendingRequests.map((request) => (
              <div className="approvalRow" key={request.id}>
                <span>{request.name}</span>
                <div className="approvalActions">
                  <button className="approveButton" type="button" onClick={() => approveRequest(request.id)}>
                    <Check size={17} />
                  </button>
                  <button className="rejectButton" type="button" onClick={() => rejectRequest(request.id)}>
                    <X size={17} />
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}
      </main>
    );
  }

  return (
    <main className="appShell">
      <section className="homeLayout">
        <div className="homeIntro">
          <div className="brandLockup large">
            <div className="brandMark">
              <Clapperboard size={28} />
            </div>
            <div>
              <p className="eyebrow">ChillWatch</p>
              <h1>Watch together in real time</h1>
            </div>
          </div>
          <div className="signalStrip">
            <span className={connected ? "signalDot online" : "signalDot"} />
            <span>{connected ? "Signaling server connected" : "Connecting to signaling server"}</span>
          </div>
        </div>

        <section className="entryGrid">
          <form className="entryPanel" onSubmit={handleCreateLobby}>
            <div className="panelTitle">
              <Plus size={21} />
              <h2>Create lobby</h2>
            </div>
            <label>
              Name
              <input value={hostName} onChange={(event) => setHostName(event.target.value)} placeholder="Host name" maxLength={28} />
            </label>
            <button className="primaryButton" type="submit">
              <MonitorPlay size={18} />
              Create
            </button>
          </form>

          <form className="entryPanel" onSubmit={handleJoinLobby}>
            <div className="panelTitle">
              <UserPlus size={21} />
              <h2>Join lobby</h2>
            </div>
            <label>
              Name
              <input value={guestName} onChange={(event) => setGuestName(event.target.value)} placeholder="Your name" maxLength={28} />
            </label>
            <label>
              Code
              <input value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase())} placeholder="ABC123" maxLength={6} />
            </label>
            <button className="secondaryButton" type="submit">
              <BadgeCheck size={18} />
              Request
            </button>
          </form>
        </section>

        {(formError || notice) && <div className={formError ? "formMessage error" : "formMessage"}>{formError ?? notice}</div>}
      </section>
    </main>
  );
}

function ParticipantTile({
  participant,
  selfId,
  stream,
  canRemove,
  onRemove
}: {
  participant: Participant;
  selfId: string;
  stream?: MediaStream | null;
  canRemove: boolean;
  onRemove: (participantId: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const isSelf = participant.id === selfId;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;

    video.srcObject = stream;
    void video.play().catch(() => undefined);
  }, [stream]);

  return (
    <article className={`participantTile ${participant.connection === "reconnecting" ? "reconnecting" : ""}`}>
      <div className="tileVideoWrap">
        {participant.cameraEnabled && stream ? (
          <video ref={videoRef} className={`tileVideo filter-${participant.filter}`} autoPlay playsInline muted={isSelf} />
        ) : (
          <div className={`avatarFallback filter-${participant.filter}`}>{initials(participant.name)}</div>
        )}
      </div>
      <div className="tileFooter">
        <div>
          <strong>{isSelf ? `${participant.name} (You)` : participant.name}</strong>
          <span>{participant.role === "host" ? "Host" : participant.connection === "online" ? "Guest" : "Rejoining"}</span>
        </div>
        <div className="tileActions">
          {participant.micEnabled ? <Mic size={15} /> : <MicOff size={15} />}
          {participant.cameraEnabled ? <Video size={15} /> : <VideoOff size={15} />}
          {canRemove && (
            <button type="button" className="removeMiniButton" onClick={() => onRemove(participant.id)} title="Remove participant">
              <UserMinus size={15} />
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function MoviePanel({
  isHost,
  lobby,
  movieUrl,
  movieFileName,
  movieCompatibility,
  hostMovieRef,
  guestMovieRef,
  movieInputRef,
  movieShellRef,
  hasRemoteMovie,
  isTheaterMode,
  onMovieFile,
  onLoaded,
  onPlay,
  onPause,
  onEnded,
  onTimeUpdate,
  onTogglePlayback,
  onSkip,
  onSeek,
  onRate,
  onScreen,
  onUnload
}: {
  isHost: boolean;
  lobby: LobbySnapshot;
  movieUrl: string | null;
  movieFileName: string | null;
  movieCompatibility: string | null;
  hostMovieRef: React.MutableRefObject<HTMLVideoElement | null>;
  guestMovieRef: React.MutableRefObject<HTMLVideoElement | null>;
  movieInputRef: React.MutableRefObject<HTMLInputElement | null>;
  movieShellRef: React.MutableRefObject<HTMLDivElement | null>;
  hasRemoteMovie: boolean;
  isTheaterMode: boolean;
  onMovieFile: (event: ChangeEvent<HTMLInputElement>) => void;
  onLoaded: () => void;
  onPlay: () => void;
  onPause: () => void;
  onEnded: () => void;
  onTimeUpdate: () => void;
  onTogglePlayback: () => void;
  onSkip: (seconds: number) => void;
  onSeek: (time: number) => void;
  onRate: (rate: number) => void;
  onScreen: (theaterMode: boolean) => void;
  onUnload: () => void;
}) {
  const movie = lobby.movie;
  const progress = movie && movie.duration > 0 ? Math.min((movie.currentTime / movie.duration) * 100, 100) : 0;
  const seekMax = movie?.duration && Number.isFinite(movie.duration) ? movie.duration : 0;
  const seekValue = movie?.currentTime && Number.isFinite(movie.currentTime) ? movie.currentTime : 0;

  return (
    <div className="moviePanel" ref={movieShellRef}>
      <div className="movieViewport">
        {isHost ? (
          movieUrl ? (
            <video
              ref={hostMovieRef}
              src={movieUrl}
              className="movieVideo"
              playsInline
              onLoadedMetadata={onLoaded}
              onPlay={onPlay}
              onPause={onPause}
              onEnded={onEnded}
              onTimeUpdate={onTimeUpdate}
            />
          ) : (
            <div className="movieEmpty">
              <Film size={50} />
              <span>No movie selected</span>
            </div>
          )
        ) : hasRemoteMovie ? (
          <video ref={guestMovieRef} className="movieVideo" autoPlay playsInline controls={false} />
        ) : (
          <div className="movieEmpty">
            <Radio size={48} />
            <span>{movie?.fileName ? "Connecting to movie stream" : "Waiting for host"}</span>
          </div>
        )}
      </div>

      <div className="movieInfo">
        <div>
          <p className="eyebrow">Now playing</p>
          <h2>{movieFileName ?? movie?.fileName ?? "Host movie stream"}</h2>
        </div>
        <div className="movieBadges">
          {isTheaterMode && <span className="movieState theater">Theater</span>}
          <span className={movie?.isPlaying ? "movieState playing" : "movieState"}>{movie?.isPlaying ? "Playing" : "Paused"}</span>
        </div>
      </div>

      <input
        className="seekBar"
        type="range"
        min="0"
        max={seekMax || 1}
        step="0.1"
        value={Math.min(seekValue, seekMax || seekValue || 0)}
        disabled={!isHost || !movieUrl || seekMax <= 0}
        style={{ "--seek-progress": `${progress}%` } as React.CSSProperties}
        onChange={(event) => onSeek(Number(event.target.value))}
        aria-label="Movie progress"
      />

      <div className="timeRow">
        <span>{formatTime(movie?.currentTime ?? 0)}</span>
        <span>{formatTime(movie?.duration ?? 0)}</span>
      </div>

      {isHost && (
        <div className="movieControls">
          <input ref={movieInputRef} className="hiddenInput" type="file" accept="video/*" onChange={onMovieFile} />
          <button className="iconTextButton" type="button" onClick={() => movieInputRef.current?.click()}>
            <Upload size={17} />
            Select movie
          </button>
          <button className="roundButton" type="button" onClick={() => onSkip(-10)} disabled={!movieUrl}>
            <SkipBack size={18} />
          </button>
          <button className="playButton" type="button" onClick={onTogglePlayback} disabled={!movieUrl}>
            {movie?.isPlaying ? <Pause size={21} /> : <Play size={21} />}
          </button>
          <button className="roundButton" type="button" onClick={() => onSkip(30)} disabled={!movieUrl}>
            <SkipForward size={18} />
          </button>
          <button className="iconTextButton theaterButton" type="button" onClick={() => onScreen(!isTheaterMode)} disabled={!movieUrl}>
            {isTheaterMode ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
            {isTheaterMode ? "Exit theater" : "Theater"}
          </button>
          <label className="compactControl">
            <Gauge size={16} />
            <select value={movie?.playbackRate ?? 1} onChange={(event) => onRate(Number(event.target.value))} disabled={!movieUrl}>
              <option value={0.75}>0.75x</option>
              <option value={1}>1x</option>
              <option value={1.25}>1.25x</option>
              <option value={1.5}>1.5x</option>
            </select>
          </label>
          <label className="compactControl volumeControl">
            <Volume2 size={16} />
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              defaultValue="1"
              disabled={!movieUrl}
              onChange={(event) => {
                if (hostMovieRef.current) hostMovieRef.current.volume = Number(event.target.value);
              }}
            />
          </label>
          <button className="secondaryButton compact" type="button" onClick={onUnload} disabled={!movieUrl}>
            <RotateCcw size={16} />
            Clear
          </button>
        </div>
      )}

      {movieCompatibility && <div className="compatibilityWarning">{movieCompatibility}</div>}
    </div>
  );
}

export default App;
