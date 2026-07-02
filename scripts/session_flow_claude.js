const path = require("node:path");
const Anthropic = require("@anthropic-ai/sdk");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const {
  RUN_NOTES,
  createDbClient,
  sleep,
  getAllProfiles,
  getInterestGroupRows,
  getProfile,
  getTravelInterests,
  buildGeneralPrompt,
  buildConstraintPrompt,
  buildComparisonPrompt,
  createSessionId,
  toPlainJson,
  addTrace,
  saveSessionRun,
  updateSessionRunStatus,
  saveGeneralPromptAnswer,
  saveConstraintPromptAnswer,
  saveComparisonPromptAnswer,
  saveRequestLogEntry,
} = require("./session_shared");
const {
  buildLiveRequestId,
  registerActiveLiveSession,
  removeLiveSessionSnapshot,
  saveLiveSessionSnapshot,
  unregisterActiveLiveSession,
} = require("./live_trace_store");

const MODEL_NAME = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const PROVIDER_NAME = "anthropic";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 300000);
const MAX_API_RETRIES = Number(process.env.MAX_API_RETRIES || 4);
const RETRY_BASE_DELAY_MS = Number(process.env.RETRY_BASE_DELAY_MS || 2000);
const TOP_P = Number(process.env.ANTHROPIC_TOP_P || process.env.TOP_P || 0.98);
const ANTHROPIC_EFFORT = process.env.ANTHROPIC_EFFORT || "medium";
const ENABLE_THINKING = ["1", "true", "yes", "on"].includes(
  String(process.env.ANTHROPIC_ENABLE_THINKING || "false").toLowerCase(),
);
const MAX_TOOL_CALLS = Number(
  process.env.ANTHROPIC_MAX_TOOL_CALLS || process.env.MAX_TOOL_CALLS || 6,
);
const WEB_SEARCH_COUNTRY =
  process.env.ANTHROPIC_WEB_SEARCH_COUNTRY ||
  process.env.WEB_SEARCH_COUNTRY ||
  "DE";
const WEB_SEARCH_TIMEZONE =
  process.env.ANTHROPIC_WEB_SEARCH_TIMEZONE ||
  process.env.WEB_SEARCH_TIMEZONE ||
  "Europe/Berlin";
const WEB_SEARCH_CITY =
  process.env.ANTHROPIC_WEB_SEARCH_CITY || process.env.WEB_SEARCH_CITY || null;
const ANTHROPIC_MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS || 4096);
const MAX_PAUSE_TURNS = Number(
  process.env.ANTHROPIC_MAX_PAUSE_TURNS || Math.max(MAX_TOOL_CALLS, 2),
);
const MAX_PROVIDER_EVENTS_PER_REQUEST = Number(
  process.env.ANTHROPIC_MAX_PROVIDER_EVENTS_PER_REQUEST || MAX_PAUSE_TURNS + 1,
);
const MAX_TOTAL_INPUT_TOKENS_PER_REQUEST = Number(
  process.env.ANTHROPIC_MAX_TOTAL_INPUT_TOKENS_PER_REQUEST || 0,
);
const MAX_TOTAL_OUTPUT_TOKENS_PER_REQUEST = Number(
  process.env.ANTHROPIC_MAX_TOTAL_OUTPUT_TOKENS_PER_REQUEST || 0,
);
const MAX_CONSECUTIVE_LOW_OUTPUT_PAUSE_TURNS = Number(
  process.env.ANTHROPIC_MAX_CONSECUTIVE_LOW_OUTPUT_PAUSE_TURNS || 3,
);
const LOW_OUTPUT_TOKEN_THRESHOLD = Number(
  process.env.ANTHROPIC_LOW_OUTPUT_TOKEN_THRESHOLD || 250,
);
const LOW_OUTPUT_TEXT_THRESHOLD = Number(
  process.env.ANTHROPIC_LOW_OUTPUT_TEXT_THRESHOLD || 80,
);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  throw new Error("Missing ANTHROPIC_API_KEY. Add it to .env");
}

const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
  maxRetries: 0,
});

function buildWebSearchTool() {
  return {
    type: "web_search_20260209",
    name: "web_search",
    max_uses: MAX_TOOL_CALLS,
    user_location: {
      type: "approximate",
      country: WEB_SEARCH_COUNTRY,
      timezone: WEB_SEARCH_TIMEZONE,
      ...(WEB_SEARCH_CITY ? { city: WEB_SEARCH_CITY } : {}),
    },
  };
}

function cloneClaudeMessages(messages) {
  return messages.map((message) => ({
    ...message,
    content:
      typeof message.content === "string"
        ? message.content
        : toPlainJson(message.content),
  }));
}

