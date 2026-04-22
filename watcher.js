const chokidar = require("chokidar");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const FormData = require("form-data");

const SUPPORTED_REPLAY_EXTENSIONS = [".aoe2record", ".aoe2mpgame"];
const IMPORT_STABILITY_CHECK_MS = 1200;
const IMPORT_ITEM_LIMIT = 75;
const DEFAULT_API_BASE_URL = "https://api-prodn.aoe2dewarwagers.com";
const DEFAULT_API_FALLBACK_BASE_URL = "https://aoe2dewarwagers.com";
const WATCHER_METADATA_SCHEMA = "aoe2dewarwagers.watcher_final_metadata.v2";
const WATCHER_METADATA_VERSION = 2;
const MAX_METADATA_SIDECAR_BYTES = 256 * 1024;
const MAX_DE_LOG_BYTES = 2 * 1024 * 1024;
const MAX_CANDIDATE_LOBBY_IDS = 12;
const DE_LOBBY_TIME_WINDOW_MS = 6 * 60 * 60 * 1000;
const DE_PROFILE_ROOT_SEGMENTS = ["Games", "Age of Empires 2 DE"];
const DE_LOCAL_PROFILE_ROOT_SEGMENTS = ["AppData", "Local", "Games", "Age of Empires 2 DE"];
const DE_SAVEGAME_DIR_NAMES = ["savegame", "SaveGame"];

let activeWatcher = null;
let activeUploadState = new Map();
let activePreferredUploadTargetBaseUrl = null;
let activeLogger = defaultLogger;
let activeEventHook = () => {};

function defaultLogger(message, level = "info") {
  const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
  console[method](message);
}

function setRuntimeHooks(hooks = {}) {
  if (typeof hooks.onLog === "function") {
    activeLogger = hooks.onLog;
  }

  if (typeof hooks.onEvent === "function") {
    activeEventHook = hooks.onEvent;
  }
}

function log(message, level = "info") {
  activeLogger(message, level);
}

function emitRuntimeEvent(type, payload = {}) {
  try {
    activeEventHook({
      type,
      occurredAt: new Date().toISOString(),
      ...payload,
    });
  } catch (error) {
    defaultLogger(`Failed to emit watcher runtime event "${type}": ${error.message}`, "warn");
  }
}

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function listDirectoryPaths(parent) {
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(parent, entry.name));
  } catch {
    return [];
  }
}

function dedupePaths(paths) {
  return [...new Set(paths.filter(Boolean))];
}

function prioritizePaths(paths, preferredPaths) {
  const normalizedPreferred = preferredPaths.filter(Boolean);
  const remaining = paths.filter((candidate) => !normalizedPreferred.includes(candidate));
  return dedupePaths([...normalizedPreferred, ...remaining]);
}

function getSaveGameDirsFromProfileRoot(profileRoot) {
  return listDirectoryPaths(profileRoot).flatMap((profileDir) =>
    DE_SAVEGAME_DIR_NAMES.map((dirName) => path.join(profileDir, dirName)).filter(isDirectory)
  );
}

function getWindowsProfileRootsForDrive(driveRoot) {
  const usersDir = path.join(driveRoot, "users");
  const existingUsers = listDirectoryPaths(usersDir);
  const preferredUsers = [
    path.join(usersDir, "crossover"),
    path.join(usersDir, "steamuser"),
    path.join(usersDir, os.userInfo().username),
  ];

  return prioritizePaths(existingUsers, preferredUsers)
    .filter(isDirectory)
    .flatMap((userDir) => [
      path.join(userDir, ...DE_PROFILE_ROOT_SEGMENTS),
      path.join(userDir, ...DE_LOCAL_PROFILE_ROOT_SEGMENTS),
    ]);
}

function getCrossOverDriveRoots(home) {
  const bottlesRoot = path.join(home, "Library", "Application Support", "CrossOver", "Bottles");
  const existingBottleDrives = listDirectoryPaths(bottlesRoot)
    .map((bottleDir) => path.join(bottleDir, "drive_c"))
    .filter(isDirectory);

  return prioritizePaths(existingBottleDrives, [path.join(bottlesRoot, "Steam", "drive_c")]);
}

function getProtonDriveRoots(home) {
  return [
    path.join(home, ".steam", "steam", "steamapps", "compatdata", "813780", "pfx", "drive_c"),
    path.join(home, ".local", "share", "Steam", "steamapps", "compatdata", "813780", "pfx", "drive_c"),
    path.join(
      home,
      ".var",
      "app",
      "com.valvesoftware.Steam",
      ".local",
      "share",
      "Steam",
      "steamapps",
      "compatdata",
      "813780",
      "pfx",
      "drive_c"
    ),
  ].filter(isDirectory);
}

function pickBestExistingDir(paths) {
  const existing = dedupePaths(paths).filter(isDirectory);
  if (existing.length === 0) {
    return null;
  }

  return existing
    .map((candidate) => ({
      candidate,
      mtimeMs: fs.statSync(candidate).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.candidate.localeCompare(b.candidate))[0].candidate;
}

function getDefaultReplayDir({ home = os.homedir(), platform = os.platform() } = {}) {
  const nativeProfileRoots = [
    path.join(home, ...DE_PROFILE_ROOT_SEGMENTS),
    path.join(home, ...DE_LOCAL_PROFILE_ROOT_SEGMENTS),
  ];
  let profileRoots = [];

  if (platform === "darwin") {
    profileRoots = [
      ...getCrossOverDriveRoots(home).flatMap(getWindowsProfileRootsForDrive),
      ...nativeProfileRoots,
    ];
  } else if (platform === "win32") {
    profileRoots = nativeProfileRoots;
  } else {
    profileRoots = [
      ...getProtonDriveRoots(home).flatMap(getWindowsProfileRootsForDrive),
      ...nativeProfileRoots,
    ];
  }

  return pickBestExistingDir(dedupePaths(profileRoots).flatMap(getSaveGameDirsFromProfileRoot));
}

function normalizeBaseUrl(value) {
  return (value || "").trim().replace(/\/$/, "");
}

function buildRuntimeConfig(config = {}) {
  const apiBaseUrl = normalizeBaseUrl(
    config.apiBaseUrl || process.env.AOE2_API_BASE_URL || DEFAULT_API_BASE_URL
  );

  const defaultFallbackApiBaseUrl =
    apiBaseUrl === DEFAULT_API_BASE_URL ? DEFAULT_API_FALLBACK_BASE_URL : "";

  const apiFallbackBaseUrl = normalizeBaseUrl(
    config.apiFallbackBaseUrl ||
      process.env.AOE2_API_FALLBACK_BASE_URL ||
      defaultFallbackApiBaseUrl
  );

  const uploadTargets = Array.from(
    new Map(
      [apiBaseUrl, apiFallbackBaseUrl]
        .filter(Boolean)
        .map((baseUrl) => [
          baseUrl,
          {
            baseUrl,
            uploadUrl: `${baseUrl}/api/replay/upload`,
          },
        ])
    ).values()
  );

  return {
    watchDir: config.watchDir || process.env.AOE2_WATCH_DIR || getDefaultReplayDir(),
    uploadApiKey: (config.uploadApiKey || process.env.AOE2_UPLOAD_API_KEY || "").trim(),
    uploadTargets,
    watchExtensions: new Set(SUPPORTED_REPLAY_EXTENSIONS),
    maxUploadRetries: Number(process.env.AOE2_UPLOAD_RETRY_ATTEMPTS || 4),
    retryBaseDelayMs: Number(process.env.AOE2_UPLOAD_RETRY_BASE_DELAY_MS || 4000),
    retryPollMs: Number(process.env.AOE2_UPLOAD_RETRY_POLL_MS || 1000),
    stableCheckIntervalMs: Number(process.env.AOE2_UPLOAD_STABLE_CHECK_INTERVAL_MS || 3000),
    quietPeriodMs: Number(process.env.AOE2_UPLOAD_QUIET_PERIOD_MS || 30000),
    initialLiveDelayMs: Number(process.env.AOE2_INITIAL_LIVE_DELAY_MS || 3000),
    initialLiveRetryCooldownMs: Number(
      process.env.AOE2_INITIAL_LIVE_RETRY_COOLDOWN_MS || 10000
    ),
    liveUploadCooldownMs: Number(process.env.AOE2_LIVE_UPLOAD_COOLDOWN_MS || 45000),
    finalSettleWindowMs: Number(process.env.AOE2_FINAL_SETTLE_WINDOW_MS || 90000),
    firstBytesTimeoutMs: Number(process.env.AOE2_FIRST_BYTES_TIMEOUT_MS || 30000),
    firstBytesPollMs: Number(process.env.AOE2_FIRST_BYTES_POLL_MS || 1000),
    replayProgressLogIntervalMs: Number(
      process.env.AOE2_REPLAY_PROGRESS_LOG_INTERVAL_MS || 180000
    ),
    minReplayBytes: Number(process.env.AOE2_MIN_REPLAY_BYTES || 1),
    watcherUid:
      process.env.WATCHER_USER_UID ||
      `watcher-${crypto
        .createHash("sha1")
        .update(os.hostname())
        .digest("hex")
        .slice(0, 12)}`,
  };
}

function getRuntimeValidationError(runtimeConfig) {
  if (!runtimeConfig.watchDir || !fs.existsSync(runtimeConfig.watchDir)) {
    return `Replay directory does not exist: ${runtimeConfig.watchDir || "(empty)"}`;
  }

  if (!runtimeConfig.uploadApiKey) {
    return "Watcher key is missing. Paste it in Watcher settings before starting.";
  }

  return null;
}

function getUploadTargetsForAttempt(runtimeConfig) {
  const preferred = runtimeConfig.uploadTargets.find(
    (target) => target.baseUrl === activePreferredUploadTargetBaseUrl
  );
  const remaining = runtimeConfig.uploadTargets.filter(
    (target) => target.baseUrl !== activePreferredUploadTargetBaseUrl
  );

  return preferred ? [preferred, ...remaining] : [...runtimeConfig.uploadTargets];
}

function rememberWorkingUploadTarget(target) {
  if (target?.baseUrl) {
    activePreferredUploadTargetBaseUrl = target.baseUrl;
  }
}

function getRetryDelayMsFactory(runtimeConfig, attempt) {
  return Math.min(
    runtimeConfig.retryBaseDelayMs * Math.max(1, 2 ** Math.max(0, attempt - 1)),
    30000
  );
}

async function getFileFingerprint(filePath) {
  const stats = await fs.promises.stat(filePath);
  return `${stats.size}:${Math.floor(stats.mtimeMs)}`;
}

async function getReplayContentHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function stableHash(value, length = 24) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, length);
}

