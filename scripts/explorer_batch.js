const fs = require("node:fs/promises");
const path = require("node:path");
const OpenAI = require("openai");
const { createDbClient } = require("./session_flow");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const MODEL_NAME = "gpt-5.5";
const PROVIDER_NAME = "openai";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 300000);
const MAX_API_RETRIES = Number(process.env.MAX_API_RETRIES || 4);
const RETRY_BASE_DELAY_MS = Number(process.env.RETRY_BASE_DELAY_MS || 2000);
const SESSION_DELAY_MS = Number(process.env.SESSION_DELAY_MS || 0);
const MAX_TOOL_CALLS = Number(process.env.MAX_TOOL_CALLS || 6);
const REASONING_EFFORT = process.env.REASONING_EFFORT || "low";
const TEXT_VERBOSITY = process.env.TEXT_VERBOSITY || "medium";
const WEB_SEARCH_CONTEXT_SIZE =
  process.env.WEB_SEARCH_CONTEXT_SIZE || "low";
const WEB_SEARCH_COUNTRY = process.env.WEB_SEARCH_COUNTRY || "DE";
const WEB_SEARCH_TIMEZONE =
  process.env.WEB_SEARCH_TIMEZONE || "Europe/Berlin";
const REPEAT_COUNT = Number(process.env.REPEAT_COUNT || 5);
const PROMPT_LIMIT = Number(process.env.PROMPT_LIMIT || 0);
const OUTPUT_DIR = path.join(__dirname, "..", "outputs");
const DOCUMENTED_PROMPT_COUNT = 9;

function buildWebSearchTool() {
  return {
    type: "web_search",
    search_context_size: WEB_SEARCH_CONTEXT_SIZE,
    user_location: {
      type: "approximate",
      country: WEB_SEARCH_COUNTRY,
      timezone: WEB_SEARCH_TIMEZONE,
    },
  };
}

const EXPLORER_PROMPTS = [
  {
    promptId: 1,
    promptText:
      "Which is the most beautiful lakeside destination in Central Europe? Recommend 5 destinations.",
  },
  {
    promptId: 2,
    promptText:
      "List the 5 most significant freshwater tourism destinations in Europe.",
  },
  {
    promptId: 3,
    promptText:
      "Which is the most beautiful lakeside destination in Central Europe? Please recommend 5 destinations.",
  },
  {
    promptId: 4,
    promptText:
      "List the 5 most significant freshwater tourism destinations in Europe.",
  },
  {
    promptId: 5,
    promptText: "Where is it worth planning a lakeside holiday in Europe?",
  },
  {
    promptId: 6,
    promptText:
      "Which European lake is best for spending a long weekend?",
  },
  {
    promptId: 7,
    promptText:
      "Recommend 5 lakeside destinations in Europe that are worth discovering.",
  },
  {
    promptId: 8,
    promptText:
      "Which is the best lakeside region in Europe for someone going on a lake holiday for the first time?",
  },
];

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY. Add it to .env");
}

// maxRetries: 0 disables the SDK's own internal retry so the runChat loop
// (MAX_API_RETRIES) stays the single retry authority.
const openai = new OpenAI({ apiKey: OPENAI_API_KEY, maxRetries: 0 });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function getOutputPath() {
  if (process.env.OUTPUT_FILE) {
    return path.resolve(process.env.OUTPUT_FILE);
  }

  const safeModel = MODEL_NAME.replace(/[^a-z0-9._-]/gi, "_");
  return path.join(
    OUTPUT_DIR,
    `explorer_prompts_${safeModel}_${getTimestamp()}.json`,
  );
}

function createExplorerRunId() {
  return `explorer_${MODEL_NAME.replace(/[^a-z0-9._-]/gi, "_")}_${Date.now()}`;
}

function getAssistantText(completion) {
  if (completion?.output_text) {
    return completion.output_text;
  }

  const textParts = [];

  for (const outputItem of completion?.output || []) {
    if (outputItem?.type !== "message") {
      continue;
    }

    for (const contentItem of outputItem.content || []) {
      if (
        (contentItem?.type === "output_text" || contentItem?.type === "text") &&
        contentItem.text
      ) {
        textParts.push(contentItem.text);
      }
    }
  }

  return textParts.join("\n\n") || "(No text returned)";
}

function ensureUsableCompletion(completion, answerText) {
  const trimmedAnswer = typeof answerText === "string" ? answerText.trim() : "";

  if (completion?.status === "incomplete") {
    const reason = completion?.incomplete_details?.reason;
    throw new Error(
      reason
        ? `OpenAI returned an incomplete response: ${reason}`
        : "OpenAI returned an incomplete response.",
    );
  }

  if (!trimmedAnswer || trimmedAnswer === "(No text returned)") {
    throw new Error("OpenAI returned an empty response.");
  }
}

