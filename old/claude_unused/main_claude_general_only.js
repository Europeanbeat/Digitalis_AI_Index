const path = require("node:path");
const Anthropic = require("@anthropic-ai/sdk");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const {
  RUN_NOTES,
  createDbClient,
  sleep,
  getProfile,
  getTravelInterests,
  buildGeneralPrompt,
  createSessionId,
  saveSessionRun,
  updateSessionRunStatus,
  saveGeneralPromptAnswer,
  saveRequestLogEntry,
  toPlainJson,
} = require("./session_shared");

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
  process.env.ANTHROPIC_MAX_TOOL_CALLS || process.env.MAX_TOOL_CALLS || 1,
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

const PROFILE_ID = Number(process.argv[2] || 1);
const INTEREST_TYPE = process.argv[3] || "Wellness";
const REPEAT_INDEX = Number(process.argv[4] || 1);
const SAVE_TO_DB = !process.argv.includes("--no-save");

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
      return await anthropic.messages.create(buildRequestPayload(messages), {
        signal: controller.signal,
      });
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
    throw new Error("Claude returned an empty general response.");
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

function collectSourceCandidates(value, sourcesByKey) {
  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectSourceCandidates(item, sourcesByKey));
    return;
  }

  if (typeof value.url === "string" || typeof value.title === "string") {
    const key = value.url || value.title;
    if (key && !sourcesByKey.has(key)) {
      sourcesByKey.set(key, {
        title: value.title || null,
        url: value.url || null,
      });
    }
  }

  for (const nestedValue of Object.values(value)) {
    collectSourceCandidates(nestedValue, sourcesByKey);
  }
}

function extractWebSources(completion) {
  const sourcesByKey = new Map();

  for (const contentItem of completion?.content || []) {
    if (contentItem?.type === "text" && Array.isArray(contentItem.citations)) {
      collectSourceCandidates(contentItem.citations, sourcesByKey);
    }

    if (typeof contentItem?.type === "string" && contentItem.type.includes("search")) {
      collectSourceCandidates(contentItem, sourcesByKey);
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

function printSources(sources) {
  if (!sources.length) {
    return;
  }

  console.log("\nSOURCES:");
  for (const [index, source] of sources.entries()) {
    const label = source.title || source.url || `Source ${index + 1}`;
    console.log(`${index + 1}. ${label}`);
    if (source.url) {
      console.log(`   ${source.url}`);
    }
  }
}

function formatUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return "tokens n/a";
  }

  const input = Number(usage.input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  const total = input + output;
  const webSearches = Number(usage.server_tool_use?.web_search_requests || 0);
  return `in ${input} · out ${output} · total ${total} · web searches ${webSearches}`;
}

async function main() {
  const dbClient = createDbClient();
  await dbClient.connect();

  let transactionStarted = false;

  try {
    const profileData = await getProfile(dbClient, PROFILE_ID);
    const interestRows = await getTravelInterests(dbClient, {
      interestType: INTEREST_TYPE,
      limit: 1,
    });

    if (!interestRows.length) {
      throw new Error(
        `No travel interest row found for interestType=${INTEREST_TYPE}`,
      );
    }

    const interestGroupId = interestRows[0].interest_group_id;
    const sessionId = createSessionId(
      profileData.profile_id,
      interestGroupId,
      REPEAT_INDEX,
    );
    const generalPrompt = buildGeneralPrompt(profileData);
    const messages = [{ role: "user", content: generalPrompt }];

    console.log(`Starting Claude general-only test -> profile ${PROFILE_ID}`);
    console.log(`Interest type anchor: ${INTEREST_TYPE}`);
    console.log(`Save to DB: ${SAVE_TO_DB ? "yes" : "no"}`);
    console.log(`Top P: ${TOP_P}`);
    console.log(`Anthropic thinking: ${ENABLE_THINKING ? "on" : "off"}`);
    console.log(
      `Anthropic tool choice: ${ENABLE_THINKING ? "auto" : "forced web_search"}`,
    );
    console.log(`Anthropic max tool calls: ${MAX_TOOL_CALLS}`);
    console.log(
      `Anthropic effort: ${
        ENABLE_THINKING ? ANTHROPIC_EFFORT : "(ignored while thinking is off)"
      }`,
    );
    console.log(`Session ID: ${sessionId}`);
    console.log("\nGENERAL PROMPT:");
    console.log(generalPrompt);

    if (SAVE_TO_DB) {
      await dbClient.query("BEGIN");
      transactionStarted = true;
      await saveSessionRun(
        dbClient,
        profileData,
        sessionId,
        interestGroupId,
        REPEAT_INDEX,
        PROVIDER_NAME,
        MODEL_NAME,
        "running",
      );
    }

    const startedAt = new Date().toISOString();
    const completion = await createClaudeMessage(messages);
    const finishedAt = new Date().toISOString();
    const answerText = getAssistantText(completion);
    ensureUsableCompletion(completion, answerText);
    const sources = extractWebSources(completion);
    const usage = getUsage(completion);

    console.log(`\nCOMPLETION ID: ${completion.id}`);
    console.log(`PROVIDER REQUEST ID: ${getProviderRequestId(completion) || "n/a"}`);
    console.log(`USAGE: ${formatUsage(usage)}`);
    console.log("\nGENERAL ANSWER:");
    console.log(answerText);
    printSources(sources);

    if (SAVE_TO_DB) {
      await saveGeneralPromptAnswer(
        dbClient,
        profileData,
        sessionId,
        REPEAT_INDEX,
        PROVIDER_NAME,
        MODEL_NAME,
        generalPrompt,
        answerText,
        completion.id,
        sources,
      );

      await saveRequestLogEntry(dbClient, {
        sessionId,
        profileId: profileData.profile_id,
        interestGroupId,
        requestOrder: 1,
        requestKind: "general",
        branchLabel: "General prompt",
        repeatIndex: REPEAT_INDEX,
        destinationName: profileData.destination_name,
        providerName: PROVIDER_NAME,
        modelName: MODEL_NAME,
        status: "completed",
        promptText: generalPrompt,
        messageHistory: messages,
        completionId: completion.id,
        providerRequestId: getProviderRequestId(completion),
        answerText,
        sources,
        usage,
        responseMeta: buildResponseMeta(completion),
        startedAt,
        finishedAt,
      });

      await updateSessionRunStatus(dbClient, sessionId, "completed", null);
      await dbClient.query("COMMIT");
      transactionStarted = false;
    }

    console.log("\nDONE.");
  } catch (error) {
    if (transactionStarted) {
      try {
        await dbClient.query("ROLLBACK");
      } catch {
        // Preserve original failure.
      }
    }

    console.error("\nGeneral-only test failed:");
    console.error(error);
    process.exitCode = 1;
  } finally {
    await dbClient.end();
  }
}

main().catch((error) => {
  console.error("\nScript failed:");
  console.error(error);
  process.exitCode = 1;
});
