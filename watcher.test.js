const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildWatcherFinalMetadata,
  buildRuntimeConfig,
  findWatcherMetadataSidecarPath,
  getFileFingerprint,
  getDefaultReplayDir,
  getReplayContentHash,
  getSupportedReplayExtensions,
  resolveFinalReplayShortCircuit,
} = require("./watcher");

function buildEntry(overrides = {}) {
  return {
    monitoring: false,
    importing: false,
    firstObservedAt: "2026-04-22T18:00:00.000Z",
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
    ...overrides,
  };
}

async function createTempReplay(t, content) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoe2-watcher-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const filePath = path.join(tempDir, "test-replay.aoe2record");
  await fs.writeFile(filePath, content);
  return filePath;
}

async function createTempReplayNamed(t, fileName, content) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoe2-watcher-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const filePath = path.join(tempDir, fileName);
  await fs.writeFile(filePath, content);
  return filePath;
}

async function mkdirp(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
  return targetPath;
}

test("defaults to the CrossOver AoE2DE savegame folder on macOS", async (t) => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "aoe2de-home-"));
  t.after(async () => {
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  const deSaveGameDir = await mkdirp(
    path.join(
      tempHome,
      "Library",
      "Application Support",
      "CrossOver",
      "Bottles",
      "Steam",
      "drive_c",
      "users",
      "crossover",
      "Games",
      "Age of Empires 2 DE",
      "76561198000000000",
      "savegame"
    )
  );

  const legacyInstallDir = ["Age2", "HD"].join("");
  await mkdirp(
    path.join(
      tempHome,
      "Library",
      "Application Support",
      "CrossOver",
      "Bottles",
      "Steam",
      "drive_c",
      "Program Files (x86)",
      "Steam",
      "steamapps",
      "common",
      legacyInstallDir,
      "SaveGame"
    )
  );

  assert.equal(getDefaultReplayDir({ home: tempHome, platform: "darwin" }), deSaveGameDir);
});

test("does not fall back to HD replay folders", async (t) => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "aoe2de-home-"));
  t.after(async () => {
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  await mkdirp(
    path.join(
      tempHome,
      "Library",
      "Application Support",
      "CrossOver",
      "Bottles",
      "Steam",
      "drive_c",
      "Program Files (x86)",
      "Steam",
      "steamapps",
      "common",
      ["Age2", "HD"].join(""),
      "SaveGame"
    )
  );

  assert.equal(getDefaultReplayDir({ home: tempHome, platform: "darwin" }), null);
});

test("runtime defaults point to the DE API stack", () => {
  const originalApiBaseUrl = process.env.AOE2_API_BASE_URL;
  const originalFallbackBaseUrl = process.env.AOE2_API_FALLBACK_BASE_URL;
  delete process.env.AOE2_API_BASE_URL;
  delete process.env.AOE2_API_FALLBACK_BASE_URL;

  try {
    const config = buildRuntimeConfig();

    assert.deepEqual(
      config.uploadTargets.map((target) => target.uploadUrl),
      [
        "https://api-prodn.aoe2dewarwagers.com/api/replay/upload",
        "https://aoe2dewarwagers.com/api/replay/upload",
      ]
    );
  } finally {
    if (originalApiBaseUrl === undefined) {
      delete process.env.AOE2_API_BASE_URL;
    } else {
      process.env.AOE2_API_BASE_URL = originalApiBaseUrl;
    }

    if (originalFallbackBaseUrl === undefined) {
      delete process.env.AOE2_API_FALLBACK_BASE_URL;
    } else {
      process.env.AOE2_API_FALLBACK_BASE_URL = originalFallbackBaseUrl;
    }
  }
});

test("watcher imports DE replay extensions only", () => {
  assert.deepEqual(getSupportedReplayExtensions(), [".aoe2record", ".aoe2mpgame"]);
});

test("builds conservative final watcher metadata from file observation", async (t) => {
  const filePath = await createTempReplayNamed(
    t,
    "MP Replay v101.102.999 @2026.04.22 183000.aoe2record",
    Buffer.from("final replay bytes")
  );
  const replayHash = await getReplayContentHash(filePath);
  const entry = buildEntry();

  const metadata = await buildWatcherFinalMetadata(
    filePath,
    {
      watcherUid: "watcher-test",
    },
    entry,
    {
      replayHash,
      parseIteration: 3,
    }
  );

  assert.equal(metadata.schema, "aoe2dewarwagers.watcher_final_metadata.v2");
  assert.equal(metadata.version, 2);
  assert.equal(metadata.replay_hash, replayHash);
  assert.equal(metadata.filename, path.basename(filePath));
  assert.equal(metadata.session_id, entry.sessionId);
  assert.equal(metadata.started_at, new Date(2026, 3, 22, 18, 30, 0).toISOString());
  assert.equal(metadata.parse_iteration, 3);
  assert.deepEqual(metadata.players, []);
  assert.equal(metadata.player_count, null);
  assert.equal(metadata.winner.reliable, false);
  assert.equal(metadata.trust.trusted_player_data, false);
  assert.equal(metadata.trust.replay_parser, false);
  assert.equal(metadata.trust.bet_arming_eligible, false);
  assert.equal(metadata.game_version.value, "101.102.999");
  assert.equal(metadata.game_version.source, "replay_filename");
  assert.deepEqual(metadata.metadata_sources, [
    "watcher_file_observation",
    "replay_filename_version",
  ]);
});