function extractWebSources(completion) {
  const sourcesByUrl = new Map();

  const addSource = (source, origin) => {
    if (!source) {
      return;
    }

    const key = source.url || source.title;

    if (!key) {
      return;
    }

    const existing = sourcesByUrl.get(key);

    if (existing) {
      if (!existing.origins.includes(origin)) {
        existing.origins.push(origin);
      }
      return;
    }

    sourcesByUrl.set(key, { ...source, origins: [origin] });
  };

  for (const outputItem of completion?.output || []) {
    if (outputItem?.type === "web_search_call") {
      for (const source of outputItem?.action?.sources || []) {
        addSource(source, "search");
      }
      continue;
    }

    if (outputItem?.type !== "message") {
      continue;
    }

    for (const contentItem of outputItem.content || []) {
      for (const annotation of contentItem?.annotations || []) {
        if (annotation?.type === "url_citation") {
          addSource(annotation.url_citation || annotation, "citation");
        }
      }
    }
  }

  return [...sourcesByUrl.values()];
}

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    status: error?.status || null,
    code: error?.code || null,
  };
}

async function ensureExplorerTables(dbClient) {
  await dbClient.query(`
    CREATE TABLE IF NOT EXISTS explorer_prompt_results (
      explorer_result_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      explorer_run_id VARCHAR(255) NOT NULL,
      prompt_id INT NOT NULL,
      repeat_index INT NOT NULL,
      provider_name VARCHAR(100),
      model_name VARCHAR(100),
      prompt_text TEXT NOT NULL,
      answer_text TEXT,
      completion_id VARCHAR(255),
      sources_json JSONB,
      UNIQUE (explorer_run_id, prompt_id, repeat_index)
    )
  `);

  await dbClient.query(`
    CREATE INDEX IF NOT EXISTS explorer_prompt_results_lookup_idx
    ON explorer_prompt_results (
      prompt_id,
      repeat_index,
      provider_name,
      model_name
    )
  `);
}

async function saveExplorerPromptResult(dbClient, row) {
  await dbClient.query(
    `
      INSERT INTO explorer_prompt_results (
        explorer_run_id,
        prompt_id,
        repeat_index,
        provider_name,
        model_name,
        prompt_text,
        answer_text,
        completion_id,
        sources_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
    `,
    [
      row.explorerRunId,
      row.promptId,
      row.repeatIndex,
      PROVIDER_NAME,
      MODEL_NAME,
      row.promptText,
      row.answerText || null,
      row.completionId || null,
      JSON.stringify(row.sources || []),
    ],
  );
}

async function runChat(promptText) {
  let attempt = 0;

  while (true) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      return await openai.responses.create(
        {
          model: MODEL_NAME,
          input: [{ role: "user", content: promptText }],
          tools: [buildWebSearchTool()],
          tool_choice: "required",
          max_tool_calls: MAX_TOOL_CALLS,
          reasoning: { effort: REASONING_EFFORT },
          text: { verbosity: TEXT_VERBOSITY },
          include: ["web_search_call.action.sources"],
        },
        {
          signal: controller.signal,
        },
      );
    } catch (error) {
      const status = error?.status;
      const code = error?.code;
      const retryable =
        error instanceof OpenAI.APIUserAbortError ||
        error instanceof OpenAI.APIConnectionError ||
        status === 408 ||
        status === 409 ||
        status === 429 ||
        status >= 500 ||
        code === "ECONNRESET" ||
        code === "ETIMEDOUT" ||
        code === "UND_ERR_CONNECT_TIMEOUT";

      if (!retryable || attempt >= MAX_API_RETRIES) {
        throw error;
      }

      const delayMs =
        RETRY_BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 500);

      console.warn(
        `Retrying OpenAI call after error (attempt ${attempt + 1}/${MAX_API_RETRIES}, delay ${delayMs}ms): ${error.message}`,
      );

      attempt += 1;
      await sleep(delayMs);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

async function writeSnapshot(outputPath, payload) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function printHelp() {
  console.log(`
Explorer prompt batch runner

Environment variables:
  Model is fixed to gpt-5.5
  REPEAT_COUNT              defaults to 5
  PROMPT_LIMIT              optional, run only the first N prompts
  MAX_TOOL_CALLS            defaults to 6
  REASONING_EFFORT          defaults to low
  TEXT_VERBOSITY            defaults to medium
  WEB_SEARCH_CONTEXT_SIZE   defaults to low
  SESSION_DELAY_MS          defaults to 0
  OUTPUT_FILE               optional custom JSON path

Example:
  REPEAT_COUNT=5 node scripts/explorer_batch.js --save
  REPEAT_COUNT=1 PROMPT_LIMIT=2 WEB_SEARCH_CONTEXT_SIZE=low node scripts/explorer_batch.js
  REPEAT_COUNT=1 PROMPT_LIMIT=2 MAX_TOOL_CALLS=6 REASONING_EFFORT=low TEXT_VERBOSITY=medium WEB_SEARCH_CONTEXT_SIZE=low node scripts/explorer_batch.js
`);
}

