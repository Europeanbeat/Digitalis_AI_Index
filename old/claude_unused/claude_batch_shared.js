const path = require("node:path");
const Anthropic = require("@anthropic-ai/sdk");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const {
  RUN_NOTES,
  createDbClient,
  getAllProfiles,
  getInterestGroupRows,
  getProfile,
  getTravelInterests,
  buildGeneralPrompt,
  buildConstraintPrompt,
  buildComparisonPrompt,
  saveSessionRun,
  updateSessionRunStatus,
  saveGeneralPromptAnswer,
  saveConstraintPromptAnswer,
  saveComparisonPromptAnswer,
  saveRequestLogEntry,
  toPlainJson,
} = require("./session_shared");

const MODEL_NAME = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const PROVIDER_NAME = "anthropic";
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
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  throw new Error("Missing ANTHROPIC_API_KEY. Add it to .env");
}

const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
  maxRetries: 0,
});

function sanitizeSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32) || "unknown";
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

function buildBatchRequestParams(messages) {
  const payload = {
    model: MODEL_NAME,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    top_p: TOP_P,
    messages: cloneClaudeMessages(messages),
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

function buildBatchSessionId(profileId, interestGroupId, repeatIndex) {
  return `claude_batch_session_${profileId}_${interestGroupId}_${repeatIndex}_${sanitizeSegment(MODEL_NAME)}`.slice(
    0,
    255,
  );
}

function buildBatchCustomId({
  destinationName,
  profileId,
  interestGroupId,
  repeatIndex,
  requestKind,
  interestId,
}) {
  const destinationSlug = sanitizeSegment(destinationName).slice(0, 18);
  const kindSlug =
    requestKind === "constraint"
      ? `c${interestId}`
      : requestKind === "comparison"
        ? "cmp"
        : "gen";
  return `${destinationSlug}_p${profileId}_g${interestGroupId}_r${repeatIndex}_${kindSlug}`.slice(
    0,
    255,
  );
}

function getAssistantText(message) {
  const textParts = [];

  for (const contentItem of message?.content || []) {
    if (contentItem?.type === "text" && contentItem.text) {
      textParts.push(contentItem.text);
    }
  }

  return textParts.join("\n\n") || "(No text returned)";
}

function getContentErrorMessage(contentItem) {
  return (
    contentItem?.message ||
    contentItem?.error?.message ||
    contentItem?.result?.error?.message ||
    null
  );
}

function validateSucceededBatchMessage(message) {
  const answerText = getAssistantText(message);
  const trimmedAnswer = typeof answerText === "string" ? answerText.trim() : "";
  const stopReason = message?.stop_reason || null;

  if (!trimmedAnswer || trimmedAnswer === "(No text returned)") {
    return {
      ok: false,
      answerText,
      errorMessage: "Claude returned an empty response.",
    };
  }

  if (["max_tokens", "refusal", "tool_use", "pause_turn"].includes(stopReason)) {
    return {
      ok: false,
      answerText,
      errorMessage: `Claude returned unusable stop_reason=${stopReason}.`,
    };
  }

  for (const contentItem of message?.content || []) {
    if (typeof contentItem?.type === "string" && contentItem.type.includes("error")) {
      return {
        ok: false,
        answerText,
        errorMessage:
          getContentErrorMessage(contentItem) ||
          "Claude returned a tool/content error block.",
      };
    }
  }

  return {
    ok: true,
    answerText,
    errorMessage: null,
  };
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

function extractWebSources(message) {
  const sourcesByKey = new Map();

  for (const contentItem of message?.content || []) {
    if (contentItem?.type === "text" && Array.isArray(contentItem.citations)) {
      collectSourceCandidates(contentItem.citations, "citation", sourcesByKey);
    }

    if (typeof contentItem?.type === "string" && contentItem.type.includes("search")) {
      collectSourceCandidates(contentItem, "search", sourcesByKey);
    }
  }

  return [...sourcesByKey.values()];
}

function getProviderRequestId(message) {
  return message?._request_id || message?.request_id || null;
}

function getUsage(message) {
  return message?.usage || null;
}

function buildResponseMeta(message) {
  return {
    id: message?.id || null,
    model: message?.model || MODEL_NAME,
    stopReason: message?.stop_reason || null,
    usage: message?.usage || null,
    type: message?.type || null,
  };
}

function parseBatchResult(item) {
  const outcome = item?.result || {};

  if (outcome.type === "succeeded") {
    const message = outcome.message || null;
    const validation = validateSucceededBatchMessage(message);

    if (!validation.ok) {
      return {
        status: "errored",
        completionId: message?.id || null,
        providerRequestId: getProviderRequestId(message),
        answerText: validation.answerText,
        sources: extractWebSources(message),
        usage: getUsage(message),
        responseMeta: buildResponseMeta(message),
        rawResult: toPlainJson(item),
        errorJson: toPlainJson({
          message: validation.errorMessage,
          stop_reason: message?.stop_reason || null,
          result_type: outcome.type,
        }),
        finishedAt: new Date().toISOString(),
      };
    }

    return {
      status: "succeeded",
      completionId: message?.id || null,
      providerRequestId: getProviderRequestId(message),
      answerText: validation.answerText,
      sources: extractWebSources(message),
      usage: getUsage(message),
      responseMeta: buildResponseMeta(message),
      rawResult: toPlainJson(item),
      errorJson: null,
      finishedAt: new Date().toISOString(),
    };
  }

  if (outcome.type === "errored") {
    return {
      status: "errored",
      completionId: null,
      providerRequestId: null,
      answerText: null,
      sources: [],
      usage: null,
      responseMeta: null,
      rawResult: toPlainJson(item),
      errorJson: toPlainJson(outcome.error || outcome),
      finishedAt: new Date().toISOString(),
    };
  }

  if (outcome.type === "canceled") {
    return {
      status: "canceled",
      completionId: null,
      providerRequestId: null,
      answerText: null,
      sources: [],
      usage: null,
      responseMeta: null,
      rawResult: toPlainJson(item),
      errorJson: toPlainJson(outcome),
      finishedAt: new Date().toISOString(),
    };
  }

  if (outcome.type === "expired") {
    return {
      status: "expired",
      completionId: null,
      providerRequestId: null,
      answerText: null,
      sources: [],
      usage: null,
      responseMeta: null,
      rawResult: toPlainJson(item),
      errorJson: toPlainJson(outcome),
      finishedAt: new Date().toISOString(),
    };
  }

  return {
    status: "errored",
    completionId: null,
    providerRequestId: null,
    answerText: null,
    sources: [],
    usage: null,
    responseMeta: null,
    rawResult: toPlainJson(item),
    errorJson: toPlainJson({
      message: "Unknown batch result type",
      outcome,
    }),
    finishedAt: new Date().toISOString(),
  };
}

async function getCurrentDatabaseName(dbClient) {
  const result = await dbClient.query("SELECT current_database() AS database_name");
  return result.rows[0]?.database_name || process.env.PGDATABASE || "unknown_database";
}

async function upsertBatchRun(dbClient, payload) {
  await dbClient.query(
    `
      INSERT INTO claude_batch_runs (
        batch_id,
        pass_type,
        destination_name,
        provider_name,
        model_name,
        run_notes,
        processing_status,
        request_counts_json,
        raw_batch_json,
        ended_at,
        synced_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11
      )
      ON CONFLICT (batch_id) DO UPDATE SET
        pass_type = EXCLUDED.pass_type,
        destination_name = EXCLUDED.destination_name,
        provider_name = EXCLUDED.provider_name,
        model_name = EXCLUDED.model_name,
        run_notes = EXCLUDED.run_notes,
        processing_status = EXCLUDED.processing_status,
        request_counts_json = EXCLUDED.request_counts_json,
        raw_batch_json = EXCLUDED.raw_batch_json,
        ended_at = EXCLUDED.ended_at,
        synced_at = EXCLUDED.synced_at
    `,
    [
      payload.batchId,
      payload.passType,
      payload.destinationName || null,
      payload.providerName || PROVIDER_NAME,
      payload.modelName || MODEL_NAME,
      payload.runNotes ?? RUN_NOTES,
      payload.processingStatus,
      JSON.stringify(payload.requestCounts || null),
      JSON.stringify(payload.rawBatch || null),
      payload.endedAt || null,
      payload.syncedAt || null,
    ],
  );
}

async function upsertBatchRequest(dbClient, payload) {
  await dbClient.query(
    `
      INSERT INTO claude_batch_requests (
        batch_id,
        custom_id,
        pass_type,
        session_id,
        profile_id,
        interest_group_id,
        interest_id,
        request_order,
        request_kind,
        branch_label,
        interest_type,
        season_name,
        travel_time_frame,
        repeat_index,
        destination_name,
        provider_name,
        model_name,
        run_notes,
        status,
        prompt_text,
        message_history_json,
        completion_id,
        provider_request_id,
        answer_text,
        sources_json,
        usage_json,
        response_meta_json,
        raw_result_json,
        error_json,
        started_at,
        finished_at,
        finalized_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20, $21::jsonb, $22, $23, $24,
        $25::jsonb, $26::jsonb, $27::jsonb, $28::jsonb, $29::jsonb,
        $30, $31, $32
      )
      ON CONFLICT (custom_id) DO UPDATE SET
        batch_id = EXCLUDED.batch_id,
        pass_type = EXCLUDED.pass_type,
        session_id = EXCLUDED.session_id,
        profile_id = EXCLUDED.profile_id,
        interest_group_id = EXCLUDED.interest_group_id,
        interest_id = EXCLUDED.interest_id,
        request_order = EXCLUDED.request_order,
        request_kind = EXCLUDED.request_kind,
        branch_label = EXCLUDED.branch_label,
        interest_type = EXCLUDED.interest_type,
        season_name = EXCLUDED.season_name,
        travel_time_frame = EXCLUDED.travel_time_frame,
        repeat_index = EXCLUDED.repeat_index,
        destination_name = EXCLUDED.destination_name,
        provider_name = EXCLUDED.provider_name,
        model_name = EXCLUDED.model_name,
        run_notes = EXCLUDED.run_notes,
        status = EXCLUDED.status,
        prompt_text = EXCLUDED.prompt_text,
        message_history_json = EXCLUDED.message_history_json,
        completion_id = EXCLUDED.completion_id,
        provider_request_id = EXCLUDED.provider_request_id,
        answer_text = EXCLUDED.answer_text,
        sources_json = EXCLUDED.sources_json,
        usage_json = EXCLUDED.usage_json,
        response_meta_json = EXCLUDED.response_meta_json,
        raw_result_json = EXCLUDED.raw_result_json,
        error_json = EXCLUDED.error_json,
        started_at = EXCLUDED.started_at,
        finished_at = EXCLUDED.finished_at,
        finalized_at = COALESCE(EXCLUDED.finalized_at, claude_batch_requests.finalized_at)
    `,
    [
      payload.batchId || null,
      payload.customId,
      payload.passType,
      payload.sessionId,
      payload.profileId,
      payload.interestGroupId,
      payload.interestId || null,
      payload.requestOrder,
      payload.requestKind,
      payload.branchLabel || null,
      payload.interestType || null,
      payload.seasonName || null,
      payload.travelTimeFrame || null,
      payload.repeatIndex,
      payload.destinationName || null,
      payload.providerName || PROVIDER_NAME,
      payload.modelName || MODEL_NAME,
      payload.runNotes ?? RUN_NOTES,
      payload.status,
      payload.promptText,
      JSON.stringify(payload.messageHistory || []),
      payload.completionId || null,
      payload.providerRequestId || null,
      payload.answerText || null,
      JSON.stringify(payload.sources || []),
      JSON.stringify(payload.usage || null),
      JSON.stringify(payload.responseMeta || null),
      JSON.stringify(payload.rawResult || null),
      JSON.stringify(payload.errorJson || null),
      payload.startedAt || null,
      payload.finishedAt || null,
      payload.finalizedAt || null,
    ],
  );
}

module.exports = {
  RUN_NOTES,
  MODEL_NAME,
  PROVIDER_NAME,
  TOP_P,
  ANTHROPIC_EFFORT,
  ENABLE_THINKING,
  MAX_TOOL_CALLS,
  ANTHROPIC_MAX_TOKENS,
  anthropic,
  createDbClient,
  getAllProfiles,
  getInterestGroupRows,
  getProfile,
  getTravelInterests,
  buildGeneralPrompt,
  buildConstraintPrompt,
  buildComparisonPrompt,
  saveSessionRun,
  updateSessionRunStatus,
  saveGeneralPromptAnswer,
  saveConstraintPromptAnswer,
  saveComparisonPromptAnswer,
  saveRequestLogEntry,
  toPlainJson,
  sanitizeSegment,
  cloneClaudeMessages,
  buildBatchRequestParams,
  buildBatchSessionId,
  buildBatchCustomId,
  parseBatchResult,
  getCurrentDatabaseName,
  upsertBatchRun,
  upsertBatchRequest,
};