test("enriches final metadata from DE runtime context without inventing roster truth", async (t) => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "aoe2de-runtime-"));
  t.after(async () => {
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  const driveRoot = path.join(
    tempHome,
    "Library",
    "Application Support",
    "CrossOver",
    "Bottles",
    "Steam",
    "drive_c"
  );
  const deRoot = path.join(
    driveRoot,
    "users",
    "crossover",
    "Games",
    "Age of Empires 2 DE"
  );
  const savegameDir = await mkdirp(path.join(deRoot, "76561198065420384", "savegame"));
  const logsDir = await mkdirp(path.join(deRoot, "logs"));
  await fs.writeFile(
    path.join(logsDir, "Age2SessionData.txt"),
    [
      "PlayerSessionID = rW3tBeqIJ0iJqmrmXcheQg==",
      "Version = 101.103.39862.0 #(170934)",
      "Config = Retail",
      "Stream = release_build_machine",
    ].join("\n"),
    "utf8"
  );

  const mainLogDir = await mkdirp(path.join(logsDir, "2026.04.22-1830.00"));
  await fs.writeFile(
    path.join(mainLogDir, "MainLog.txt"),
    [
      "[rlink - error] 2026/04/23 00:45:12.315 (UTC) SteamLobbyList::RemoveLobby: Attempt to remove nonexistent lobby; sessionId=472207598",
      "[rlink - error] 2026/04/23 00:45:12.805 (UTC) SteamLobbyList::RemoveLobby: Attempt to remove nonexistent lobby; sessionId=472207557",
    ].join("\n"),
    "utf8"
  );

  const steamConfigDir = await mkdirp(
    path.join(driveRoot, "Program Files (x86)", "Steam", "config")
  );
  await fs.writeFile(
    path.join(steamConfigDir, "loginusers.vdf"),
    [
      '"users"',
      "{",
      '  "76561198065420384"',
      "  {",
      '    "AccountName" "private-account-name"',
      '    "PersonaName" "Emaren"',
      "  }",
      "}",
    ].join("\n"),
    "utf8"
  );

  const filePath = path.join(
    savegameDir,
    "MP Replay v101.103.39862.0 @2026.04.22 183000.aoe2record"
  );
  await fs.writeFile(filePath, Buffer.from("runtime replay"));
  const replayEndedAt = new Date(2026, 3, 22, 19, 5, 0);
  await fs.utimes(filePath, replayEndedAt, replayEndedAt);

  const replayHash = await getReplayContentHash(filePath);
  const metadata = await buildWatcherFinalMetadata(
    filePath,
    {
      watcherUid: "watcher-test",
    },
    buildEntry(),
    {
      replayHash,
      parseIteration: 4,
    }
  );

  assert.equal(metadata.schema, "aoe2dewarwagers.watcher_final_metadata.v2");
  assert.equal(metadata.version, 2);
  assert.equal(metadata.lobby_id, null);
  assert.deepEqual(metadata.players, []);
  assert.equal(metadata.player_count, null);
  assert.equal(metadata.local_player.steam64, "76561198065420384");
  assert.equal(metadata.local_player.persona_name, "Emaren");
  assert.equal(metadata.local_player.source, "steam_loginusers");
  assert.equal(metadata.de_runtime.profile_id, "76561198065420384");
  assert.equal(metadata.de_runtime.player_session_id, "rW3tBeqIJ0iJqmrmXcheQg==");
  assert.equal(metadata.game_version.value, "101.103.39862.0");
  assert.equal(metadata.game_version.build, "170934");
  assert.equal(metadata.game_version.source, "Age2SessionData.txt");
  assert.equal(metadata.candidate_lobby_ids.length, 2);
  assert.deepEqual(
    metadata.candidate_lobby_ids.map((candidate) => ({
      id: candidate.id,
      confidence: candidate.confidence,
      source: candidate.source,
    })),
    [
      { id: "472207598", confidence: "low", source: "de_mainlog" },
      { id: "472207557", confidence: "low", source: "de_mainlog" },
    ]
  );
  assert.equal(metadata.trust.de_runtime_context, true);
  assert.equal(metadata.trust.local_player_identity, true);
  assert.equal(metadata.trust.candidate_lobby_id, false);
  assert.equal(metadata.trust.trusted_player_data, false);
  assert.equal(metadata.trust.winner, false);
  assert.equal(metadata.trust.replay_parser, false);
  assert.equal(metadata.trust.bet_arming_eligible, false);
  assert.ok(metadata.metadata_sources.includes("de_profile_context"));
  assert.ok(metadata.metadata_sources.includes("de_session_data"));
  assert.ok(metadata.metadata_sources.includes("steam_loginusers"));
  assert.ok(metadata.metadata_sources.includes("de_log_candidate_lobby"));
});

