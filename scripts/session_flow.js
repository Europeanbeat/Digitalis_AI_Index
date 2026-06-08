const path = require("node:path");
const { Client } = require("pg");
const OpenAI = require("openai");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const MODEL_NAME = process.env.OPENAI_MODEL || "gpt-4o-search-preview";
const PROVIDER_NAME = process.env.AI_PROVIDER || "openai";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 120000);
const MAX_API_RETRIES = Number(process.env.MAX_API_RETRIES || 4);
const RETRY_BASE_DELAY_MS = Number(process.env.RETRY_BASE_DELAY_MS || 2000);
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.OpenAI_API_KEY ||
  process.env.OpenAI_APIKey;

if (!OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY. Add it to .env");
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function createDbClient() {
  return new Client({
    user: process.env.PGUSER || "postgres",
    host: process.env.PGHOST || "localhost",
    database: process.env.PGDATABASE || "digital_ai_index_db",
    password:
      process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || "Bence033",
    port: Number(process.env.PGPORT || 5432),
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAllProfiles(dbClient) {
  const result = await dbClient.query(`
    SELECT *
    FROM profiles
    ORDER BY profile_id
  `);

  return result.rows;
}

async function getInterestGroups(dbClient) {
  const result = await dbClient.query(`
    SELECT interest_type
    FROM interest_groups
    ORDER BY interest_group_id
  `);

  return result.rows.map((row) => row.interest_type);
}

async function getInterestGroupRows(dbClient) {
  const result = await dbClient.query(`
    SELECT interest_group_id, interest_type
    FROM interest_groups
    ORDER BY interest_group_id
  `);

  return result.rows;
}

async function getProfile(dbClient, profileId) {
  const result = await dbClient.query(
    "SELECT * FROM profiles WHERE profile_id = $1",
    [profileId],
  );

  if (!result.rows.length) {
    throw new Error(`No profile found for profile_id=${profileId}`);
  }

  return result.rows[0];
}

async function getTravelInterests(dbClient, options = {}) {
  const safeLimit = Number(options.limit) > 0 ? Number(options.limit) : 4;

  if (options.interestType) {
    const result = await dbClient.query(
      `
        SELECT
          ti.interest_id,
          ti.interest_group_id,
          ig.interest_type,
          ig.interest_attributes,
          ig.motivation,
          ti.season_name,
          ti.travel_time_frame
        FROM travel_interests ti
        JOIN interest_groups ig
          ON ig.interest_group_id = ti.interest_group_id
        WHERE ig.interest_type = $1
        ORDER BY ti.interest_id
        LIMIT $2
      `,
      [options.interestType, safeLimit],
    );

    return result.rows;
  }

  const result = await dbClient.query(
    `
      SELECT
        ti.interest_id,
        ti.interest_group_id,
        ig.interest_type,
        ig.interest_attributes,
        ig.motivation,
        ti.season_name,
        ti.travel_time_frame
      FROM travel_interests ti
      JOIN interest_groups ig
        ON ig.interest_group_id = ti.interest_group_id
      ORDER BY ti.interest_id
      LIMIT $1
    `,
    [safeLimit],
  );

  return result.rows;
}

function buildGeneralPrompt(profileData) {
  const budget = Number(profileData.budget_per_day_eur);

  return `I am a ${profileData.age}-year-old ${profileData.gender}. I would like to travel to ${profileData.destination_name} for ${profileData.stay_nights} nights ${profileData.travel_party}. Could you recommend some activities and programmes in the area within a budget of max ${budget} EUR per person per day?`;
}

function buildConstraintPrompt(interestRow) {
  if (!interestRow.motivation) {
    throw new Error(
      `Missing motivation for interest_group_id=${interestRow.interest_group_id}`,
    );
  }

  return `On this trip I am travelling mainly to ${interestRow.motivation}. Could you recommend 5 places in the area ${interestRow.travel_time_frame}?`;
}

function buildComparisonPrompt(profileData, interestRow) {
  if (!interestRow.motivation) {
    throw new Error(
      `Missing motivation for interest_group_id=${interestRow.interest_group_id}`,
    );
  }

  return `Besides ${profileData.destination_name}, could you recommend five other lakeside destinations in Europe where I could best ${interestRow.motivation}, and which also fit my profile and budget?`;
}

function createSessionId(profileId, interestGroupId, repeatIndex) {
  return `session_${profileId}_${interestGroupId}_${repeatIndex}_${Date.now()}`;
}

function getAssistantText(completion) {
  return completion.choices?.[0]?.message?.content || "(No text returned)";
}

function extractWebSources(completion) {
  const annotations = completion?.choices?.[0]?.message?.annotations || [];
  const sourcesByUrl = new Map();

  for (const annotation of annotations) {
    if (annotation?.type !== "url_citation") {
      continue;
    }

    const citation = annotation.url_citation;
    const key = citation?.url || citation?.title;

    if (key && !sourcesByUrl.has(key)) {
      sourcesByUrl.set(key, citation);
    }
  }

  return [...sourcesByUrl.values()];
}

function toPlainJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function cloneMessages(messages) {
  return messages.map((message) => ({ ...message }));
}

async function runChat(messages) {
  let attempt = 0;

  while (true) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      return await openai.chat.completions.create(
        {
          model: MODEL_NAME,
          messages,
          web_search_options: {
            search_context_size: "low",
          },
        },
        {
          signal: controller.signal,
        },
      );
    } catch (error) {
      const status = error?.status;
      const code = error?.code;
      const message = error?.message || String(error);
      const retryable =
        error?.name === "AbortError" ||
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
        `Retrying OpenAI call after error (attempt ${attempt + 1}/${MAX_API_RETRIES}, delay ${delayMs}ms): ${message}`,
      );

      attempt += 1;
      await sleep(delayMs);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

async function saveSessionRun(
  dbClient,
  profileData,
  sessionId,
  interestGroupId,
  repeatIndex,
  status = "running",
  errorMessage = null,
) {
  await dbClient.query(
    `
      INSERT INTO session_runs (
        session_id,
        profile_id,
        interest_group_id,
        repeat_index,
        destination_name,
        provider_name,
        model_name,
        status,
        error_message
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    [
      sessionId,
      profileData.profile_id,
      interestGroupId,
      repeatIndex,
      profileData.destination_name,
      PROVIDER_NAME,
      MODEL_NAME,
      status,
      errorMessage,
    ],
  );
}

async function updateSessionRunStatus(dbClient, sessionId, status, errorMessage = null) {
  await dbClient.query(
    `
      UPDATE session_runs
      SET status = $2,
          error_message = $3
      WHERE session_id = $1
    `,
    [sessionId, status, errorMessage],
  );
}

async function saveGeneralPromptAnswer(
  dbClient,
  profileData,
  sessionId,
  repeatIndex,
  promptText,
  answerText,
  completionId,
  sources,
) {
  await dbClient.query(
    `
      INSERT INTO general_prompt_answers (
        session_id,
        profile_id,
        destination_name,
        repeat_index,
        provider_name,
        model_name,
        prompt_text,
        general_prompt_answer,
        completion_id,
        sources_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
    `,
    [
      sessionId,
      profileData.profile_id,
      profileData.destination_name,
      repeatIndex,
      PROVIDER_NAME,
      MODEL_NAME,
      promptText,
      answerText,
      completionId,
      JSON.stringify(sources),
    ],
  );
}

async function saveConstraintPromptAnswer(
  dbClient,
  profileData,
  interestRow,
  sessionId,
  repeatIndex,
  promptText,
  answerText,
  completionId,
  sources,
) {
  await dbClient.query(
    `
      INSERT INTO constraint_prompt_answers (
        session_id,
        profile_id,
        interest_id,
        interest_group_id,
        destination_name,
        interest_type,
        season_name,
        travel_time_frame,
        repeat_index,
        provider_name,
        model_name,
        prompt_text,
        constraint_prompt_answer,
        completion_id,
        sources_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
    `,
    [
      sessionId,
      profileData.profile_id,
      interestRow.interest_id,
      interestRow.interest_group_id,
      profileData.destination_name,
      interestRow.interest_type,
      interestRow.season_name,
      interestRow.travel_time_frame,
      repeatIndex,
      PROVIDER_NAME,
      MODEL_NAME,
      promptText,
      answerText,
      completionId,
      JSON.stringify(sources),
    ],
  );
}

async function saveComparisonPromptAnswer(
  dbClient,
  profileData,
  interestRow,
  sessionId,
  repeatIndex,
  promptText,
  answerText,
  completionId,
  sources,
) {
  await dbClient.query(
    `
      INSERT INTO comparison_prompt_results (
        session_id,
        profile_id,
        interest_group_id,
        destination_name,
        interest_type,
        repeat_index,
        provider_name,
        model_name,
        prompt_text,
        comparison_prompt_answer,
        completion_id,
        sources_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
    `,
    [
      sessionId,
      profileData.profile_id,
      interestRow.interest_group_id,
      profileData.destination_name,
      interestRow.interest_type,
      repeatIndex,
      PROVIDER_NAME,
      MODEL_NAME,
      promptText,
      answerText,
      completionId,
      JSON.stringify(sources),
    ],
  );
}

function addTrace(trace, label, messages) {
  trace.push({
    label,
    messageCount: messages.length,
    roles: messages.map((message) => message.role),
  });
}

async function runSession(options = {}) {
  const profileId = Number(options.profileId || 1);
  const followUpLimit = Number(options.followUpLimit || 4);
  const interestType = options.interestType || null;
  const repeatIndex = Number(options.repeatIndex || 1);
  const saveToDb = Boolean(options.saveToDb);
  const dbClient = createDbClient();
  let profileData = null;
  let interestGroupId = null;
  let sessionId = null;
  let transactionStarted = false;

  await dbClient.connect();

  try {
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

    if (saveToDb) {
      await dbClient.query("BEGIN");
      transactionStarted = true;
      await saveSessionRun(
        dbClient,
        profileData,
        sessionId,
        interestGroupId,
        repeatIndex,
        "running",
      );
    }

    const messages = [];
    const trace = [];

    addTrace(trace, "Start: empty messages array", messages);

    const generalPrompt = buildGeneralPrompt(profileData);
    messages.push({ role: "user", content: generalPrompt });
    addTrace(trace, "General prompt appended", messages);

    const generalCompletion = await runChat(messages);
    const generalAnswer = getAssistantText(generalCompletion);
    const generalSources = extractWebSources(generalCompletion);
    messages.push({ role: "assistant", content: generalAnswer });
    addTrace(trace, "General answer appended", messages);

    if (saveToDb) {
      await saveGeneralPromptAnswer(
        dbClient,
        profileData,
        sessionId,
        repeatIndex,
        generalPrompt,
        generalAnswer,
        generalCompletion.id,
        generalSources,
      );
    }

    const baseMessages = cloneMessages(messages);
    addTrace(trace, "Base branch prepared from general answer", baseMessages);

    const followUps = [];

    for (const interestRow of travelInterests) {
      const prompt = buildConstraintPrompt(interestRow);
      const branchMessages = [
        ...cloneMessages(baseMessages),
        { role: "user", content: prompt },
      ];
      addTrace(
        trace,
        `Constraint branch prompt appended: ${interestRow.interest_type} / ${interestRow.season_name}`,
        branchMessages,
      );

      const completion = await runChat(branchMessages);
      const answer = getAssistantText(completion);
      const sources = extractWebSources(completion);
      branchMessages.push({ role: "assistant", content: answer });
      addTrace(
        trace,
        `Constraint branch answer appended: ${interestRow.interest_type} / ${interestRow.season_name}`,
        branchMessages,
      );

      if (saveToDb) {
        await saveConstraintPromptAnswer(
          dbClient,
          profileData,
          interestRow,
          sessionId,
          repeatIndex,
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
        ...cloneMessages(baseMessages),
        { role: "user", content: prompt },
      ];
      addTrace(trace, "Comparison branch prompt appended", comparisonMessages);

      const completion = await runChat(comparisonMessages);
      const answer = getAssistantText(completion);
      const sources = extractWebSources(completion);
      comparisonMessages.push({ role: "assistant", content: answer });
      addTrace(trace, "Comparison branch answer appended", comparisonMessages);

      if (saveToDb) {
        await saveComparisonPromptAnswer(
          dbClient,
          profileData,
          lastInterest,
          sessionId,
          repeatIndex,
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
    }

    return {
      sessionId,
      providerName: PROVIDER_NAME,
      modelName: MODEL_NAME,
      saveToDb,
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

    if (isLogicalDuplicate) {
      throw new Error(
        `A completed or running session already exists for profile_id=${profileId}, interest_group_id=${interestGroupId}, repeat_index=${repeatIndex}, provider=${PROVIDER_NAME}, model=${MODEL_NAME}. Use a different repeat index, clear the session tables, or run with --no-save.`,
      );
    }

    if (saveToDb && sessionId && profileData && interestGroupId) {
      try {
        await saveSessionRun(
          dbClient,
          profileData,
          sessionId,
          interestGroupId,
          repeatIndex,
          "failed",
          error.message,
        );
      } catch {
        // Ignore secondary DB status insert failures and rethrow original error.
      }
    }
    throw error;
  } finally {
    await dbClient.end();
  }
}

module.exports = {
  createDbClient,
  getAllProfiles,
  getInterestGroups,
  getInterestGroupRows,
  runSession,
};
