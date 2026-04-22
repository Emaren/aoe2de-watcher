const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildRuntimeConfig,
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