function getAssistantText(completion) {
  const textParts = [];

  for (const contentItem of completion?.content || []) {
    if (contentItem?.type === "text" && contentItem.text) {
      textParts.push(contentItem.text);
    }
  }

  return textParts.join("\n\n") || "(No text returned)";
}

function ensureUsableCompletion(completion, answerText) {
  const trimmedAnswer = typeof answerText === "string" ? answerText.trim() : "";

  if (!trimmedAnswer || trimmedAnswer === "(No text returned)") {
    throw new Error("Claude returned an empty response.");
  }

  for (const contentItem of completion?.content || []) {
    if (typeof contentItem?.type === "string" && contentItem.type.includes("error")) {
      throw new Error(
        contentItem.message ||
          contentItem.error?.message ||
          "Claude web search returned a tool error.",
      );
    }
  }
}

function addSource(sourcesByKey, source, origin) {
  if (!source) {
    return;
  }

  const key = source.url || source.title;

  if (!key) {
    return;
  }

  const existing = sourcesByKey.get(key);

  if (existing) {
    if (!existing.origins.includes(origin)) {
      existing.origins.push(origin);
    }
    return;
  }

  sourcesByKey.set(key, { ...source, origins: [origin] });
}

function collectSourceCandidates(value, origin, sourcesByKey) {
  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectSourceCandidates(item, origin, sourcesByKey));
    return;
  }

  if (typeof value.url === "string" || typeof value.title === "string") {
    addSource(
      sourcesByKey,
      {
        title: value.title || null,
        url: value.url || null,
      },
      origin,
    );
  }

  for (const nestedValue of Object.values(value)) {
    collectSourceCandidates(nestedValue, origin, sourcesByKey);
  }
}

function extractWebSources(completion) {
  const sourcesByKey = new Map();

  for (const contentItem of completion?.content || []) {
    if (contentItem?.type === "text" && Array.isArray(contentItem.citations)) {
      collectSourceCandidates(contentItem.citations, "citation", sourcesByKey);
    }

    if (typeof contentItem?.type === "string" && contentItem.type.includes("search")) {
      collectSourceCandidates(contentItem, "search", sourcesByKey);
    }
  }

  return [...sourcesByKey.values()];
}

function getProviderRequestId(completion) {
  return completion?._request_id || completion?.request_id || null;
}

function getUsage(completion) {
  return completion?.usage || null;
}

function buildResponseMeta(completion) {
  return {
    id: completion?.id || null,
    model: completion?.model || MODEL_NAME,
    stopReason: completion?.stop_reason || null,
    usage: completion?.usage || null,
  };
}

function buildLiveParams() {
  return {
    model: MODEL_NAME,
    topP: TOP_P,
    maxTokens: ANTHROPIC_MAX_TOKENS,
    maxToolCalls: MAX_TOOL_CALLS,
    maxPauseTurns: MAX_PAUSE_TURNS,
    maxProviderEventsPerRequest: MAX_PROVIDER_EVENTS_PER_REQUEST,
    maxTotalInputTokensPerRequest:
      MAX_TOTAL_INPUT_TOKENS_PER_REQUEST > 0
        ? MAX_TOTAL_INPUT_TOKENS_PER_REQUEST
        : null,
    maxTotalOutputTokensPerRequest:
      MAX_TOTAL_OUTPUT_TOKENS_PER_REQUEST > 0
        ? MAX_TOTAL_OUTPUT_TOKENS_PER_REQUEST
        : null,
    maxConsecutiveLowOutputPauseTurns: MAX_CONSECUTIVE_LOW_OUTPUT_PAUSE_TURNS,
    lowOutputTokenThreshold: LOW_OUTPUT_TOKEN_THRESHOLD,
    lowOutputTextThreshold: LOW_OUTPUT_TEXT_THRESHOLD,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    maxApiRetries: MAX_API_RETRIES,
    retryBaseDelayMs: RETRY_BASE_DELAY_MS,
    enableThinking: ENABLE_THINKING,
    effort: ENABLE_THINKING ? ANTHROPIC_EFFORT : null,
    thinkingMode: ENABLE_THINKING ? "adaptive" : null,
    toolChoice: ENABLE_THINKING ? "auto" : "forced_web_search",
    webSearchCountry: WEB_SEARCH_COUNTRY,
    webSearchTimezone: WEB_SEARCH_TIMEZONE,
    webSearchCity: WEB_SEARCH_CITY,
  };
}

async function getCurrentDatabaseName(dbClient) {
  const result = await dbClient.query("SELECT current_database() AS database_name");
  return result.rows[0]?.database_name || process.env.PGDATABASE || "unknown_database";
}

