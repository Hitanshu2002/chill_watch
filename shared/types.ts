export type Role = "host" | "guest";

export type FilterId = "none" | "warm" | "noir" | "soft" | "cinema";

export type Participant = {
  id: string;
  name: string;
  role: Role;
  cameraEnabled: boolean;
  micEnabled: boolean;
  filter: FilterId;
  joinedAt: number;
  connection: "online" | "reconnecting";
};

export type JoinRequest = {
  id: string;
  sessionId: string;
  name: string;
  requestedAt: number;
};

export type MovieMeta = {
  fileName: string;
  duration: number;
  isPlaying: boolean;
  currentTime: number;
  playbackRate: number;
};

export type LobbySnapshot = {
  code: string;
  hostId: string;
  participants: Participant[];
  pendingRequests: JoinRequest[];
  movie: MovieMeta | null;
  theaterMode: boolean;
  isPublic?: boolean;
};

export type ServerAck<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

export type WebRtcChannel = "media" | "movie";

export type RtcSessionDescriptionPayload = {
  type: "offer" | "answer" | "pranswer" | "rollback";
  sdp?: string;
};

export type RtcIceCandidatePayload = {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
};

export type WebRtcSignal = {
  from: string;
  to: string;
  channel: WebRtcChannel;
  description?: RtcSessionDescriptionPayload;
  candidate?: RtcIceCandidatePayload;
};

export type MovieStatePayload = {
  fileName: string;
  duration: number;
  isPlaying: boolean;
  currentTime: number;
  playbackRate: number;
};

export type MovieScreenPayload = {
  theaterMode: boolean;
};

export type PublicLobbyInfo = {
  code: string;
  hostName: string;
  movieFileName: string | null;
  activeCount: number;
};