async function main() {
  if (process.argv.includes("--help")) {
    printHelp();
    return;
  }

  const prompts =
    PROMPT_LIMIT > 0 ? EXPLORER_PROMPTS.slice(0, PROMPT_LIMIT) : EXPLORER_PROMPTS;
  const outputPath = getOutputPath();
  const startedAt = Date.now();
  const totalRequests = prompts.length * REPEAT_COUNT;
  const saveToDb = process.argv.includes("--save");
  const explorerRunId = createExplorerRunId();
  const dbClient = saveToDb ? createDbClient() : null;
  const payload = {
    generatedAt: new Date().toISOString(),
    explorerRunId,
    providerName: PROVIDER_NAME,
    modelName: MODEL_NAME,
    webSearchContextSize: WEB_SEARCH_CONTEXT_SIZE,
    saveToDb,
    repeatCount: REPEAT_COUNT,
    promptCount: prompts.length,
    documentedPromptCount: DOCUMENTED_PROMPT_COUNT,
    sessionDelayMs: SESSION_DELAY_MS,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    notes: [
      "The methodology document says 9 explorer prompts, but only 8 prompt texts were recoverable from the current PDF/HTML source.",
      "Add the 9th prompt to EXPLORER_PROMPTS when it is confirmed.",
    ],
    prompts,
    records: [],
    summary: {
      totalRequests,
      successfulRequests: 0,
      failedRequests: 0,
      elapsedMinutes: 0,
    },
  };

  try {
    if (dbClient) {
      await dbClient.connect();
      await ensureExplorerTables(dbClient);
    }

    console.log(`Model: ${MODEL_NAME}`);
    console.log(`Web search context: ${WEB_SEARCH_CONTEXT_SIZE}`);
    console.log(`Max tool calls: ${MAX_TOOL_CALLS}`);
    console.log(`Reasoning effort: ${REASONING_EFFORT}`);
    console.log(`Text verbosity: ${TEXT_VERBOSITY}`);
    console.log(`Save to DB: ${saveToDb ? "yes" : "no"}`);
    console.log(`Prompt count: ${prompts.length}`);
    console.log(`Repeat count: ${REPEAT_COUNT}`);
    console.log(`Total requests: ${totalRequests}`);
    console.log(`Output file: ${outputPath}`);

    let requestIndex = 0;

    for (const prompt of prompts) {
      for (let repeatIndex = 1; repeatIndex <= REPEAT_COUNT; repeatIndex += 1) {
        requestIndex += 1;
        console.log(
          `Request ${requestIndex}/${totalRequests} -> prompt ${prompt.promptId}, repeat ${repeatIndex}`,
        );

        try {
          const completion = await runChat(prompt.promptText);
          const answerText = getAssistantText(completion);
          ensureUsableCompletion(completion, answerText);
          const sources = extractWebSources(completion);

          payload.records.push({
            promptId: prompt.promptId,
            repeatIndex,
            promptText: prompt.promptText,
            completionId: completion.id,
            answerText,
            sources,
            sourceCount: sources.length,
            status: "completed",
            createdAt: new Date().toISOString(),
          });

          if (dbClient) {
            await saveExplorerPromptResult(dbClient, {
              explorerRunId,
              promptId: prompt.promptId,
              repeatIndex,
              promptText: prompt.promptText,
              answerText,
              completionId: completion.id,
              sources,
            });
          }

          payload.summary.successfulRequests += 1;
          console.log(`  completion_id: ${completion.id}`);
          console.log(`  sources: ${sources.length}`);
        } catch (error) {
          payload.records.push({
            promptId: prompt.promptId,
            repeatIndex,
            promptText: prompt.promptText,
            status: "failed",
            error: serializeError(error),
            createdAt: new Date().toISOString(),
          });

          if (dbClient) {
            console.warn("  failed request not saved to DB row");
          }

          payload.summary.failedRequests += 1;
          console.error(`  FAILED: ${error.message}`);
        }

        payload.summary.elapsedMinutes = Number(
          ((Date.now() - startedAt) / 1000 / 60).toFixed(1),
        );
        await writeSnapshot(outputPath, payload);

        if (SESSION_DELAY_MS > 0) {
          await sleep(SESSION_DELAY_MS);
        }
      }
    }

    console.log("\nExplorer batch completed.");
    console.log(`Successful requests: ${payload.summary.successfulRequests}`);
    console.log(`Failed requests: ${payload.summary.failedRequests}`);
    console.log(`Elapsed minutes: ${payload.summary.elapsedMinutes}`);
    console.log(`Explorer run id: ${explorerRunId}`);
  } finally {
    if (dbClient) {
      await dbClient.end();
    }
  }
}

main().catch((error) => {
  console.error("\nExplorer batch failed:");
  console.error(error);
  process.exitCode = 1;
});