async function saveCompletedRequestLogs(dbClient, requestLogs, sessionId) {
  if (!Array.isArray(requestLogs) || !requestLogs.length) {
    return;
  }

  try {
    await dbClient.query("BEGIN");

    for (const requestLog of requestLogs) {
      await saveRequestLogEntry(dbClient, requestLog);
    }

    await dbClient.query("COMMIT");
  } catch (error) {
    try {
      await dbClient.query("ROLLBACK");
    } catch {
      // Ignore secondary rollback failures while preserving the committed session.
    }

    console.warn(
      `request_logs post-commit save failed for session ${sessionId}: ${error.message}`,
    );
  }
}

function buildRequestPayload(messages) {
  const payload = {
    model: MODEL_NAME,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    top_p: TOP_P,
    messages,
    tools: [buildWebSearchTool()],
  };

  if (ENABLE_THINKING) {
    payload.thinking = { type: "adaptive" };
    payload.output_config = { effort: ANTHROPIC_EFFORT };
    payload.tool_choice = { type: "auto" };
  } else {
    payload.tool_choice = { type: "tool", name: "web_search" };
  }

  return payload;
}

async function createClaudeMessage(messages) {
  let attempt = 0;

  while (true) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      return await anthropic.messages.create(
        buildRequestPayload(messages),
        {
          signal: controller.signal,
        },
      );
    } catch (error) {
      const status = error?.status || error?.response?.status;
      const code = error?.code;
      const message = error?.message || String(error);
      const retryable =
        status === 408 ||
        status === 409 ||
        status === 429 ||
        status >= 500 ||
        code === "ECONNRESET" ||
        code === "ETIMEDOUT" ||
        code === "UND_ERR_CONNECT_TIMEOUT" ||
        code === "ABORT_ERR";

      if (!retryable || attempt >= MAX_API_RETRIES) {
        throw error;
      }

      const delayMs =
        RETRY_BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 500);

      console.warn(
        `Retrying Claude call after error (attempt ${attempt + 1}/${MAX_API_RETRIES}, delay ${delayMs}ms): ${message}`,
      );

      attempt += 1;
      await sleep(delayMs);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function validateStopReason(completion) {
  if (completion?.stop_reason === "max_tokens") {
    throw new Error(
      `Claude hit max_tokens before finishing the answer. Increase ANTHROPIC_MAX_TOKENS above ${ANTHROPIC_MAX_TOKENS}.`,
    );
  }

  if (completion?.stop_reason === "refusal") {
    throw new Error("Claude refused the request.");
  }

  if (
    completion?.stop_reason &&
    completion.stop_reason !== "end_turn" &&
    completion.stop_reason !== "pause_turn"
  ) {
    throw new Error(`Claude returned unsupported stop_reason=${completion.stop_reason}`);
  }
}

