const fs = require("node:fs/promises");
const path = require("node:path");

const LIVE_TRACE_ROOT =
  process.env.LIVE_TRACE_DIR ||
  path.join(__dirname, "..", ".runtime", "live_sessions");
const LIVE_TRACE_STALE_MS = Number(
  process.env.LIVE_TRACE_STALE_MS || 10 * 60 * 1000,
);

const activeSessions = new Map();
let signalHandlersInstalled = false;

function sanitizeSegment(value, fallback = "unknown") {
  const normalized = String(value || fallback).replace(/[^a-zA-Z0-9_.-]/g, "_");
  return normalized || fallback;
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value || null));
}

function getDatabaseDir(databaseName) {
  return path.join(LIVE_TRACE_ROOT, sanitizeSegment(databaseName, "unknown_db"));
}

function getSessionFilePath(databaseName, sessionId) {
  return path.join(
    getDatabaseDir(databaseName),
    `${sanitizeSegment(sessionId, "session")}.json`,
  );
}

async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function writeJsonAtomic(filePath, payload) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

async function saveLiveSessionSnapshot(snapshot) {
  if (!snapshot?.database || !snapshot?.sessionId) {
    throw new Error("Live session snapshot requires database and sessionId.");
  }

  const filePath = getSessionFilePath(snapshot.database, snapshot.sessionId);
  const payload = {
    ...clonePlain(snapshot),
    updatedAt: new Date().toISOString(),
  };

  await ensureParentDir(filePath);
  await writeJsonAtomic(filePath, payload);

  return filePath;
}

async function removeLiveSessionSnapshot(databaseName, sessionId) {
  const filePath = getSessionFilePath(databaseName, sessionId);
  await fs.rm(filePath, { force: true });
}

async function listLiveSessions(databaseName) {
  const directory = getDatabaseDir(databaseName);

  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const sessions = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const filePath = path.join(directory, entry.name);

      try {
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);
        sessions.push(normalizeLiveSession(parsed));
      } catch {
        // Ignore malformed live trace files instead of breaking the viewer.
      }
    }

    return sessions.sort((left, right) => {
      const leftTime = Date.parse(left.latestActivityAt || left.updatedAt || left.startedAt || 0);
      const rightTime = Date.parse(
        right.latestActivityAt || right.updatedAt || right.startedAt || 0,
      );
      return rightTime - leftTime;
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function buildLiveRequestId(sessionId, requestOrder) {
  return `${sessionId}:${requestOrder}`;
}

function normalizeLiveSession(session) {
  const requests = Array.isArray(session?.requests)
    ? session.requests.map((request) => ({
        ...request,
        liveRequestId:
          request.liveRequestId ||
          buildLiveRequestId(session.sessionId, request.requestOrder || "0"),
      }))
    : [];

  const latestRequest = requests
    .slice()
    .sort((left, right) => {
      const leftTime = Date.parse(
        left.finishedAt || left.updatedAt || left.startedAt || session?.startedAt || 0,
      );
      const rightTime = Date.parse(
        right.finishedAt || right.updatedAt || right.startedAt || session?.startedAt || 0,
      );
      return rightTime - leftTime;
    })[0] || null;

  const completedRequests = requests.filter(
    (request) => request.status === "completed",
  ).length;
  const latestActivityAt =
    latestRequest?.finishedAt ||
    latestRequest?.updatedAt ||
    latestRequest?.startedAt ||
    session?.updatedAt ||
    session?.startedAt ||
    null;

  let status = session?.status || "running";
  const latestTimestamp = Date.parse(latestActivityAt || 0);

  if (
    status === "running" &&
    Number.isFinite(latestTimestamp) &&
    Date.now() - latestTimestamp > LIVE_TRACE_STALE_MS
  ) {
    status = "abandoned";
  }

  return {
    ...session,
    status,
    requests,
    latestRequest,
    completedRequests,
    latestActivityAt,
  };
}

async function persistActiveSessionsForSignal(signal) {
  const now = new Date().toISOString();

  await Promise.all(
    [...activeSessions.values()].map(async (getSnapshot) => {
      try {
        const snapshot = clonePlain(getSnapshot());
        if (!snapshot?.database || !snapshot?.sessionId) {
          return;
        }

        snapshot.status = "aborted";
        snapshot.finishedAt = now;
        snapshot.errorMessage = `Process interrupted by ${signal}.`;
        snapshot.requests = Array.isArray(snapshot.requests)
          ? snapshot.requests.map((request) => {
              if (request.status === "completed" || request.status === "failed") {
                return request;
              }

              return {
                ...request,
                status: "aborted",
                finishedAt: now,
                errorMessage: `Process interrupted by ${signal}.`,
              };
            })
          : [];

        await saveLiveSessionSnapshot(snapshot);
      } catch {
        // Best effort only during process shutdown.
      }
    }),
  );
}

function installSignalHandlers() {
  if (signalHandlersInstalled) {
    return;
  }

  signalHandlersInstalled = true;

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
      await persistActiveSessionsForSignal(signal);
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

function registerActiveLiveSession(key, getSnapshot) {
  installSignalHandlers();
  activeSessions.set(key, getSnapshot);
}

function unregisterActiveLiveSession(key) {
  activeSessions.delete(key);
}

module.exports = {
  LIVE_TRACE_ROOT,
  buildLiveRequestId,
  getSessionFilePath,
  listLiveSessions,
  normalizeLiveSession,
  registerActiveLiveSession,
  removeLiveSessionSnapshot,
  saveLiveSessionSnapshot,
  unregisterActiveLiveSession,
};
