export type Platform = 'reddit' | 'wykop' | 'x';
export type ContentType = 'image' | 'gif' | 'video';
export type MatchClass = 'exact' | 'near' | 'different';
export type PostKey = string;
export type SourceKey = string;
export type RecordId = string;

export type GrayImage = { width: number; height: number; data: Uint8Array };
export type GrayFrame = { tS: number; image: GrayImage };

export type ImageFingerprint = { kind: 'image'; hash: Uint32Array; crops: Uint32Array; edges: Uint32Array };
export type FrameSequenceFingerprint = { kind: 'sequence'; frames: Uint32Array; timestamps: Float32Array; durationS: number };
export type PosterFingerprint = { kind: 'poster'; hash: Uint32Array };
export type Fingerprint = ImageFingerprint | FrameSequenceFingerprint | PosterFingerprint;

export type Thresholds = { exact: number; near: number };
export type Comparison = { matchClass: MatchClass; similarity: number };

export type FrameSource = {
  readonly durationS: number;
  frameAt(tS: number): Promise<GrayImage | null>;
  dispose(): void;
};

export type DecodeRequest = { url: string; contentType: ContentType; posterUrl: string | null };
export type SkipReason = 'flat' | 'unreadable' | 'no-poster' | 'fetch-failed' | 'host-not-allowed';
export type DecodeResult = { status: 'ok'; contentType: ContentType; fingerprint: Fingerprint } | { status: 'skipped'; reason: SkipReason };

export type SeenMatch = {
  recordId: RecordId;
  matchClass: Exclude<MatchClass, 'different'>;
  platform: Platform;
  firstSeenPostKey: PostKey;
  firstSeenPermalink: string;
  firstSeenAt: number;
};

export type Sighting = {
  fingerprint: Fingerprint;
  contentType: ContentType;
  platform: Platform;
  postKey: PostKey;
  permalink: string;
};

export type RetentionDays = 7 | 30 | 90 | null;
export type Settings = {
  enabled: boolean;
  mode: 'exact' | 'exact-near';
  exactThreshold: number;
  nearThreshold: number;
  retentionDays: RetentionDays;
  platforms: Record<Platform, boolean>;
  contentTypes: Record<ContentType, boolean>;
  toast: boolean;
};

export type WhitelistEntry = { type: 'post' | 'source'; key: string };
export type CounterValues = { duplicatesHidden: number; uniqueItems: number };

export type StorageItems = Record<string, unknown>;
export type KeyValueStorage = { get(keys: string): Promise<StorageItems>; set(items: StorageItems): Promise<void> };
export type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>;
export type StorageChangedEvent = { addListener(listener: (changes: StorageChanges, areaName: string) => void): void };
export type AlarmScheduler = {
  create(name: string, info: { periodInMinutes: number }): Promise<void>;
  onAlarm: { addListener(listener: (alarm: { name: string }) => void): void };
};
export type SetTimer = (fn: () => void, ms: number) => unknown;