test("merges explicit local metadata sidecar without claiming bet eligibility", async (t) => {
  const filePath = await createTempReplayNamed(
    t,
    "sidecar-test.aoe2record",
    Buffer.from("sidecar replay")
  );
  const sidecarPath = `${filePath}.metadata.json`;
  await fs.writeFile(
    sidecarPath,
    JSON.stringify({
      session_id: "local-session",
      lobby_id: "lobby-42",
      started_at: "2026-04-22T18:30:00Z",
      ended_at: "2026-04-22T19:00:00Z",
      players: [
        { name: "Emaren", civ: "Britons", color: "Blue", team: 1 },
        { name: "Sniper", civ: "Franks", color: "Red", team: 2 },
      ],
      map: { name: "Arabia", size: "Tiny" },
      mode: "Random Map",
      rated: true,
      winner: { name: "Emaren", reliable: true },
      trust: { trusted_player_data: true, winner: true },
    }),
    "utf8"
  );

  const replayHash = await getReplayContentHash(filePath);
  const metadata = await buildWatcherFinalMetadata(
    filePath,
    {
      watcherUid: "watcher-test",
    },
    buildEntry(),
    {
      replayHash,
      parseIteration: 1,
    }
  );

  assert.equal(findWatcherMetadataSidecarPath(filePath), sidecarPath);
  assert.equal(metadata.session_id, "local-session");
  assert.equal(metadata.lobby_id, "lobby-42");
  assert.equal(metadata.player_count, 2);
  assert.equal(metadata.players[0].name, "Emaren");
  assert.equal(metadata.players[0].civ, "Britons");
  assert.equal(metadata.map.name, "Arabia");
  assert.equal(metadata.winner.name, "Emaren");
  assert.equal(metadata.winner.reliable, true);
  assert.equal(metadata.trust.trusted_player_data, true);
  assert.equal(metadata.trust.winner, true);
  assert.equal(metadata.trust.replay_parser, false);
  assert.equal(metadata.trust.bet_arming_eligible, false);
  assert.deepEqual(metadata.metadata_sources, [
    "watcher_file_observation",
    "local_metadata_sidecar",
  ]);
});

test("short-circuits when the replay fingerprint is already settled", async (t) => {
  const filePath = await createTempReplay(t, Buffer.from("settled replay"));
  const fingerprint = await getFileFingerprint(filePath);
  const entry = buildEntry({
    lastObservedFingerprint: fingerprint,
    lastFinalUploadedFingerprint: fingerprint,
    lastFinalUploadAt: Date.now() - 120000,
  });

  const result = await resolveFinalReplayShortCircuit(filePath, entry, {
    finalSettleWindowMs: 90000,
  });

  assert.deepEqual(result, {
    reason: "settled_fingerprint",
    fingerprint,
  });
});

test("short-circuits when a touched replay still matches the prior final replay hash", async (t) => {
  const filePath = await createTempReplay(t, Buffer.from("same final replay bytes"));
  const originalFingerprint = await getFileFingerprint(filePath);
  const replayHash = await getReplayContentHash(filePath);

  const touchedAt = new Date(Date.now() + 3000);
  await fs.utimes(filePath, touchedAt, touchedAt);
  const touchedFingerprint = await getFileFingerprint(filePath);

  assert.notEqual(touchedFingerprint, originalFingerprint);

  const entry = buildEntry({
    lastObservedFingerprint: originalFingerprint,
    lastFinalUploadedFingerprint: originalFingerprint,
    lastFinalReplayHash: replayHash,
    lastFinalUploadAt: Date.now(),
  });

  const result = await resolveFinalReplayShortCircuit(filePath, entry, {
    finalSettleWindowMs: 90000,
  });

  assert.equal(result?.reason, "settled_replay_hash");
  assert.equal(result?.replayHash, replayHash);
  assert.equal(entry.lastObservedFingerprint, touchedFingerprint);
  assert.equal(entry.lastFinalUploadedFingerprint, touchedFingerprint);
});

test("does not short-circuit when the replay bytes changed after final upload", async (t) => {
  const filePath = await createTempReplay(t, Buffer.from("original final replay"));
  const originalFingerprint = await getFileFingerprint(filePath);
  const replayHash = await getReplayContentHash(filePath);

  await fs.writeFile(filePath, Buffer.from("mutated replay after final"));
  const entry = buildEntry({
    lastObservedFingerprint: originalFingerprint,
    lastFinalUploadedFingerprint: originalFingerprint,
    lastFinalReplayHash: replayHash,
    lastFinalUploadAt: Date.now(),
  });

  const result = await resolveFinalReplayShortCircuit(filePath, entry, {
    finalSettleWindowMs: 90000,
  });

  assert.equal(result, null);
});