async function runChat(messages, options = {}) {
  const conversation = cloneClaudeMessages(messages);
  const providerEvents = [];
  let pauseTurnCount = 0;
  let cumulativeInputTokens = 0;
  let cumulativeOutputTokens = 0;
  let consecutiveLowOutputPauseTurns = 0;
  const onProviderEvent =
    typeof options.onProviderEvent === "function" ? options.onProviderEvent : null;

  while (true) {
    try {
      const completion = await createClaudeMessage(conversation);
      const usage = getUsage(completion);
      const inputTokens = Number(usage?.input_tokens || 0);
      const outputTokens = Number(usage?.output_tokens || 0);
      const assistantText = getAssistantText(completion);
      const assistantTextLength =
        assistantText && assistantText !== "(No text returned)"
          ? assistantText.trim().length
          : 0;
      const stopReason = completion?.stop_reason || null;
      const isLowOutputPauseTurn =
        stopReason === "pause_turn" &&
        outputTokens <= LOW_OUTPUT_TOKEN_THRESHOLD &&
        assistantTextLength <= LOW_OUTPUT_TEXT_THRESHOLD;

      cumulativeInputTokens += inputTokens;
      cumulativeOutputTokens += outputTokens;
      consecutiveLowOutputPauseTurns = isLowOutputPauseTurn
        ? consecutiveLowOutputPauseTurns + 1
        : 0;

      const providerEvent = {
        sequence: providerEvents.length + 1,
        providerRequestId: getProviderRequestId(completion),
        completionId: completion?.id || null,
        stopReason,
        usage,
        inputTokens,
        outputTokens,
        cumulativeInputTokens,
        cumulativeOutputTokens,
        assistantTextLength,
        pauseTurnCount,
        lowOutputPauseTurn: isLowOutputPauseTurn,
        consecutiveLowOutputPauseTurns,
        createdAt: new Date().toISOString(),
      };
      providerEvents.push(providerEvent);
      if (onProviderEvent) {
        onProviderEvent(providerEvent);
      }

      validateStopReason(completion);

      if (providerEvents.length > MAX_PROVIDER_EVENTS_PER_REQUEST) {
        throw new Error(
          `Claude exceeded ANTHROPIC_MAX_PROVIDER_EVENTS_PER_REQUEST=${MAX_PROVIDER_EVENTS_PER_REQUEST} while completing one logical prompt.`,
        );
      }

      if (
        MAX_TOTAL_INPUT_TOKENS_PER_REQUEST > 0 &&
        cumulativeInputTokens > MAX_TOTAL_INPUT_TOKENS_PER_REQUEST
      ) {
        throw new Error(
          `Claude exceeded ANTHROPIC_MAX_TOTAL_INPUT_TOKENS_PER_REQUEST=${MAX_TOTAL_INPUT_TOKENS_PER_REQUEST} while completing one logical prompt.`,
        );
      }

      if (
        MAX_TOTAL_OUTPUT_TOKENS_PER_REQUEST > 0 &&
        cumulativeOutputTokens > MAX_TOTAL_OUTPUT_TOKENS_PER_REQUEST
      ) {
        throw new Error(
          `Claude exceeded ANTHROPIC_MAX_TOTAL_OUTPUT_TOKENS_PER_REQUEST=${MAX_TOTAL_OUTPUT_TOKENS_PER_REQUEST} while completing one logical prompt.`,
        );
      }

      if (completion?.stop_reason === "pause_turn") {
        pauseTurnCount += 1;

        if (pauseTurnCount > MAX_PAUSE_TURNS) {
          throw new Error(
            `Claude exceeded ANTHROPIC_MAX_PAUSE_TURNS=${MAX_PAUSE_TURNS} while continuing web search.`,
          );
        }

        if (
          consecutiveLowOutputPauseTurns >= MAX_CONSECUTIVE_LOW_OUTPUT_PAUSE_TURNS
        ) {
          throw new Error(
            `Claude exceeded ANTHROPIC_MAX_CONSECUTIVE_LOW_OUTPUT_PAUSE_TURNS=${MAX_CONSECUTIVE_LOW_OUTPUT_PAUSE_TURNS} with repeated low-value pause_turn continuations.`,
          );
        }

        conversation.push({
          role: "assistant",
          content: toPlainJson(completion.content),
        });
        continue;
      }

      return {
        completion,
        providerEvents,
      };
    } catch (error) {
      error.providerEvents = providerEvents;
      throw error;
    }
  }
}

async function executeLoggedClaudeRequest({
  sessionId,
  profileData,
  interestGroupId,
  interestRow = null,
  requestOrder,
  requestKind,
  branchLabel,
  repeatIndex,
  promptText,
  messageHistory,
  onProviderEvent,
}) {
  const requestStartedAt = new Date().toISOString();
  const liveProviderEvents = [];

  try {
    const {
      completion,
      providerEvents,
    } = await runChat(messageHistory, {
      onProviderEvent: (providerEvent) => {
        liveProviderEvents.push(providerEvent);

        if (onProviderEvent) {
          onProviderEvent({
            ...providerEvent,
            requestKind,
            branchLabel,
          });
        }
      },
    });
    const requestFinishedAt = new Date().toISOString();
    const answer = getAssistantText(completion);
    ensureUsableCompletion(completion, answer);
    const sources = extractWebSources(completion);
    const requestLog = {
      sessionId,
      profileId: profileData.profile_id,
      interestGroupId,
      interestId: interestRow?.interest_id || null,
      requestOrder,
      requestKind,
      branchLabel,
      seasonName: interestRow?.season_name || null,
      travelTimeFrame: interestRow?.travel_time_frame || null,
      repeatIndex,
      destinationName: profileData.destination_name,
      providerName: PROVIDER_NAME,
      modelName: MODEL_NAME,
      status: "completed",
      promptText,
      messageHistory,
      completionId: completion.id,
      providerRequestId: getProviderRequestId(completion),
      answerText: answer,
      sources,
      usage: getUsage(completion),
      responseMeta: {
        ...buildResponseMeta(completion),
        providerEvents,
      },
      startedAt: requestStartedAt,
      finishedAt: requestFinishedAt,
    };

    return {
      completion,
      answer,
      sources,
      providerEvents,
      requestLog,
    };
  } catch (error) {
    throw error;
  }
}