function cleanString(value, maxLength = 255) {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function toIso(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function parseReplayTimestampFromFilename(fileName) {
  const match = String(fileName || "").match(
    /@(\d{4})[.-](\d{2})[.-](\d{2})[ T_-]?(\d{2})(\d{2})(\d{2})?/
  );
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second = "00"] = match;
  return toIso(
    new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    )
  );
}

function parseReplayVersionFromFilename(fileName) {
  const match = String(fileName || "").match(/\bv(\d+(?:\.\d+){2,4})\b/i);
  return match ? match[1] : null;
}

function splitResolvedPath(filePath) {
  const resolved = path.resolve(filePath);
  const root = path.parse(resolved).root;
  return {
    root,
    parts: resolved.slice(root.length).split(path.sep).filter(Boolean),
  };
}

function resolveDeProfileContext(filePath) {
  const { root, parts } = splitResolvedPath(filePath);
  const gamesIndex = parts.findIndex(
    (part, index) =>
      part === "Games" &&
      parts[index + 1] === "Age of Empires 2 DE" &&
      parts[index + 2] &&
      DE_SAVEGAME_DIR_NAMES.includes(parts[index + 3])
  );

  if (gamesIndex < 0) {
    return null;
  }

  const deRoot = path.join(root, ...parts.slice(0, gamesIndex + 2));
  const profileId = cleanString(parts[gamesIndex + 2], 80);
  const savegameDir = path.join(root, ...parts.slice(0, gamesIndex + 4));
  const driveIndex = parts.lastIndexOf("drive_c");
  const driveRoot = driveIndex >= 0 ? path.join(root, ...parts.slice(0, driveIndex + 1)) : null;

  return {
    deRoot,
    driveRoot,
    profileId,
    savegameDir,
    logsDir: path.join(deRoot, "logs"),
    telemetryDir: path.join(deRoot, "telemetry"),
  };
}

async function readTextFileIfSmall(filePath, maxBytes = MAX_DE_LOG_BYTES) {
  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile() || stats.size > maxBytes) {
      return null;
    }
    return await fs.promises.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function parseAge2SessionData(raw) {
  if (!raw) {
    return null;
  }

  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([^=]+?)\s*=\s*(.*?)\s*$/);
    if (!match) {
      continue;
    }
    values[match[1].trim()] = match[2].trim();
  }

  const versionRaw = cleanString(values.Version, 120);
  const versionMatch = versionRaw.match(/^([0-9.]+)(?:\s+#\(([^)]+)\))?/);
  const playerSessionId = cleanString(values.PlayerSessionID, 120);
  const config = cleanString(values.Config, 80);
  const stream = cleanString(values.Stream, 120);

  if (!versionRaw && !playerSessionId && !config && !stream) {
    return null;
  }

  return {
    gameVersion: versionMatch
      ? {
          value: versionMatch[1],
          build: cleanString(versionMatch[2], 40) || null,
          source: "Age2SessionData.txt",
        }
      : versionRaw
        ? {
            value: versionRaw,
            build: null,
            source: "Age2SessionData.txt",
          }
        : null,
    playerSessionId: playerSessionId || null,
    config: config || null,
    stream: stream || null,
  };
}

async function readAge2SessionData(context) {
  if (!context?.logsDir) {
    return null;
  }

  return parseAge2SessionData(
    await readTextFileIfSmall(path.join(context.logsDir, "Age2SessionData.txt"), 64 * 1024)
  );
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseSteamPersonaName(raw, steam64Id) {
  if (!raw || !steam64Id) {
    return null;
  }

  const blockMatch = raw.match(new RegExp(`"${escapeRegExp(steam64Id)}"\\s*\\{([\\s\\S]*?)\\n\\s*\\}`));
  const block = blockMatch?.[1] || "";
  const personaMatch = block.match(/"PersonaName"\s*"([^"]+)"/);
  return cleanString(personaMatch?.[1], 120) || null;
}

function getSteamConfigCandidates(context) {
  if (!context?.driveRoot) {
    return [];
  }

  return [
    path.join(context.driveRoot, "Program Files (x86)", "Steam", "config", "loginusers.vdf"),
    path.join(context.driveRoot, "Program Files", "Steam", "config", "loginusers.vdf"),
    path.join(context.driveRoot, "Steam", "config", "loginusers.vdf"),
  ];
}

async function readLocalPlayerIdentity(context) {
  const steam64 = /^\d{10,20}$/.test(context?.profileId || "") ? context.profileId : null;
  if (!steam64) {
    return null;
  }

  for (const candidate of getSteamConfigCandidates(context)) {
    const raw = await readTextFileIfSmall(candidate, 512 * 1024);
    const personaName = parseSteamPersonaName(raw, steam64);
    if (personaName) {
      return {
        steam64,
        persona_name: personaName,
        source: "steam_loginusers",
      };
    }
  }

  return {
    steam64,
    source: "savegame_path",
  };
}

function parseDeLogTimestamp(line) {
  const match = String(line || "").match(
    /(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\s+\(UTC\)/
  );
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second, millisecond = "0"] = match;
  return toIso(
    new Date(
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        Number(millisecond.padEnd(3, "0"))
      )
    )
  );
}

