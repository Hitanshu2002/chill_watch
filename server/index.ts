import express from "express";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server, Socket } from "socket.io";
import type {
  FilterId,
  JoinRequest,
  LobbySnapshot,
  MovieMeta,
  MovieScreenPayload,
  MovieStatePayload,
  Participant,
  Role,
  ServerAck,
  WebRtcSignal
} from "../shared/types.js";

type SocketContext = {
  lobbyCode: string;
  sessionId: string;
  role: Role;
  status: "active" | "waiting";
};

type Lobby = {
  code: string;
  hostId: string;
  hostSocketId: string;
  participants: Map<string, Participant>;
  pendingRequests: Map<string, JoinRequest & { socketId: string }>;
  sockets: Map<string, string>;
  movie: MovieMeta | null;
  theaterMode: boolean;
  createdAt: number;
};

const PORT = Number(process.env.PORT ?? 4000);
const HOST_DISCONNECT_GRACE_MS = 12_000;
const GUEST_DISCONNECT_GRACE_MS = 10_000;
const WAITING_DISCONNECT_GRACE_MS = 5_000;
const MAX_PARTICIPANTS = 6;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*"
  }
});

const lobbies = new Map<string, Lobby>();
const socketContexts = new Map<string, SocketContext>();
const disconnectTimers = new Map<string, NodeJS.Timeout>();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, lobbies: lobbies.size });
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientDist = join(__dirname, "../../dist");

if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => {
    res.sendFile(join(clientDist, "index.html"));
  });
}

function generateLobbyCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  do {
    code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (lobbies.has(code));

  return code;
}

function makeParticipant(id: string, name: string, role: Role): Participant {
  return {
    id,
    name: name.trim(),
    role,
    cameraEnabled: true,
    micEnabled: true,
    filter: "none",
    joinedAt: Date.now(),
    connection: "online"
  };
}

function snapshot(lobby: Lobby): LobbySnapshot {
  return {
    code: lobby.code,
    hostId: lobby.hostId,
    participants: Array.from(lobby.participants.values()).sort((a, b) => {
      if (a.role !== b.role) return a.role === "host" ? -1 : 1;
      return a.joinedAt - b.joinedAt;
    }),
    pendingRequests: Array.from(lobby.pendingRequests.values()).map(({ socketId: _socketId, ...request }) => request),
    movie: lobby.movie,
    theaterMode: lobby.theaterMode
  };
}

function emitSnapshot(lobby: Lobby) {
  io.to(lobby.code).emit("participant:list", snapshot(lobby));
  io.to(lobby.hostSocketId).emit("lobby:pending", snapshot(lobby).pendingRequests);
}

function timerKey(lobbyCode: string, sessionId: string) {
  return `${lobbyCode}:${sessionId}`;
}

function clearDisconnectTimer(lobbyCode: string, sessionId: string) {
  const key = timerKey(lobbyCode, sessionId);
  const timer = disconnectTimers.get(key);

  if (timer) {
    clearTimeout(timer);
    disconnectTimers.delete(key);
  }
}

function getLobbyFromSocket(socket: Socket) {
  const context = socketContexts.get(socket.id);
  if (!context) return null;
  const lobby = lobbies.get(context.lobbyCode);
  if (!lobby) return null;
  return { lobby, context };
}

function isHost(socket: Socket, lobby: Lobby) {
  const context = socketContexts.get(socket.id);
  return Boolean(context && context.status === "active" && context.sessionId === lobby.hostId);
}

function endLobby(lobby: Lobby, reason: "host-ended" | "host-disconnected") {
  lobbies.delete(lobby.code);

  for (const [sessionId] of lobby.participants) {
    clearDisconnectTimer(lobby.code, sessionId);
  }

  for (const [sessionId, socketId] of lobby.sockets) {
    socketContexts.delete(socketId);
    const socket = io.sockets.sockets.get(socketId);
    socket?.leave(lobby.code);
    socket?.emit("lobby:ended", { reason, code: lobby.code });
    lobby.sockets.delete(sessionId);
  }

  io.to(lobby.code).emit("lobby:ended", { reason, code: lobby.code });
}

function removeParticipant(lobby: Lobby, participantId: string, reason: "left" | "removed" | "disconnected") {
  const participant = lobby.participants.get(participantId);
  if (!participant) return;

  if (participant.role === "host") {
    endLobby(lobby, reason === "left" ? "host-ended" : "host-disconnected");
    return;
  }

  lobby.participants.delete(participantId);
  clearDisconnectTimer(lobby.code, participantId);

  const socketId = lobby.sockets.get(participantId);
  if (socketId) {
    const socket = io.sockets.sockets.get(socketId);
    socket?.leave(lobby.code);
    socket?.emit(reason === "removed" ? "participant:removed" : "participant:left", {
      participantId,
      code: lobby.code
    });
    socketContexts.delete(socketId);
  }

  lobby.sockets.delete(participantId);
  io.to(lobby.code).emit("participant:left", { participantId, code: lobby.code, reason });
  emitSnapshot(lobby);
}