async function runSession(options = {}) {
  const profileId = Number(options.profileId || 1);
  const followUpLimit = Number(options.followUpLimit || 4);
  const interestType = options.interestType || null;
  const repeatIndex = Number(options.repeatIndex || 1);
  const saveToDb = Boolean(options.saveToDb);
  const onProgress =
    typeof options.onProgress === "function" ? options.onProgress : null;
  const dbClient = createDbClient();
  let emitProgress = () => {};
  let profileData = null;
  let interestGroupId = null;
  let sessionId = null;
  let currentDatabase = null;
  let transactionStarted = false;
  let liveSession = null;
  let liveSessionKey = null;
  let liveWriteChain = Promise.resolve();
  let queueLiveSessionWrite = () => Promise.resolve();

  await dbClient.connect();

  try {
    currentDatabase = await getCurrentDatabaseName(dbClient);

    emitProgress = (step, extra = {}) => {
      if (!onProgress) {
        return;
      }

      onProgress({
        step,
        profileId,
        repeatIndex,
        sessionId,
        interestType,
        ...extra,
      });
    };

    profileData = await getProfile(dbClient, profileId);
    const travelInterests = await getTravelInterests(dbClient, {
      interestType,
      limit: followUpLimit,
    });

    if (!travelInterests.length) {
      throw new Error(
        `No travel interests found for interestType=${interestType || "(any)"}`,
      );
    }

    interestGroupId = travelInterests[0].interest_group_id;
    sessionId = createSessionId(
      profileData.profile_id,
      interestGroupId,
      repeatIndex,
    );

    queueLiveSessionWrite = () => {
      if (!liveSession) {
        return Promise.resolve();
      }

      liveWriteChain = liveWriteChain
        .catch(() => {})
        .then(() => saveLiveSessionSnapshot(liveSession))
        .catch((error) => {
          console.warn(
            `Live trace write failed for session ${sessionId}: ${error.message}`,
          );
        });

      return liveWriteChain;
    };

    liveSession = {
      database: currentDatabase,
      sessionId,
      providerName: PROVIDER_NAME,
      modelName: MODEL_NAME,
      runNotes: RUN_NOTES,
      saveToDb,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      errorMessage: null,
      promptTarget: travelInterests.length + 2,
      params: buildLiveParams(),
      profileId: profileData.profile_id,
      profileName: profileData.profile_name,
      age: profileData.age,
      gender: profileData.gender,
      travelParty: profileData.travel_party,
      stayNights: profileData.stay_nights,
      budgetPerDayEur: profileData.budget_per_day_eur,
      destinationName: profileData.destination_name,
      interestGroupId,
      interestType: travelInterests[0].interest_type,
      repeatIndex,
      requests: [],
    };
    liveSessionKey = `${currentDatabase}:${sessionId}`;
    registerActiveLiveSession(liveSessionKey, () => liveSession);
    await queueLiveSessionWrite();

    if (saveToDb) {
      await dbClient.query("BEGIN");
      transactionStarted = true;
      await saveSessionRun(
        dbClient,
        profileData,
        sessionId,
        interestGroupId,
        repeatIndex,
        PROVIDER_NAME,
        MODEL_NAME,
        "running",
      );
    }

    const messages = [];
    const trace = [];
    const requestLogs = [];
    let requestOrder = 1;

    addTrace(trace, "Start: empty messages array", messages);

    const generalPrompt = buildGeneralPrompt(profileData);
    messages.push({ role: "user", content: generalPrompt });
    addTrace(trace, "General prompt appended", messages);
    emitProgress("general_started");

    const liveGeneralRequest = {
      liveRequestId: buildLiveRequestId(sessionId, requestOrder),
      requestOrder,
      requestKind: "general",
      branchLabel: "General prompt",
      seasonName: null,
      travelTimeFrame: null,
      promptText: generalPrompt,
      messageHistory: cloneClaudeMessages(messages),
      status: "started",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      providerRequestId: null,
      completionId: null,
      usage: null,
      answerText: null,
      errorMessage: null,
      sources: [],
      responseMeta: null,
      providerEvents: [],
    };
    liveSession.requests.push(liveGeneralRequest);
    void queueLiveSessionWrite();

    let generalCompletion;
    let generalAnswer;
    let generalSources;
    let generalRequestLog;

    try {
      ({
        completion: generalCompletion,
        answer: generalAnswer,
        sources: generalSources,
        requestLog: generalRequestLog,
      } = await executeLoggedClaudeRequest({
        sessionId,
        profileData,
        interestGroupId,
        requestOrder,
        requestKind: "general",
        branchLabel: "General prompt",
        repeatIndex,
        promptText: generalPrompt,
        messageHistory: cloneClaudeMessages(messages),
        onProviderEvent: (providerEvent) => {
          liveGeneralRequest.providerRequestId =
            providerEvent.providerRequestId || liveGeneralRequest.providerRequestId;
          liveGeneralRequest.usage = providerEvent.usage || liveGeneralRequest.usage;
          liveGeneralRequest.providerEvents.push(providerEvent);
          void queueLiveSessionWrite();

          emitProgress("provider_event", {
            requestKind: "general",
            branchLabel: "General prompt",
            ...providerEvent,
          });
        },
      }));
    } catch (error) {
      liveGeneralRequest.status = "failed";
      liveGeneralRequest.finishedAt = new Date().toISOString();
      liveGeneralRequest.errorMessage = error.message;
      liveGeneralRequest.providerEvents =
        error.providerEvents || liveGeneralRequest.providerEvents;
      void queueLiveSessionWrite();
      throw error;
    }
    requestOrder += 1;
    messages.push({ role: "assistant", content: generalAnswer });
    requestLogs.push(generalRequestLog);
    liveGeneralRequest.status = "completed";
    liveGeneralRequest.finishedAt =
      generalRequestLog.finishedAt || new Date().toISOString();
    liveGeneralRequest.providerRequestId = generalRequestLog.providerRequestId;
    liveGeneralRequest.completionId = generalRequestLog.completionId;
    liveGeneralRequest.usage = generalRequestLog.usage;
    liveGeneralRequest.answerText = generalAnswer;
    liveGeneralRequest.sources = generalSources;
    liveGeneralRequest.responseMeta = generalRequestLog.responseMeta;
    liveGeneralRequest.providerEvents =
      generalRequestLog.responseMeta?.providerEvents || liveGeneralRequest.providerEvents;
    void queueLiveSessionWrite();
    addTrace(trace, "General answer appended", messages);
    emitProgress("general_completed", {
      completionId: generalCompletion.id,
    });

    if (saveToDb) {
      await saveGeneralPromptAnswer(
        dbClient,
        profileData,
        sessionId,
        repeatIndex,
        PROVIDER_NAME,
        MODEL_NAME,
        generalPrompt,
        generalAnswer,
        generalCompletion.id,
        generalSources,
      );
    }

    const baseMessages = cloneClaudeMessages(messages);
    addTrace(trace, "Base branch prepared from general answer", baseMessages);

    const followUps = [];

    for (const interestRow of travelInterests) {
      const prompt = buildConstraintPrompt(interestRow);
      const branchMessages = [
        ...cloneClaudeMessages(baseMessages),
        { role: "user", content: prompt },
      ];
      addTrace(
        trace,
        `Constraint branch prompt appended: ${interestRow.interest_type} / ${interestRow.season_name}`,
        branchMessages,
      );
      emitProgress("constraint_started", {
        interestId: interestRow.interest_id,
        interestType: interestRow.interest_type,
        seasonName: interestRow.season_name,
      });

      const liveConstraintRequest = {
        liveRequestId: buildLiveRequestId(sessionId, requestOrder),
        requestOrder,
        requestKind: "constraint",
        branchLabel: `${interestRow.interest_type} / ${interestRow.season_name}`,
        interestId: interestRow.interest_id,
        seasonName: interestRow.season_name,
        travelTimeFrame: interestRow.travel_time_frame,
        promptText: prompt,
        messageHistory: cloneClaudeMessages(branchMessages),
        status: "started",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        providerRequestId: null,
        completionId: null,
        usage: null,
        answerText: null,
        errorMessage: null,
        sources: [],
        responseMeta: null,
        providerEvents: [],
      };
      liveSession.requests.push(liveConstraintRequest);
      void queueLiveSessionWrite();

      let completion;
      let answer;
      let sources;
      let requestLog;

      try {
        ({
          completion,
          answer,
          sources,
          requestLog,
        } = await executeLoggedClaudeRequest({
          sessionId,
          profileData,
          interestGroupId,
          interestRow,
          requestOrder,
          requestKind: "constraint",
          branchLabel: `${interestRow.interest_type} / ${interestRow.season_name}`,
          repeatIndex,
          promptText: prompt,
          messageHistory: cloneClaudeMessages(branchMessages),
          onProviderEvent: (providerEvent) => {
            liveConstraintRequest.providerRequestId =
              providerEvent.providerRequestId || liveConstraintRequest.providerRequestId;
            liveConstraintRequest.usage =
              providerEvent.usage || liveConstraintRequest.usage;
            liveConstraintRequest.providerEvents.push(providerEvent);
            void queueLiveSessionWrite();

            emitProgress("provider_event", {
              interestId: interestRow.interest_id,
              interestType: interestRow.interest_type,
              seasonName: interestRow.season_name,
              ...providerEvent,
            });
          },
        }));
      } catch (error) {
        liveConstraintRequest.status = "failed";
        liveConstraintRequest.finishedAt = new Date().toISOString();
        liveConstraintRequest.errorMessage = error.message;
        liveConstraintRequest.providerEvents =
          error.providerEvents || liveConstraintRequest.providerEvents;
        void queueLiveSessionWrite();
        throw error;
      }
      requestOrder += 1;
      branchMessages.push({
        role: "assistant",
        content: answer,
      });
      requestLogs.push(requestLog);
      liveConstraintRequest.status = "completed";
      liveConstraintRequest.finishedAt =
        requestLog.finishedAt || new Date().toISOString();
      liveConstraintRequest.providerRequestId = requestLog.providerRequestId;
      liveConstraintRequest.completionId = requestLog.completionId;
      liveConstraintRequest.usage = requestLog.usage;
      liveConstraintRequest.answerText = answer;
      liveConstraintRequest.sources = sources;
      liveConstraintRequest.responseMeta = requestLog.responseMeta;
      liveConstraintRequest.providerEvents =
        requestLog.responseMeta?.providerEvents || liveConstraintRequest.providerEvents;
      void queueLiveSessionWrite();
      addTrace(
        trace,
        `Constraint branch answer appended: ${interestRow.interest_type} / ${interestRow.season_name}`,
        branchMessages,
      );
      emitProgress("constraint_completed", {
        interestId: interestRow.interest_id,
        interestType: interestRow.interest_type,
        seasonName: interestRow.season_name,
        completionId: completion.id,
      });

      if (saveToDb) {
        await saveConstraintPromptAnswer(
          dbClient,
          profileData,
          interestRow,
          sessionId,
          repeatIndex,
          PROVIDER_NAME,
          MODEL_NAME,
          prompt,
          answer,
          completion.id,
          sources,
        );
      }

      followUps.push({
        interestId: interestRow.interest_id,
        interestGroupId: interestRow.interest_group_id,
        interestType: interestRow.interest_type,
        seasonName: interestRow.season_name,
        travelTimeFrame: interestRow.travel_time_frame,
        completionId: completion.id,
        prompt,
        answer,
        sources,
        rawApiResponse: toPlainJson(completion),
      });
    }

    let comparison = null;

    if (travelInterests.length) {
      const lastInterest = travelInterests[travelInterests.length - 1];
      const prompt = buildComparisonPrompt(profileData, lastInterest);
      const comparisonMessages = [
        ...cloneClaudeMessages(baseMessages),
        { role: "user", content: prompt },
      ];
      addTrace(trace, "Comparison branch prompt appended", comparisonMessages);
      emitProgress("comparison_started");

      const liveComparisonRequest = {
        liveRequestId: buildLiveRequestId(sessionId, requestOrder),
        requestOrder,
        requestKind: "comparison",
        branchLabel: "Comparison prompt",
        interestId: lastInterest.interest_id,
        seasonName: null,
        travelTimeFrame: null,
        promptText: prompt,
        messageHistory: cloneClaudeMessages(comparisonMessages),
        status: "started",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        providerRequestId: null,
        completionId: null,
        usage: null,
        answerText: null,
        errorMessage: null,
        sources: [],
        responseMeta: null,
        providerEvents: [],
      };
      liveSession.requests.push(liveComparisonRequest);
      void queueLiveSessionWrite();

      let completion;
      let answer;
      let sources;
      let requestLog;

      try {
        ({
          completion,
          answer,
          sources,
          requestLog,
        } = await executeLoggedClaudeRequest({
          sessionId,
          profileData,
          interestGroupId,
          interestRow: lastInterest,
          requestOrder,
          requestKind: "comparison",
          branchLabel: "Comparison prompt",
          repeatIndex,
          promptText: prompt,
          messageHistory: cloneClaudeMessages(comparisonMessages),
          onProviderEvent: (providerEvent) => {
            liveComparisonRequest.providerRequestId =
              providerEvent.providerRequestId || liveComparisonRequest.providerRequestId;
            liveComparisonRequest.usage =
              providerEvent.usage || liveComparisonRequest.usage;
            liveComparisonRequest.providerEvents.push(providerEvent);
            void queueLiveSessionWrite();

            emitProgress("provider_event", {
              requestKind: "comparison",
              branchLabel: "Comparison prompt",
              ...providerEvent,
            });
          },
        }));
      } catch (error) {
        liveComparisonRequest.status = "failed";
        liveComparisonRequest.finishedAt = new Date().toISOString();
        liveComparisonRequest.errorMessage = error.message;
        liveComparisonRequest.providerEvents =
          error.providerEvents || liveComparisonRequest.providerEvents;
        void queueLiveSessionWrite();
        throw error;
      }
      comparisonMessages.push({
        role: "assistant",
        content: answer,
      });
      requestLogs.push(requestLog);
      liveComparisonRequest.status = "completed";
      liveComparisonRequest.finishedAt =
        requestLog.finishedAt || new Date().toISOString();
      liveComparisonRequest.providerRequestId = requestLog.providerRequestId;
      liveComparisonRequest.completionId = requestLog.completionId;
      liveComparisonRequest.usage = requestLog.usage;
      liveComparisonRequest.answerText = answer;
      liveComparisonRequest.sources = sources;
      liveComparisonRequest.responseMeta = requestLog.responseMeta;
      liveComparisonRequest.providerEvents =
        requestLog.responseMeta?.providerEvents ||
        liveComparisonRequest.providerEvents;
      void queueLiveSessionWrite();
      addTrace(trace, "Comparison branch answer appended", comparisonMessages);
      emitProgress("comparison_completed", {
        completionId: completion.id,
      });

      if (saveToDb) {
        await saveComparisonPromptAnswer(
          dbClient,
          profileData,
          lastInterest,
          sessionId,
          repeatIndex,
          PROVIDER_NAME,
          MODEL_NAME,
          prompt,
          answer,
          completion.id,
          sources,
        );
      }

      comparison = {
        interestGroupId: lastInterest.interest_group_id,
        interestType: lastInterest.interest_type,
        completionId: completion.id,
        prompt,
        answer,
        sources,
        rawApiResponse: toPlainJson(completion),
      };
    }

    if (saveToDb) {
      await updateSessionRunStatus(dbClient, sessionId, "completed", null);
      await dbClient.query("COMMIT");
      transactionStarted = false;
      await saveCompletedRequestLogs(dbClient, requestLogs, sessionId);
    }

    liveSession.status = "completed";
    liveSession.finishedAt = new Date().toISOString();
    liveSession.errorMessage = null;
    await queueLiveSessionWrite();
    await liveWriteChain.catch(() => {});
    if (liveSessionKey) {
      unregisterActiveLiveSession(liveSessionKey);
    }
    await removeLiveSessionSnapshot(currentDatabase, sessionId).catch(() => {});

    emitProgress("session_completed");

    return {
      sessionId,
      providerName: PROVIDER_NAME,
      modelName: MODEL_NAME,
      saveToDb,
      runNotes: RUN_NOTES,
      interestType,
      repeatIndex,
      profile: profileData,
      trace,
      general: {
        completionId: generalCompletion.id,
        prompt: generalPrompt,
        answer: generalAnswer,
        sources: generalSources,
        rawApiResponse: toPlainJson(generalCompletion),
      },
      followUps,
      comparison,
    };
  } catch (error) {
    if (saveToDb && transactionStarted) {
      try {
        await dbClient.query("ROLLBACK");
        transactionStarted = false;
      } catch {
        // Ignore secondary rollback failures and rethrow original error.
      }
    }

    const isLogicalDuplicate =
      error &&
      error.code === "23505" &&
      error.constraint === "session_runs_active_unique_idx";
    const duplicateError = isLogicalDuplicate
      ? new Error(
          `A completed or running session already exists for profile_id=${profileId}, interest_group_id=${interestGroupId}, repeat_index=${repeatIndex}, provider=${PROVIDER_NAME}, model=${MODEL_NAME}. Use a different repeat index, clear the session tables, or run with --no-save.`,
        )
      : null;

    if (saveToDb && sessionId && profileData && interestGroupId) {
      try {
        await saveSessionRun(
          dbClient,
          profileData,
          sessionId,
          interestGroupId,
          repeatIndex,
          PROVIDER_NAME,
          MODEL_NAME,
          "failed",
          error.message,
        );
      } catch {
        // Ignore secondary DB status insert failures and rethrow original error.
      }
    }

    if (liveSession) {
      liveSession.status = "failed";
      liveSession.finishedAt = new Date().toISOString();
      liveSession.errorMessage = duplicateError?.message || error.message;
      await queueLiveSessionWrite();
      await liveWriteChain.catch(() => {});
    }

    if (liveSessionKey) {
      unregisterActiveLiveSession(liveSessionKey);
    }

    emitProgress("session_failed", {
      error: duplicateError?.message || error.message,
    });

    throw duplicateError || error;
  } finally {
    await dbClient.end();
  }
}

module.exports = {
  MODEL_NAME,
  PROVIDER_NAME,
  RUN_NOTES,
  TOP_P,
  ANTHROPIC_EFFORT,
  ENABLE_THINKING,
  MAX_TOOL_CALLS,
  MAX_PAUSE_TURNS,
  MAX_PROVIDER_EVENTS_PER_REQUEST,
  MAX_CONSECUTIVE_LOW_OUTPUT_PAUSE_TURNS,
  LOW_OUTPUT_TOKEN_THRESHOLD,
  createDbClient,
  getAllProfiles,
  getInterestGroupRows,
  runSession,
};