function isWithinLobbyCandidateWindow(observedAt, startedAt, endedAt) {
  if (!observedAt || (!startedAt && !endedAt)) {
    return true;
  }

  const observedMs = new Date(observedAt).getTime();
  const startMs = startedAt ? new Date(startedAt).getTime() : observedMs;
  const endMs = endedAt ? new Date(endedAt).getTime() : startMs;
  if ([observedMs, startMs, endMs].some((value) => Number.isNaN(value))) {
    return true;
  }

  return observedMs >= startMs - DE_LOBBY_TIME_WINDOW_MS && observedMs <= endMs + DE_LOBBY_TIME_WINDOW_MS;
}

async function getRecentMainLogPaths(logsDir) {
  try {
    const entries = await fs.promises.readdir(logsDir, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const mainLogPath = path.join(logsDir, entry.name, "MainLog.txt");
      try {
        const stats = await fs.promises.stat(mainLogPath);
        if (stats.isFile() && stats.size <= MAX_DE_LOG_BYTES) {
          candidates.push({
            path: mainLogPath,
            folder: entry.name,
            mtimeMs: stats.mtimeMs,
          });
        }
      } catch {
        // Ignore partially written or rotated log folders.
      }
    }
    return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 8);
  } catch {
    return [];
  }
}

async function readCandidateLobbyIds(context, { startedAt, endedAt } = {}) {
  if (!context?.logsDir) {
    return [];
  }

  const candidates = [];
  for (const logFile of await getRecentMainLogPaths(context.logsDir)) {
    const raw = await readTextFileIfSmall(logFile.path, MAX_DE_LOG_BYTES);
    if (!raw) {
      continue;
    }

    raw.split(/\r?\n/).forEach((line, index) => {
      const match = line.match(/SteamLobbyList::RemoveLobby:.*?\bsessionId=(\d+)/);
      if (!match) {
        return;
      }

      const observedAt = parseDeLogTimestamp(line);
      if (!isWithinLobbyCandidateWindow(observedAt, startedAt, endedAt)) {
        return;
      }

      candidates.push({
        id: match[1],
        source: "de_mainlog",
        confidence: "low",
        observed_at: observedAt,
        source_file: path.join("logs", logFile.folder, "MainLog.txt"),
        line: index + 1,
      });
    });
  }

  const seen = new Set();
  return candidates
    .filter((candidate) => {
      const key = `${candidate.id}:${candidate.observed_at || ""}:${candidate.source_file}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((a, b) => String(a.observed_at || "").localeCompare(String(b.observed_at || "")))
    .slice(0, MAX_CANDIDATE_LOBBY_IDS);
}

function mergeDeRuntimeMetadata(metadata, runtimeMetadata) {
  if (!runtimeMetadata) {
    return metadata;
  }

  const next = { ...metadata };
  const sources = [...next.metadata_sources];

  if (runtimeMetadata.deRuntime) {
    next.de_runtime = runtimeMetadata.deRuntime;
    sources.push("de_profile_context");
    if (runtimeMetadata.deRuntime.player_session_id) {
      sources.push("de_session_data");
    }
  }

  if (runtimeMetadata.gameVersion) {
    next.game_version = runtimeMetadata.gameVersion;
    if (runtimeMetadata.gameVersion.source === "Age2SessionData.txt") {
      sources.push("de_session_data");
    } else {
      sources.push("replay_filename_version");
    }
  }

  if (runtimeMetadata.localPlayer) {
    next.local_player = runtimeMetadata.localPlayer;
    sources.push(runtimeMetadata.localPlayer.source || "local_player_identity");
  }

  if (runtimeMetadata.candidateLobbyIds?.length) {
    next.candidate_lobby_ids = runtimeMetadata.candidateLobbyIds;
    sources.push("de_log_candidate_lobby");
  }

  next.metadata_sources = [...new Set(sources)];
  next.trust = {
    ...next.trust,
    de_runtime_context: Boolean(runtimeMetadata.deRuntime),
    local_player_identity: Boolean(runtimeMetadata.localPlayer),
    candidate_lobby_id: false,
    trusted_player_data: false,
    winner: false,
    replay_parser: false,
    bet_arming_eligible: false,
  };

  return next;
}

async function collectDeRuntimeMetadata(filePath, metadata) {
  const context = resolveDeProfileContext(filePath);
  const filenameVersion = parseReplayVersionFromFilename(path.basename(filePath));
  const sessionData = await readAge2SessionData(context);
  const localPlayer = await readLocalPlayerIdentity(context);
  const candidateLobbyIds = await readCandidateLobbyIds(context, {
    startedAt: metadata.started_at,
    endedAt: metadata.ended_at,
  });

  const deRuntime = context
    ? {
        profile_id: context.profileId,
        profile_source: "savegame_path",
        player_session_id: sessionData?.playerSessionId || null,
        player_session_source: sessionData?.playerSessionId ? "Age2SessionData.txt" : null,
        config: sessionData?.config || null,
        stream: sessionData?.stream || null,
      }
    : null;

  const gameVersion =
    sessionData?.gameVersion ||
    (filenameVersion
      ? {
          value: filenameVersion,
          build: null,
          source: "replay_filename",
        }
      : null);

  if (!deRuntime && !gameVersion && !localPlayer && candidateLobbyIds.length === 0) {
    return null;
  }

  return {
    deRuntime,
    gameVersion,
    localPlayer,
    candidateLobbyIds,
  };
}

function getPotentialMetadataSidecarPaths(filePath) {
  const parsed = path.parse(filePath);
  return [
    `${filePath}.metadata.json`,
    `${filePath}.json`,
    path.join(parsed.dir, `${parsed.name}.metadata.json`),
    path.join(parsed.dir, `${parsed.name}.json`),
  ];
}

function findWatcherMetadataSidecarPath(filePath) {
  return (
    getPotentialMetadataSidecarPaths(filePath).find((candidate) => {
      try {
        const stats = fs.statSync(candidate);
        return stats.isFile() && stats.size <= MAX_METADATA_SIDECAR_BYTES;
      } catch {
        return false;
      }
    }) || null
  );
}

async function readWatcherMetadataSidecar(filePath) {
  const sidecarPath = findWatcherMetadataSidecarPath(filePath);
  if (!sidecarPath) {
    return null;
  }

  try {
    const raw = await fs.promises.readFile(sidecarPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      log(`Ignored metadata sidecar with non-object payload: ${path.basename(sidecarPath)}`, "warn");
      return null;
    }

    return {
      sidecarPath,
      payload: parsed,
    };
  } catch (error) {
    log(`Failed to read metadata sidecar for ${path.basename(filePath)}: ${error.message}`, "warn");
    return null;
  }
}

function readObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function readBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  }
  return null;
}

function readPositiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function normalizeSidecarPlayers(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry, index) => {
      const player = readObject(entry);
      const name = cleanString(player.name || player.player_name || player.profile_name);
      if (!name) {
        return null;
      }

      const normalized = {
        name,
        source: "local_metadata_sidecar",
      };

      const civ = cleanString(player.civ || player.civilization || player.civilization_name, 80);
      const color = cleanString(player.color || player.color_name, 40);
      const team = cleanString(String(player.team ?? player.team_id ?? ""), 40);
      const slot = readPositiveNumber(player.slot || player.number || player.player_number);
      const steamId = cleanString(player.steam_id || player.user_id || player.profile_id, 64);
      const winner = readBoolean(player.winner);

      if (civ) normalized.civ = civ;
      if (color) normalized.color = color;
      if (team) normalized.team = team;
      normalized.slot = slot !== null ? slot : index + 1;
      if (steamId) normalized.user_id = steamId;
      if (winner !== null) normalized.winner = winner;

      return normalized;
    })
    .filter(Boolean);
}

function normalizeSidecarWinner(value) {
  if (typeof value === "string") {
    return {
      name: cleanString(value, 100),
      reliable: false,
      source: "local_metadata_sidecar",
    };
  }

  const winner = readObject(value);
  return {
    name: cleanString(winner.name || winner.player_name || winner.value, 100),
    reliable: readBoolean(winner.reliable ?? winner.trusted) === true,
    source: cleanString(winner.source, 80) || "local_metadata_sidecar",
  };
}

function mergeLocalMetadataSidecar(metadata, sidecar) {
  if (!sidecar?.payload) {
    return metadata;
  }

  const payload = sidecar.payload;
  const mapPayload = readObject(payload.map);
  const trustPayload = readObject(payload.trust || payload.trust_flags);
  const winnerPayload = normalizeSidecarWinner(payload.winner);
  const players = normalizeSidecarPlayers(payload.players);
  const rated = readBoolean(payload.rated ?? payload.is_rated);
  const playerCount = readPositiveNumber(payload.player_count ?? payload.players_count);
  const mode = cleanString(payload.mode || payload.game_mode || payload.game_type, 80);
  const lobbyId = cleanString(payload.lobby_id || payload.lobbyId || payload.match_id, 120);
  const sessionId = cleanString(payload.session_id || payload.sessionId, 120);
  const mapName = cleanString(mapPayload.name || payload.map_name, 120);
  const mapSize = cleanString(mapPayload.size || payload.map_size, 80);
  const startedAt = toIso(payload.started_at || payload.startedAt);
  const endedAt = toIso(payload.ended_at || payload.endedAt);

  const next = {
    ...metadata,
    metadata_sources: [...new Set([...metadata.metadata_sources, "local_metadata_sidecar"])],
    local_sidecar_filename: path.basename(sidecar.sidecarPath),
  };

  if (sessionId) next.session_id = sessionId;
  if (lobbyId) next.lobby_id = lobbyId;
  if (startedAt) next.started_at = startedAt;
  if (endedAt) next.ended_at = endedAt;
  if (mode) next.mode = mode;
  if (rated !== null) next.rated = rated;
  if (playerCount !== null) next.player_count = playerCount;
  if (players.length > 0) {
    next.players = players;
    next.player_count = players.length;
  }
  if (mapName || mapSize) {
    next.map = {
      ...(metadata.map || {}),
      ...(mapName ? { name: mapName } : {}),
      ...(mapSize ? { size: mapSize } : {}),
    };
  }
  if (winnerPayload.name) {
    next.winner = winnerPayload;
  }

  next.trust = {
    ...metadata.trust,
    trusted_player_data:
      readBoolean(trustPayload.trusted_player_data ?? trustPayload.player_data) === true,
    winner:
      readBoolean(trustPayload.winner ?? trustPayload.winner_reliable) === true ||
      winnerPayload.reliable === true,
    replay_parser: false,
    bet_arming_eligible: false,
  };

  return next;
}

async function buildWatcherFinalMetadata(
  filePath,
  runtimeConfig,
  entry,
  { replayHash, parseIteration = 1 } = {}
) {
  const stats = await fs.promises.stat(filePath);
  const uploadedAt = new Date();
  const fileName = path.basename(filePath);
  const firstObservedAt = entry.firstObservedAt || uploadedAt.toISOString();
  const sessionId =
    entry.sessionId ||
    `watcher-${stableHash(
      [
        runtimeConfig.watcherUid,
        fileName,
        stats.birthtimeMs > 0 ? Math.floor(stats.birthtimeMs) : "",
        firstObservedAt,
      ].join(":")
    )}`;

  entry.sessionId = sessionId;
  entry.firstObservedAt = firstObservedAt;

  const metadata = {
    schema: WATCHER_METADATA_SCHEMA,
    version: WATCHER_METADATA_VERSION,
    metadata_sources: ["watcher_file_observation"],
    metadata_source: "watcher_file_observation",
    replay_hash: replayHash || null,
    watcher_uid: runtimeConfig.watcherUid,
    session_id: sessionId,
    lobby_id: null,
    filename: fileName,
    original_filename: fileName,
    parse_iteration: parseIteration,
    started_at:
      parseReplayTimestampFromFilename(fileName) ||
      toIso(stats.birthtimeMs > 0 ? stats.birthtime : null) ||
      firstObservedAt,
    ended_at: toIso(stats.mtime),
    uploaded_at: toIso(uploadedAt),
    file_size_bytes: stats.size,
    players: [],
    player_count: null,
    map: null,
    mode: null,
    rated: null,
    winner: {
      name: null,
      reliable: false,
      source: null,
    },
    trust: {
      file_observation: true,
      trusted_player_data: false,
      winner: false,
      replay_parser: false,
      bet_arming_eligible: false,
    },
  };

  const runtimeMetadata = await collectDeRuntimeMetadata(filePath, metadata);
  const enrichedMetadata = mergeDeRuntimeMetadata(metadata, runtimeMetadata);

  return mergeLocalMetadataSidecar(enrichedMetadata, await readWatcherMetadataSidecar(filePath));
}

function getStateEntry(filePath) {
  let entry = activeUploadState.get(filePath);
  if (!entry) {
    entry = {
      monitoring: false,
      importing: false,
      firstObservedAt: new Date().toISOString(),
      sessionId: null,
      lastObservedFingerprint: null,
      lastChangeAt: 0,
      lastLiveAttemptAt: 0,
      lastLiveUploadAt: 0,
      lastLiveUploadedFingerprint: null,
      lastFinalUploadedFingerprint: null,
      lastFinalReplayHash: null,
      lastFinalUploadAt: 0,
      lastReplayGrowthNoticeAt: 0,
      liveIteration: 0,
    };
    activeUploadState.set(filePath, entry);
  }
  return entry;
}

function formatResponseBody(data) {
  if (data == null) return "";
  if (typeof data === "string") return data;

  if (Array.isArray(data?.detail)) {
    return data.detail
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return String(entry || "").trim();
        }

        const loc = Array.isArray(entry.loc) ? entry.loc.join(".") : "";
        const msg = typeof entry.msg === "string" ? entry.msg.trim() : "";
        return [loc, msg].filter(Boolean).join(": ");
      })
      .filter(Boolean)
      .join(" | ");
  }

  if (typeof data.message === "string") return data.message;
  if (typeof data.detail === "string") return data.detail;

  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function shouldHandle(filePath, runtimeConfig) {
  const ext = path.extname(filePath).toLowerCase();
  if (!runtimeConfig.watchExtensions.has(ext)) return false;
  if (filePath.includes("Out of Sync")) return false;
  return true;
}

function getSupportedReplayExtensions() {
  return [...SUPPORTED_REPLAY_EXTENSIONS];
}

function classifyUploadResult(detail = "") {
  const normalized = detail.toLowerCase();

  if (normalized.includes("already parsed as final") || normalized.includes("already stored")) {
    return "duplicate";
  }

  if (normalized.includes("refreshed")) {
    return "refreshed";
  }

  if (normalized.includes("placeholder")) {
    return "placeholder";
  }

  return "uploaded";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFirstBytes(filePath, runtimeConfig) {
  const deadline = Date.now() + runtimeConfig.firstBytesTimeoutMs;
  let lastSeenSize = -1;

  while (Date.now() < deadline) {
    try {
      const stats = await fs.promises.stat(filePath);
      const size = Number(stats?.size || 0);

      if (size > 0) {
        if (size !== lastSeenSize) {
          log(`Replay started writing (${size} bytes): ${path.basename(filePath)}`);
        }
        return true;
      }

      lastSeenSize = size;
    } catch (err) {
      log(
        `Unable to inspect ${path.basename(filePath)} before live parse: ${err.message}`,
        "warn"
      );
    }

    await sleep(runtimeConfig.firstBytesPollMs);
  }

  log(
    `Replay did not write any bytes within ${Math.round(
      runtimeConfig.firstBytesTimeoutMs / 1000
    )}s: ${path.basename(filePath)}`,
    "warn"
  );
  return false;
}

function isReplayFinalizingError(error) {
  return (
    error?.response?.status === 422 &&
    formatResponseBody(error?.response?.data)
      .toLowerCase()
      .includes("failed to parse replay file")
  );
}

async function waitForReplayProgress(filePath, fingerprint, delayMs) {
  const deadline = Date.now() + delayMs;

  while (Date.now() < deadline) {
    const sleepMs = Math.min(1000, Math.max(1, deadline - Date.now()));
    await sleep(sleepMs);

    if (!fs.existsSync(filePath)) {
      return;
    }

    try {
      const currentFingerprint = await getFileFingerprint(filePath);
      if (currentFingerprint !== fingerprint) {
        return;
      }
    } catch {
      return;
    }
  }
}

async function getStableImportFingerprint(filePath) {
  if (!fs.existsSync(filePath)) {
    return { stable: false, reason: "missing" };
  }

  try {
    const firstFingerprint = await getFileFingerprint(filePath);
    await sleep(IMPORT_STABILITY_CHECK_MS);

    if (!fs.existsSync(filePath)) {
      return { stable: false, reason: "missing" };
    }

    const secondFingerprint = await getFileFingerprint(filePath);
    if (firstFingerprint !== secondFingerprint) {
      return { stable: false, reason: "changing" };
    }

    return {
      stable: true,
      fingerprint: secondFingerprint,
    };
  } catch (error) {
    return {
      stable: false,
      reason: "inspect_failed",
      detail: error.message || "Unable to inspect file.",
    };
  }
}

function getFormLength(form) {
  return new Promise((resolve, reject) => {
    form.getLength((err, length) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(length);
    });
  });
}

async function syncEntryAfterUpload(filePath, entry, uploadedFingerprint) {
  try {
    const currentFingerprint = await getFileFingerprint(filePath);
    if (currentFingerprint !== uploadedFingerprint) {
      entry.lastObservedFingerprint = currentFingerprint;
      entry.lastChangeAt = Date.now();
      return true;
    }
  } catch (err) {
    log(`Unable to recheck ${path.basename(filePath)} after upload: ${err.message}`, "warn");
  }

  return false;
}

function shouldLogReplayGrowthNotice(entry, runtimeConfig, isFinal) {
  if (isFinal) {
    entry.lastReplayGrowthNoticeAt = Date.now();
    return true;
  }

  const now = Date.now();
  if (
    entry.lastReplayGrowthNoticeAt === 0 ||
    now - entry.lastReplayGrowthNoticeAt >= runtimeConfig.replayProgressLogIntervalMs
  ) {
    entry.lastReplayGrowthNoticeAt = now;
    return true;
  }

  return false;
}

function hasSettledReplayFingerprint(entry, fingerprint, runtimeConfig, now = Date.now()) {
  return Boolean(
    fingerprint &&
      fingerprint === entry.lastFinalUploadedFingerprint &&
      fingerprint === entry.lastObservedFingerprint &&
      entry.lastFinalUploadAt > 0 &&
      now - entry.lastFinalUploadAt >= runtimeConfig.finalSettleWindowMs
  );
}

async function resolveFinalReplayShortCircuit(
  filePath,
  entry,
  runtimeConfig,
  { fingerprint = null, now = Date.now() } = {}
) {
  if (!entry.lastFinalUploadedFingerprint && !entry.lastFinalReplayHash) {
    return null;
  }

  let nextFingerprint = fingerprint;
  if (!nextFingerprint) {
    try {
      nextFingerprint = await getFileFingerprint(filePath);
    } catch {
      return null;
    }
  }

  if (hasSettledReplayFingerprint(entry, nextFingerprint, runtimeConfig, now)) {
    return {
      reason: "settled_fingerprint",
      fingerprint: nextFingerprint,
    };
  }

  if (!entry.lastFinalReplayHash) {
    return null;
  }

  let contentHash;
  try {
    contentHash = await getReplayContentHash(filePath);
  } catch (error) {
    log(
      `Unable to hash ${path.basename(filePath)} while checking final replay state: ${error.message}`,
      "warn"
    );
    return null;
  }

  if (contentHash !== entry.lastFinalReplayHash) {
    return null;
  }

  entry.lastObservedFingerprint = nextFingerprint;
  entry.lastFinalUploadedFingerprint = nextFingerprint;
  entry.lastChangeAt = now;

  return {
    reason: "settled_replay_hash",
    fingerprint: nextFingerprint,
    replayHash: contentHash,
  };
}

async function uploadReplay(
  filePath,
  runtimeConfig,
  { parseIteration = 1, isFinal = true, uploadUrl, metadata = null } = {}
) {
  const replayBuffer = await fs.promises.readFile(filePath);

  const form = new FormData();
  form.append("file", replayBuffer, {
    filename: path.basename(filePath),
    contentType: "application/octet-stream",
    knownLength: replayBuffer.length,
  });
  if (metadata) {
    form.append("metadata", JSON.stringify(metadata), {
      contentType: "application/json",
    });
  }

  const headers = {
    ...form.getHeaders(),
    "x-user-uid": runtimeConfig.watcherUid,
    "x-parse-iteration": String(parseIteration),
    "x-is-final": isFinal ? "true" : "false",
    "x-parse-source": isFinal ? "watcher_final" : "watcher_live",
    "x-parse-reason": isFinal ? "watcher_final_submission" : "watcher_live_iteration",
  };
  if (metadata) {
    headers["x-watcher-metadata-version"] = String(metadata.version || WATCHER_METADATA_VERSION);
  }

  if (runtimeConfig.uploadApiKey) {
    headers["x-api-key"] = runtimeConfig.uploadApiKey;
  }

  try {
    headers["Content-Length"] = await getFormLength(form);
  } catch (err) {
    log(`Unable to precompute upload size for ${path.basename(filePath)}: ${err.message}`, "warn");
  }

  return axios.post(uploadUrl, form, {
    timeout: 60000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    headers,
  });
}

function isRetryableUploadError(error) {
  const status = error?.response?.status;
  const detail = formatResponseBody(error?.response?.data).toLowerCase();
  const hasValidationDetailArray = Array.isArray(error?.response?.data?.detail);

  if (!error?.response) {
    return true;
  }

  if (
    status === 422 &&
    (detail.includes("failed to parse replay file") || hasValidationDetailArray)
  ) {
    return true;
  }

  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isNetworkUploadError(error) {
  return !error?.response;
}

async function uploadReplayWithRetry(
  filePath,
  runtimeConfig,
  entry,
  { fingerprint, parseIteration, isFinal }
) {
  const maxAttempts = runtimeConfig.maxUploadRetries + 1;
  let attemptFingerprint = fingerprint;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const retryLabel =
      attempt > 0 ? ` (retry ${attempt}/${runtimeConfig.maxUploadRetries})` : "";
    const targetSequence = getUploadTargetsForAttempt(runtimeConfig);

    for (let targetIndex = 0; targetIndex < targetSequence.length; targetIndex += 1) {
      const target = targetSequence[targetIndex];
      const targetHost = new URL(target.uploadUrl).host;

      emitRuntimeEvent("upload-start", {
        filePath,
        fileName: path.basename(filePath),
        isFinal,
        parseIteration,
        attempt,
        maxRetryCount: runtimeConfig.maxUploadRetries,
        uploadHost: targetHost,
      });

      log(
        `${isFinal ? "Uploading final replay" : "Uploading live replay"}: ${filePath} ` +
          `[iteration ${parseIteration}]${retryLabel}${
            runtimeConfig.uploadTargets.length > 1 ? ` via ${targetHost}` : ""
          }`
      );

      try {
        attemptFingerprint = await getFileFingerprint(filePath);
        let metadata = null;
        if (isFinal) {
          const replayHash = await getReplayContentHash(filePath);
          metadata = await buildWatcherFinalMetadata(filePath, runtimeConfig, entry, {
            replayHash,
            parseIteration,
          });
        }
        const res = await uploadReplay(filePath, runtimeConfig, {
          parseIteration,
          isFinal,
          uploadUrl: target.uploadUrl,
          metadata,
        });
        const detail = formatResponseBody(res.data);
        const resultType = classifyUploadResult(detail);
        const replayHash =
          typeof res?.data?.replay_hash === "string" && res.data.replay_hash.trim()
            ? res.data.replay_hash.trim()
            : null;

        rememberWorkingUploadTarget(target);

        if (isFinal || detail.toLowerCase().includes("already parsed as final")) {
          entry.lastFinalUploadedFingerprint = attemptFingerprint;
          entry.lastFinalUploadAt = Date.now();
          if (replayHash) {
            entry.lastFinalReplayHash = replayHash;
          }
        } else {
          entry.lastLiveUploadedFingerprint = attemptFingerprint;
          entry.liveIteration = parseIteration;
          entry.lastLiveUploadAt = Date.now();
        }

        const changedDuringUpload = await syncEntryAfterUpload(
          filePath,
          entry,
          attemptFingerprint
        );

        log(`Uploaded (${res.status}): ${path.basename(filePath)}${detail ? ` - ${detail}` : ""}`);

        emitRuntimeEvent("upload-success", {
          filePath,
          fileName: path.basename(filePath),
          isFinal,
          parseIteration,
          resultType,
          responseStatus: res.status,
          detail,
        });

        if (changedDuringUpload && shouldLogReplayGrowthNotice(entry, runtimeConfig, isFinal)) {
          log(
            `Replay is still growing during ${
              isFinal ? "final" : "live"
            } upload, watcher will wait for quiet replay bytes before the next pass.`
          );
        }

        return {
          ok: true,
          changedDuringUpload,
          detail,
          resultType,
          responseData: res.data,
          responseStatus: res.status,
        };
      } catch (err) {
        const responseDetail = formatResponseBody(err?.response?.data);
        const prefix = isFinal ? "Final upload failed" : "Live upload failed";
        const errorMessage = responseDetail || err.message;

        log(`${prefix} for ${path.basename(filePath)}: ${err.message}`, "error");

        if (err.response) {
          log(
            `Server response: ${err.response.status} ${JSON.stringify(err.response.data)}`,
            "error"
          );
        }

        if (isNetworkUploadError(err) && targetIndex < targetSequence.length - 1) {
          const nextTarget = targetSequence[targetIndex + 1];
          log(
            `Upload target ${targetHost} is unavailable. Trying ${new URL(nextTarget.uploadUrl).host} next.`,
            "warn"
          );
          continue;
        }

        if (!isRetryableUploadError(err) || attempt >= maxAttempts - 1) {
          emitRuntimeEvent("upload-failure", {
            filePath,
            fileName: path.basename(filePath),
            isFinal,
            parseIteration,
            errorMessage,
            responseStatus: err?.response?.status || null,
          });
          return {
            ok: false,
            errorMessage,
            responseStatus: err?.response?.status || null,
          };
        }

        const delayMs = getRetryDelayMsFactory(runtimeConfig, attempt + 1);
        log(
          `Retrying ${path.basename(filePath)} in ${Math.round(delayMs / 1000)}s ` +
            `(attempt ${attempt + 1}/${runtimeConfig.maxUploadRetries}) because ${
              errorMessage || err.message
            }`,
          "warn"
        );

        emitRuntimeEvent("upload-retry", {
          filePath,
          fileName: path.basename(filePath),
          isFinal,
          parseIteration,
          errorMessage,
          retryInMs: delayMs,
          nextRetryAttempt: attempt + 1,
          maxRetryCount: runtimeConfig.maxUploadRetries,
          responseStatus: err?.response?.status || null,
        });

        if (isReplayFinalizingError(err)) {
          await waitForReplayProgress(filePath, attemptFingerprint, delayMs);
        } else {
          await sleep(delayMs);
        }

        break;
      }
    }
  }

  return {
    ok: false,
    errorMessage: "Upload failed after all retries.",
  };
}

async function monitorReplayFile(filePath, runtimeConfig) {
  if (!shouldHandle(filePath, runtimeConfig)) {
    log(`Ignoring non-replay file: ${path.basename(filePath)}`, "warn");
    return;
  }

  const entry = getStateEntry(filePath);
  if (entry.monitoring) {
    log(`Skipping duplicate monitor for ${path.basename(filePath)} because it is already active.`);
    return;
  }

  if (entry.importing) {
    log(`Skipping live monitor for ${path.basename(filePath)} because it is importing already.`, "warn");
    return;
  }

  const finalReplayShortCircuit = await resolveFinalReplayShortCircuit(
    filePath,
    entry,
    runtimeConfig
  );
  if (finalReplayShortCircuit) {
    log(
      `Skipping monitor for ${path.basename(filePath)} because replay already matches final upload state (${finalReplayShortCircuit.reason}).`
    );
    emitRuntimeEvent("monitor-skip-final", {
      filePath,
      fileName: path.basename(filePath),
      reason: finalReplayShortCircuit.reason,
      replayHash: finalReplayShortCircuit.replayHash || entry.lastFinalReplayHash || null,
    });
    return;
  }

  entry.monitoring = true;
  emitRuntimeEvent("monitor-start", {
    filePath,
    fileName: path.basename(filePath),
  });
  log(`Starting monitor loop for ${path.basename(filePath)}.`);

  try {
  if (!(await waitForFirstBytes(filePath, runtimeConfig))) {
    log(
      `Replay has not started writing yet for ${path.basename(
        filePath
      )}; keeping monitor alive and retrying on the normal loop.`,
      "warn"
    );
  }

    if (runtimeConfig.initialLiveDelayMs > 0) {
      log(
        `Waiting ${Math.round(runtimeConfig.initialLiveDelayMs / 1000)}s before first live upload for ${path.basename(
          filePath
        )}.`
      );
      await sleep(runtimeConfig.initialLiveDelayMs);
    }

    while (true) {
      if (!fs.existsSync(filePath)) {
        log(`Replay removed before final upload: ${path.basename(filePath)}`, "warn");
        return;
      }

      const now = Date.now();
      let fingerprint;

      try {
        fingerprint = await getFileFingerprint(filePath);
      } catch (err) {
        log(`Unable to inspect ${path.basename(filePath)}: ${err.message}`, "error");
        emitRuntimeEvent("watcher-error", {
          filePath,
          fileName: path.basename(filePath),
          detail: err.message,
        });
        return;
      }

      if (hasSettledReplayFingerprint(entry, fingerprint, runtimeConfig, now)) {
        log(`Monitor loop complete for ${path.basename(filePath)}. Replay is fully settled.`);
        return;
      }

      const changed = fingerprint !== entry.lastObservedFingerprint;

      if (changed) {
        entry.lastObservedFingerprint = fingerprint;
        entry.lastChangeAt = now;

        log(`Observed replay change for ${path.basename(filePath)} with fingerprint ${fingerprint}.`);

        const liveCooldownMs =
          entry.liveIteration === 0
            ? runtimeConfig.initialLiveRetryCooldownMs
            : runtimeConfig.liveUploadCooldownMs;
        const lastLiveAnchorAt =
          entry.liveIteration === 0 ? entry.lastLiveAttemptAt : entry.lastLiveUploadAt;

        const readyForLiveUpload =
          fingerprint !== entry.lastLiveUploadedFingerprint &&
          (lastLiveAnchorAt === 0 || now - lastLiveAnchorAt >= liveCooldownMs);

        if (!entry.lastFinalUploadedFingerprint && readyForLiveUpload) {
          const nextIteration = entry.liveIteration + 1;
          entry.lastLiveAttemptAt = now;

          await uploadReplayWithRetry(filePath, runtimeConfig, entry, {
            fingerprint,
            parseIteration: nextIteration,
            isFinal: false,
          });
        } else if (!entry.lastFinalUploadedFingerprint) {
          log(
            `Live upload cooldown still active for ${path.basename(filePath)}. Waiting for next eligible pass.`
          );
        }
      } else if (
        fingerprint !== entry.lastFinalUploadedFingerprint &&
        entry.lastChangeAt > 0 &&
        now - entry.lastChangeAt >= runtimeConfig.quietPeriodMs
      ) {
        log(
          `Quiet period reached for ${path.basename(filePath)} after ${Math.round(
            runtimeConfig.quietPeriodMs / 1000
          )}s. Attempting final upload.`
        );

        const nextIteration = Math.max(1, entry.liveIteration + 1);
        const stored = await uploadReplayWithRetry(filePath, runtimeConfig, entry, {
          fingerprint,
          parseIteration: nextIteration,
          isFinal: true,
        });

        if (stored.ok) {
          continue;
        }
      }

      await sleep(runtimeConfig.stableCheckIntervalMs);
    }
  } finally {
    entry.monitoring = false;
    emitRuntimeEvent("monitor-stop", {
      filePath,
      fileName: path.basename(filePath),
    });
    log(`Stopped monitor loop for ${path.basename(filePath)}.`);
  }
}

async function onFileDetected(eventType, filePath, runtimeConfig) {
  if (!shouldHandle(filePath, runtimeConfig)) {
    return;
  }

  const entry = getStateEntry(filePath);
  const fileName = path.basename(filePath);

  if (entry.monitoring) {
    emitRuntimeEvent("replay-detected-ignored", {
      filePath,
      fileName,
      eventType,
      reason: "monitoring",
    });
    return;
  }

  if (entry.importing) {
    emitRuntimeEvent("replay-detected-ignored", {
      filePath,
      fileName,
      eventType,
      reason: "importing",
    });
    return;
  }

  const finalReplayShortCircuit = await resolveFinalReplayShortCircuit(
    filePath,
    entry,
    runtimeConfig
  );
  if (finalReplayShortCircuit) {
    log(
      `Ignoring ${eventType} event for ${fileName} because replay already matches final upload state (${finalReplayShortCircuit.reason}).`
    );
    emitRuntimeEvent("replay-detected-ignored", {
      filePath,
      fileName,
      eventType,
      reason: finalReplayShortCircuit.reason,
      replayHash: finalReplayShortCircuit.replayHash || entry.lastFinalReplayHash || null,
    });
    return;
  }

  log(`Detected ${eventType} event: ${fileName}`);
  emitRuntimeEvent("replay-detected", {
    filePath,
    fileName,
    eventType,
  });
  void monitorReplayFile(filePath, runtimeConfig).catch((err) => {
    log(`Replay monitor crashed for ${fileName}: ${err.message || err}`, "error");
    emitRuntimeEvent("watcher-error", {
      filePath,
      fileName,
      detail: err.message || String(err),
    });
  });
}

function createImportItem(filePath, status, detail) {
  return {
    filePath,
    fileName: path.basename(filePath),
    status,
    detail,
  };
}

function pushImportItem(list, item) {
  list.unshift(item);
  if (list.length > IMPORT_ITEM_LIMIT) {
    list.length = IMPORT_ITEM_LIMIT;
  }
}

function cloneImportState(state) {
  return JSON.parse(JSON.stringify(state));
}

function emitImportProgress(state, hooks) {
  if (typeof hooks.onProgress === "function") {
    hooks.onProgress(cloneImportState(state));
  }
}

function updateImportPercent(state) {
  if (state.queued <= 0) {
    state.percent = state.phase.startsWith("complete") ? 100 : 0;
    return;
  }

  const finished = state.uploaded + state.failed + state.skipped;
  state.percent = Math.max(0, Math.min(100, Math.round((finished / state.queued) * 100)));
}

function buildImportSummaryText(state) {
  return `Imported ${state.uploaded}, skipped ${state.skipped}, failed ${state.failed}.`;
}

async function listImportCandidates(runtimeConfig, filePaths = null) {
  const supportedFiles = [];
  const skippedAtScan = [];
  let unsupported = 0;

  if (Array.isArray(filePaths)) {
    const seen = new Set();

    for (const rawPath of filePaths) {
      const filePath = String(rawPath || "").trim();
      if (!filePath || seen.has(filePath)) {
        continue;
      }
      seen.add(filePath);

      if (!fs.existsSync(filePath)) {
        skippedAtScan.push(createImportItem(filePath, "skipped", "File is no longer on disk."));
        continue;
      }

      const stats = await fs.promises.stat(filePath);
      if (!stats.isFile()) {
        skippedAtScan.push(createImportItem(filePath, "skipped", "Not a replay file."));
        continue;
      }

      if (!shouldHandle(filePath, runtimeConfig)) {
        skippedAtScan.push(
          createImportItem(filePath, "skipped", "Not a supported replay extension for this watcher.")
        );
        continue;
      }

      supportedFiles.push({
        filePath,
        fileName: path.basename(filePath),
        mtimeMs: stats.mtimeMs,
      });
    }

    return {
      supportedFiles,
      unsupported,
      skippedAtScan,
    };
  }

  const entries = await fs.promises.readdir(runtimeConfig.watchDir, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const filePath = path.join(runtimeConfig.watchDir, entry.name);
    if (!shouldHandle(filePath, runtimeConfig)) {
      unsupported += 1;
      continue;
    }

    const stats = await fs.promises.stat(filePath);
    supportedFiles.push({
      filePath,
      fileName: entry.name,
      mtimeMs: stats.mtimeMs,
    });
  }

  supportedFiles.sort((left, right) => {
    if (left.mtimeMs !== right.mtimeMs) {
      return left.mtimeMs - right.mtimeMs;
    }
    return left.fileName.localeCompare(right.fileName);
  });

  return {
    supportedFiles,
    unsupported,
    skippedAtScan,
  };
}

async function importHistoricalReplays(config = {}, options = {}, hooks = {}) {
  setRuntimeHooks(hooks);

  const runtimeConfig = buildRuntimeConfig(config);
  const validationError = getRuntimeValidationError(runtimeConfig);
  if (validationError) {
    throw new Error(validationError);
  }

  const state = {
    isRunning: true,
    source: options.source || (Array.isArray(options.filePaths) ? "retry" : "scan"),
    phase: "scanning",
    startedAt: new Date().toISOString(),
    completedAt: null,
    percent: 0,
    found: 0,
    queued: 0,
    skipped: 0,
    uploaded: 0,
    failed: 0,
    unsupported: 0,
    currentFile: "",
    currentIndex: 0,
    failedItems: [],
    skippedItems: [],
    recentItems: [],
    summaryText: "",
  };

  emitImportProgress(state, hooks);

  const { supportedFiles, unsupported, skippedAtScan } = await listImportCandidates(
    runtimeConfig,
    options.filePaths || null
  );

  state.found = supportedFiles.length;
  state.unsupported = unsupported;

  const queue = [];
  for (const candidate of supportedFiles) {
    const entry = getStateEntry(candidate.filePath);
    if (entry.monitoring) {
      state.skipped += 1;
      pushImportItem(
        state.skippedItems,
        createImportItem(
          candidate.filePath,
          "skipped",
          "Already being watched live. Let the watcher finish the current replay."
        )
      );
      continue;
    }

    if (entry.importing) {
      state.skipped += 1;
      pushImportItem(
        state.skippedItems,
        createImportItem(candidate.filePath, "skipped", "Already queued for import in this session.")
      );
      continue;
    }

    queue.push(candidate);
  }

  for (const skippedItem of skippedAtScan) {
    state.skipped += 1;
    pushImportItem(state.skippedItems, skippedItem);
  }

  state.queued = queue.length;
  state.phase = queue.length > 0 ? "uploading" : "complete";
  updateImportPercent(state);
  emitImportProgress(state, hooks);

  if (queue.length === 0) {
    state.isRunning = false;
    state.completedAt = new Date().toISOString();
    state.summaryText =
      state.found === 0
        ? "No supported replay files were found in this folder."
        : buildImportSummaryText(state);
    emitImportProgress(state, hooks);
    return cloneImportState(state);
  }

  for (let index = 0; index < queue.length; index += 1) {
    const candidate = queue[index];
    const entry = getStateEntry(candidate.filePath);

    state.currentIndex = index + 1;
    state.currentFile = candidate.fileName;
    state.phase = "uploading";
    emitImportProgress(state, hooks);

    const stability = await getStableImportFingerprint(candidate.filePath);

    if (!stability.stable) {
      state.skipped += 1;
      const reason =
        stability.reason === "changing"
          ? "Replay is still changing on disk. Live watching will finish it."
          : stability.reason === "missing"
            ? "Replay disappeared before import started."
            : stability.detail || "Unable to inspect replay file.";
      pushImportItem(state.skippedItems, createImportItem(candidate.filePath, "skipped", reason));
      pushImportItem(state.recentItems, createImportItem(candidate.filePath, "skipped", reason));
      updateImportPercent(state);
      emitImportProgress(state, hooks);
      continue;
    }

    if (entry.lastFinalUploadedFingerprint === stability.fingerprint) {
      state.skipped += 1;
      const detail = "Already imported in this app session.";
      pushImportItem(state.skippedItems, createImportItem(candidate.filePath, "skipped", detail));
      pushImportItem(state.recentItems, createImportItem(candidate.filePath, "skipped", detail));
      updateImportPercent(state);
      emitImportProgress(state, hooks);
      continue;
    }

    entry.importing = true;
    try {
      const result = await uploadReplayWithRetry(candidate.filePath, runtimeConfig, entry, {
        fingerprint: stability.fingerprint,
        parseIteration: 1,
        isFinal: true,
      });

      if (!result.ok) {
        state.failed += 1;
        const detail = result.errorMessage || "Upload failed.";
        pushImportItem(state.failedItems, createImportItem(candidate.filePath, "failed", detail));
        pushImportItem(state.recentItems, createImportItem(candidate.filePath, "failed", detail));
      } else if (result.resultType === "duplicate") {
        state.skipped += 1;
        const detail = result.detail || "Replay already exists on AoE2DEWarWagers.";
        pushImportItem(state.skippedItems, createImportItem(candidate.filePath, "skipped", detail));
        pushImportItem(state.recentItems, createImportItem(candidate.filePath, "skipped", detail));
      } else {
        state.uploaded += 1;
        const detail =
          result.resultType === "refreshed"
            ? result.detail || "Replay refreshed with better final data."
            : result.detail || "Replay imported successfully.";
        pushImportItem(state.recentItems, createImportItem(candidate.filePath, "uploaded", detail));
      }
    } finally {
      entry.importing = false;
      state.currentFile = "";
      updateImportPercent(state);
      emitImportProgress(state, hooks);
    }
  }

  state.isRunning = false;
  state.phase = state.failed > 0 ? "complete_with_failures" : "complete";
  state.completedAt = new Date().toISOString();
  state.summaryText = buildImportSummaryText(state);
  updateImportPercent(state);
  emitImportProgress(state, hooks);

  return cloneImportState(state);
}

function stopWatching() {
  if (activeWatcher) {
    try {
      activeWatcher.close();
      log("Closed chokidar watcher handle.");
    } catch (error) {
      log(`Failed closing watcher: ${error.message}`, "error");
    }
  }

  activeWatcher = null;
  activeUploadState = new Map();
  activePreferredUploadTargetBaseUrl = null;
  emitRuntimeEvent("watching-stopped", {});
}

function startWatching(config = {}, hooks = {}) {
  stopWatching();
  setRuntimeHooks(hooks);

  const runtimeConfig = buildRuntimeConfig(config);
  const validationError = getRuntimeValidationError(runtimeConfig);
  activePreferredUploadTargetBaseUrl = runtimeConfig.uploadTargets[0]?.baseUrl || null;

  if (validationError) {
    log(validationError, "error");
    if (validationError.toLowerCase().includes("replay directory")) {
      log("Choose a valid AoE2DE savegame folder and restart watching.", "error");
    }
    emitRuntimeEvent("watcher-error", {
      detail: validationError,
    });
    return null;
  }

  log(`Watching directory: ${runtimeConfig.watchDir}`);
  log(
    `Upload endpoints: ${runtimeConfig.uploadTargets
      .map((target) => target.uploadUrl)
      .join(" -> ")}`
  );
  log(`Watcher UID: ${runtimeConfig.watcherUid}`);
  log(`Chokidar extensions: ${Array.from(runtimeConfig.watchExtensions).join(", ")}`);

  emitRuntimeEvent("watching-started", {
    watchDir: runtimeConfig.watchDir,
    uploadTargets: runtimeConfig.uploadTargets.map((target) => target.uploadUrl),
  });

  activeWatcher = chokidar.watch(runtimeConfig.watchDir, {
    persistent: true,
    ignoreInitial: true,
    depth: 0,
  });

  activeWatcher.on("ready", () => {
    log("Chokidar watcher is ready and listening for replay events.");
    emitRuntimeEvent("watcher-ready", {
      watchDir: runtimeConfig.watchDir,
    });
  });

  activeWatcher.on("add", (filePath) => onFileDetected("add", filePath, runtimeConfig));
  activeWatcher.on("change", (filePath) => onFileDetected("change", filePath, runtimeConfig));
  activeWatcher.on("error", (err) => {
    log(`Watcher error: ${err.message}`, "error");
    emitRuntimeEvent("watcher-error", {
      detail: err.message,
    });
  });

  return activeWatcher;
}

module.exports = {
  buildWatcherFinalMetadata,
  buildRuntimeConfig,
  classifyUploadResult,
  findWatcherMetadataSidecarPath,
  getDefaultReplayDir,
  getFileFingerprint,
  getRetryDelayMs: (attempt, config = {}) =>
    getRetryDelayMsFactory(buildRuntimeConfig(config), attempt),
  getReplayContentHash,
  getRuntimeValidationError,
  getSupportedReplayExtensions,
  importHistoricalReplays,
  isRetryableUploadError,
  monitorReplayFile,
  resolveFinalReplayShortCircuit,
  shouldHandle,
  startWatching,
  stopWatching,
};