function sendAck<T>(callback: unknown, response: ServerAck<T>) {
  if (typeof callback === "function") {
    (callback as (response: ServerAck<T>) => void)(response);
  }
}

function relayWebRtc(socket: Socket, event: "webrtc:offer" | "webrtc:answer" | "webrtc:ice-candidate", payload: WebRtcSignal) {
  const active = getLobbyFromSocket(socket);
  if (!active) return;

  const { lobby, context } = active;
  const targetSocketId = lobby.sockets.get(payload.to);
  if (!targetSocketId) return;

  io.to(targetSocketId).emit(event, {
    ...payload,
    from: context.sessionId
  });
}

io.on("connection", (socket) => {
  socket.on("lobby:create", (payload: { name: string; sessionId: string }, callback) => {
    const name = payload.name?.trim();
    const sessionId = payload.sessionId?.trim();

    if (!name || !sessionId) {
      sendAck(callback, { ok: false, error: "Name and session are required." });
      return;
    }

    const code = generateLobbyCode();
    const host = makeParticipant(sessionId, name, "host");
    const lobby: Lobby = {
      code,
      hostId: sessionId,
      hostSocketId: socket.id,
      participants: new Map([[sessionId, host]]),
      pendingRequests: new Map(),
      sockets: new Map([[sessionId, socket.id]]),
      movie: null,
      theaterMode: false,
      createdAt: Date.now()
    };

    lobbies.set(code, lobby);
    socketContexts.set(socket.id, { lobbyCode: code, sessionId, role: "host", status: "active" });
    socket.join(code);

    sendAck(callback, { ok: true, snapshot: snapshot(lobby), participant: host });
    emitSnapshot(lobby);
  });

  socket.on("lobby:join-request", (payload: { code: string; name: string; sessionId: string }, callback) => {
    const code = payload.code?.trim().toUpperCase();
    const name = payload.name?.trim();
    const sessionId = payload.sessionId?.trim();
    const lobby = lobbies.get(code);

    if (!lobby) {
      sendAck(callback, { ok: false, error: "Lobby not found." });
      socket.emit("lobby:not-found", { code });
      return;
    }

    if (!name || !sessionId) {
      sendAck(callback, { ok: false, error: "Name and lobby code are required." });
      return;
    }

    if (lobby.participants.has(sessionId)) {
      const participant = lobby.participants.get(sessionId)!;
      participant.connection = "online";
      lobby.sockets.set(sessionId, socket.id);
      socketContexts.set(socket.id, { lobbyCode: code, sessionId, role: participant.role, status: "active" });
      socket.join(code);
      clearDisconnectTimer(code, sessionId);
      sendAck(callback, { ok: true, status: "approved", snapshot: snapshot(lobby), participant });
      emitSnapshot(lobby);
      return;
    }

    if (lobby.participants.size >= MAX_PARTICIPANTS) {
      sendAck(callback, { ok: false, error: "Lobby is full." });
      return;
    }

    const existingRequest = Array.from(lobby.pendingRequests.values()).find((request) => request.sessionId === sessionId);
    if (existingRequest) {
      existingRequest.name = name;
      existingRequest.socketId = socket.id;
      socketContexts.set(socket.id, { lobbyCode: code, sessionId, role: "guest", status: "waiting" });
      sendAck(callback, { ok: true, status: "waiting", requestId: existingRequest.id });
      io.to(lobby.hostSocketId).emit("lobby:pending", snapshot(lobby).pendingRequests);
      return;
    }

    const request: JoinRequest & { socketId: string } = {
      id: crypto.randomUUID(),
      sessionId,
      name,
      socketId: socket.id,
      requestedAt: Date.now()
    };

    lobby.pendingRequests.set(request.id, request);
    socketContexts.set(socket.id, { lobbyCode: code, sessionId, role: "guest", status: "waiting" });

    sendAck(callback, { ok: true, status: "waiting", requestId: request.id });
    io.to(lobby.hostSocketId).emit("lobby:pending", snapshot(lobby).pendingRequests);
  });

  socket.on("lobby:resume", (payload: { code: string; sessionId: string }, callback) => {
    const code = payload.code?.trim().toUpperCase();
    const sessionId = payload.sessionId?.trim();
    const lobby = lobbies.get(code);

    if (!lobby || !sessionId) {
      sendAck(callback, { ok: false, error: "Lobby is no longer active." });
      return;
    }

    const participant = lobby.participants.get(sessionId);
    if (participant) {
      participant.connection = "online";
      lobby.sockets.set(sessionId, socket.id);
      if (participant.role === "host") {
        lobby.hostSocketId = socket.id;
      }
      clearDisconnectTimer(code, sessionId);
      socketContexts.set(socket.id, { lobbyCode: code, sessionId, role: participant.role, status: "active" });
      socket.join(code);
      sendAck(callback, { ok: true, status: "approved", snapshot: snapshot(lobby), participant });
      emitSnapshot(lobby);
      return;
    }

    const pendingRequest = Array.from(lobby.pendingRequests.values()).find((request) => request.sessionId === sessionId);
    if (pendingRequest) {
      pendingRequest.socketId = socket.id;
      socketContexts.set(socket.id, { lobbyCode: code, sessionId, role: "guest", status: "waiting" });
      sendAck(callback, { ok: true, status: "waiting", requestId: pendingRequest.id });
      io.to(lobby.hostSocketId).emit("lobby:pending", snapshot(lobby).pendingRequests);
      return;
    }

    sendAck(callback, { ok: false, error: "Your session is not part of this lobby." });
  });

  socket.on("lobby:approve", (payload: { requestId: string }) => {
    const active = getLobbyFromSocket(socket);
    if (!active || !isHost(socket, active.lobby)) return;

    const { lobby } = active;
    const request = lobby.pendingRequests.get(payload.requestId);
    if (!request || lobby.participants.size >= MAX_PARTICIPANTS) return;

    const participant = makeParticipant(request.sessionId, request.name, "guest");
    lobby.pendingRequests.delete(request.id);
    lobby.participants.set(participant.id, participant);
    lobby.sockets.set(participant.id, request.socketId);
    socketContexts.set(request.socketId, {
      lobbyCode: lobby.code,
      sessionId: participant.id,
      role: "guest",
      status: "active"
    });

    const guestSocket = io.sockets.sockets.get(request.socketId);
    guestSocket?.join(lobby.code);
    guestSocket?.emit("join:approved", { snapshot: snapshot(lobby), participant });

    io.to(lobby.code).emit("participant:joined", { participant, code: lobby.code });
    emitSnapshot(lobby);
  });

  socket.on("lobby:reject", (payload: { requestId: string }) => {
    const active = getLobbyFromSocket(socket);
    if (!active || !isHost(socket, active.lobby)) return;

    const { lobby } = active;
    const request = lobby.pendingRequests.get(payload.requestId);
    if (!request) return;

    lobby.pendingRequests.delete(request.id);
    io.to(request.socketId).emit("join:rejected", { code: lobby.code });
    socketContexts.delete(request.socketId);
    emitSnapshot(lobby);
  });

  socket.on("participant:update", (payload: { cameraEnabled?: boolean; micEnabled?: boolean; filter?: FilterId }) => {
    const active = getLobbyFromSocket(socket);
    if (!active) return;

    const participant = active.lobby.participants.get(active.context.sessionId);
    if (!participant) return;

    if (typeof payload.cameraEnabled === "boolean") participant.cameraEnabled = payload.cameraEnabled;
    if (typeof payload.micEnabled === "boolean") participant.micEnabled = payload.micEnabled;
    if (payload.filter) participant.filter = payload.filter;

    io.to(active.lobby.code).emit("participant:updated", { participant });
    emitSnapshot(active.lobby);
  });

  socket.on("participant:mute", (payload: { participantId: string; muted: boolean }) => {
    const active = getLobbyFromSocket(socket);
    if (!active || !isHost(socket, active.lobby)) return;

    const { lobby } = active;
    const participant = lobby.participants.get(payload.participantId);
    if (!participant) return;

    participant.micEnabled = !payload.muted;
    io.to(lobby.code).emit("participant:updated", { participant });

    const guestSocketId = lobby.sockets.get(payload.participantId);
    if (guestSocketId) {
      io.to(guestSocketId).emit("participant:muted-by-host", { muted: payload.muted });
    }

    emitSnapshot(lobby);
  });

  socket.on("participant:remove", (payload: { participantId: string }) => {
    const active = getLobbyFromSocket(socket);
    if (!active || !isHost(socket, active.lobby)) return;
    removeParticipant(active.lobby, payload.participantId, "removed");
  });

  socket.on("participant:left", () => {
    const active = getLobbyFromSocket(socket);
    if (!active) return;
    removeParticipant(active.lobby, active.context.sessionId, "left");
  });

  socket.on("lobby:end", () => {
    const active = getLobbyFromSocket(socket);
    if (!active || !isHost(socket, active.lobby)) return;
    endLobby(active.lobby, "host-ended");
  });

  socket.on("webrtc:offer", (payload: WebRtcSignal) => relayWebRtc(socket, "webrtc:offer", payload));
  socket.on("webrtc:answer", (payload: WebRtcSignal) => relayWebRtc(socket, "webrtc:answer", payload));
  socket.on("webrtc:ice-candidate", (payload: WebRtcSignal) => relayWebRtc(socket, "webrtc:ice-candidate", payload));

  socket.on("movie:ready", (payload: MovieStatePayload) => {
    const active = getLobbyFromSocket(socket);
    if (!active || !isHost(socket, active.lobby)) return;
    active.lobby.movie = payload;
    socket.to(active.lobby.code).emit("movie:ready", payload);
    emitSnapshot(active.lobby);
  });

  socket.on("movie:state", (payload: MovieStatePayload) => {
    const active = getLobbyFromSocket(socket);
    if (!active || !isHost(socket, active.lobby)) return;
    active.lobby.movie = payload;
    socket.to(active.lobby.code).emit("movie:state", payload);
    emitSnapshot(active.lobby);
  });

  socket.on("movie:ended", (payload: MovieStatePayload) => {
    const active = getLobbyFromSocket(socket);
    if (!active || !isHost(socket, active.lobby)) return;
    active.lobby.movie = { ...payload, isPlaying: false };
    socket.to(active.lobby.code).emit("movie:ended", active.lobby.movie);
    emitSnapshot(active.lobby);
  });

  socket.on("movie:unloaded", () => {
    const active = getLobbyFromSocket(socket);
    if (!active || !isHost(socket, active.lobby)) return;
    active.lobby.movie = null;
    active.lobby.theaterMode = false;
    socket.to(active.lobby.code).emit("movie:unloaded");
    emitSnapshot(active.lobby);
  });

  socket.on("movie:screen", (payload: MovieScreenPayload) => {
    const active = getLobbyFromSocket(socket);
    if (!active || !isHost(socket, active.lobby)) return;

    active.lobby.theaterMode = Boolean(payload.theaterMode);
    io.to(active.lobby.code).emit("movie:screen", { theaterMode: active.lobby.theaterMode });
    emitSnapshot(active.lobby);
  });

  socket.on("permission:error", (payload: { message: string }) => {
    const active = getLobbyFromSocket(socket);
    if (!active) return;
    socket.to(active.lobby.code).emit("permission:error", {
      participantId: active.context.sessionId,
      message: payload.message
    });
  });

  socket.on("disconnect", () => {
    const context = socketContexts.get(socket.id);
    if (!context) return;

    socketContexts.delete(socket.id);
    const lobby = lobbies.get(context.lobbyCode);
    if (!lobby) return;

    if (context.status === "waiting") {
      const timer = setTimeout(() => {
        for (const [requestId, request] of lobby.pendingRequests) {
          if (request.sessionId === context.sessionId) {
            lobby.pendingRequests.delete(requestId);
          }
        }
        io.to(lobby.hostSocketId).emit("lobby:pending", snapshot(lobby).pendingRequests);
      }, WAITING_DISCONNECT_GRACE_MS);
      disconnectTimers.set(timerKey(context.lobbyCode, context.sessionId), timer);
      return;
    }

    const participant = lobby.participants.get(context.sessionId);
    if (!participant) return;

    participant.connection = "reconnecting";
    emitSnapshot(lobby);

    const grace = participant.role === "host" ? HOST_DISCONNECT_GRACE_MS : GUEST_DISCONNECT_GRACE_MS;
    const timer = setTimeout(() => {
      const activeLobby = lobbies.get(context.lobbyCode);
      if (!activeLobby) return;
      const activeParticipant = activeLobby.participants.get(context.sessionId);
      if (!activeParticipant || activeParticipant.connection === "online") return;

      if (activeParticipant.role === "host") {
        io.to(activeLobby.code).emit("host:disconnected", { code: activeLobby.code });
        endLobby(activeLobby, "host-disconnected");
      } else {
        removeParticipant(activeLobby, context.sessionId, "disconnected");
      }
    }, grace);

    disconnectTimers.set(timerKey(context.lobbyCode, context.sessionId), timer);
  });
});

httpServer.listen(PORT, () => {
  console.log(`ChillWatch signaling server listening on http://localhost:${PORT}`);
});
