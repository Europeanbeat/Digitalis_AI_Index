const path = require("node:path");
const { Client } = require("pg");
const OpenAI = require("openai");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const MODEL_NAME = "gpt-5.5";
const PROVIDER_NAME = "openai";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 300000);
const MAX_API_RETRIES = Number(process.env.MAX_API_RETRIES || 4);
const RETRY_BASE_DELAY_MS = Number(process.env.RETRY_BASE_DELAY_MS || 2000);
const WEB_SEARCH_CONTEXT_SIZE =
  process.env.WEB_SEARCH_CONTEXT_SIZE || "medium";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY. Add it to .env");
}

// maxRetries: 0 disables the SDK's own internal retry so the runChat loop
// (MAX_API_RETRIES) stays the single retry authority.
const openai = new OpenAI({ apiKey: OPENAI_API_KEY, maxRetries: 0 });

// Purpose: build a PostgreSQL client configured for this workspace.
// How: read the connection settings from .env and fail early if the password is
// missing, because every runner/exporter depends on DB access.
// Used by: runSession directly, and also by other scripts that import it
// (batch runner, explorer/export helpers).
function createDbClient() {
  if (!process.env.PGPASSWORD) {
    throw new Error("Missing PGPASSWORD. Add it to .env");
  }

  return new Client({
    user: process.env.PGUSER || "postgres",
    host: process.env.PGHOST || "localhost",
    database: process.env.PGDATABASE || "digital_ai_index_db",
    password: process.env.PGPASSWORD,
    port: Number(process.env.PGPORT || 5432),
  });
}

// Purpose: pause deliberately between retries or between sessions.
// How: wrap setTimeout in a Promise so callers can await the delay.
// Used by: runChat retry backoff, and batch scripts may use the same pattern
// between sessions to reduce API pressure.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Purpose: load the full profile table in stable order for batch iteration.
// How: fetch every row from profiles ordered by profile_id so runs stay
// deterministic and reproducible.
// Used by: model_batch.js, which preloads all profiles before looping.
async function getAllProfiles(dbClient) {
  const result = await dbClient.query(`
    SELECT *
    FROM profiles
    ORDER BY profile_id
  `);

  return result.rows;
}

// Purpose: load all interest-group identifiers and names for batch iteration.
// How: fetch just the fields the batch loop needs: the DB id for skip/resume
// checks and the human-readable interest_type for logging and session setup.
// Used by: model_batch.js before it iterates through every product group.
async function getInterestGroupRows(dbClient) {
  const result = await dbClient.query(`
    SELECT interest_group_id, interest_type
    FROM interest_groups
    ORDER BY interest_group_id
  `);

  return result.rows;
}

// Purpose: resolve one profile id into the full profile row used by prompt
// building and DB saves.
// How: parameterized query by profile_id, then fail loudly if the id does not
// exist instead of letting later prompt code break with undefined fields.
// Used by: runSession, which accepts only profileId so it can run standalone
// from both the single-session runner and the batch runner.
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

// Purpose: load the seasonal follow-up rows that define the 4 constraint
// prompts for one interest group.
// How: join travel_interests with interest_groups so each returned row already
// contains season, travel_time_frame, interest_type and motivation; optionally
// filter by interestType and cap the number of rows with limit.
// Used by: runSession right after the profile is loaded, before the 4 seasonal
// branches and the final comparison prompt are built.
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

// Purpose: build the opening general prompt from one profile row.
// How: read age, gender, destination, stay length, travel_party and budget from
// profileData, then choose "for me" for solo travel and "for us" otherwise.
// Used by: runSession as the first prompt in every 6-prompt session.
function buildGeneralPrompt(profileData) {
  const budget = Number(profileData.budget_per_day_eur);
  const recommendationTarget =
    typeof profileData.travel_party === "string" &&
    profileData.travel_party.toLowerCase().includes("on my own")
      ? "for me"
      : "for us";

  return `I am a ${profileData.age}-year-old ${profileData.gender}. I would like to travel to ${profileData.destination_name} for ${profileData.stay_nights} nights ${profileData.travel_party}. Could you recommend some activities and programmes in the area ${recommendationTarget} within a budget of max ${budget} EUR per person per day?`;
}

// Purpose: build one seasonal follow-up prompt for a specific interest row.
// How: use the motivation from interest_groups plus the seasonal
// travel_time_frame from travel_interests; fail if motivation is missing,
// because the prompt would otherwise become semantically broken.
// Used by: runSession inside the loop that creates the 4 seasonal branches.
function buildConstraintPrompt(interestRow) {
  if (!interestRow.motivation) {
    throw new Error(
      `Missing motivation for interest_group_id=${interestRow.interest_group_id}`,
    );
  }

  return `On this trip I am travelling mainly to ${interestRow.motivation}. Could you recommend 5 places in the area ${interestRow.travel_time_frame}?`;
}

// Purpose: build the final comparison prompt after the seasonal branches.
// How: combine the destination name from the profile with the motivation from
// the chosen interest row so the model suggests alternative lakeside
// destinations that fit the same travel goal and budget context.
// Used by: runSession once per session, after all follow-up branches finish.
function buildComparisonPrompt(profileData, interestRow) {
  if (!interestRow.motivation) {
    throw new Error(
      `Missing motivation for interest_group_id=${interestRow.interest_group_id}`,
    );
  }

  return `Besides ${profileData.destination_name}, could you recommend five other lakeside destinations in Europe where I could best ${interestRow.motivation}, and which also fit my profile and budget?`;
}

// Purpose: generate a unique session header id for one 6-prompt run.
// How: combine profile id, interest group id, repeat index and a timestamp so
// the saved rows can be grouped together in the DB.
// Used by: runSession before any answer rows are written.
function createSessionId(profileId, interestGroupId, repeatIndex) {
  return `session_${profileId}_${interestGroupId}_${repeatIndex}_${Date.now()}`;
}

// Purpose: normalize the assistant text out of the OpenAI Responses API object.
// How: prefer output_text when present, otherwise walk the output/message/content
// structure and concatenate textual parts in order.
// Used by: runSession after every OpenAI call (general, 4 follow-ups,
// comparison).
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

// Purpose: stop the session when the API returns no usable answer text.
// How: reject explicit incomplete responses and the sentinel empty-text case so
// the caller can treat the session as failed instead of saving a false success.
// Used by: runSession after each OpenAI call.
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

// Purpose: extract every web source the model consulted or cited.
// How: collect action.sources from all web_search_call items (what the search
// retrieved) and every url_citation annotation from the message content (what
// the answer actually cites), deduplicated by URL; each entry keeps an
// origins list ("search" / "citation") so the analysis can tell them apart.
// Used by: runSession after every API call so sources can be saved with each
// answer row.
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

// Purpose: turn SDK objects into plain JSON-safe data before returning them.
// How: serialize and deserialize the value so the caller gets a plain object
// without SDK prototypes or non-serializable references.
// Used by: runSession when it returns raw API responses in the result object.
function toPlainJson(value) {
  return JSON.parse(JSON.stringify(value));
}

// Purpose: copy the current message array before branching the conversation.
// How: shallow-copy each message object so a seasonal branch or comparison
// branch can append new messages without mutating the shared base history.
// Used by: runSession when it creates the 4 seasonal branches and the final
// comparison branch.
function cloneMessages(messages) {
  return messages.map((message) => ({ ...message }));
}

// Purpose: send one prompt history to OpenAI with required web search, timeout
// handling and retry logic.
// How: call the Responses API, force the web_search tool, abort after the
// configured timeout, and retry transient failures with exponential backoff.
// Used by: runSession for the general prompt, each follow-up branch and the
// comparison branch.
async function runChat(messages) {
  let attempt = 0;

  while (true) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      return await openai.responses.create(
        {
          model: MODEL_NAME,
          input: messages,
          tools: [
            {
              type: "web_search",
              search_context_size: WEB_SEARCH_CONTEXT_SIZE,
            },
          ],
          tool_choice: "required",
          include: ["web_search_call.action.sources"],
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
        `Retrying OpenAI call after error (attempt ${attempt + 1}/${MAX_API_RETRIES}, delay ${delayMs}ms): ${message}`,
      );

      attempt += 1;
      await sleep(delayMs);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// Purpose: create the session header row that marks one session as running,
// completed or failed.
// How: insert one row into session_runs using the profile id, interest group
// id, repeat index and model/provider metadata.
// Used by: runSession at start, and also in the failure path when a session
// must be recorded as failed.
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

// Purpose: update the status of an existing session header row.
// How: set status and error_message on session_runs for a known session_id.
// Used by: runSession when a transaction finishes successfully.
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

// Purpose: persist the first answer in a session, the general prompt answer.
// How: insert the prompt text, answer text, completion id and extracted source
// list into general_prompt_answers.
// Used by: runSession immediately after the first OpenAI response returns.
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

// Purpose: persist one of the 4 seasonal follow-up answers.
// How: insert both profile-level context and the specific seasonal interest row
// fields so each saved row is fully analyzable on its own.
// Used by: runSession inside the follow-up loop, once per seasonal branch.
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

// Purpose: persist the final comparison answer for the session.
// How: insert the comparison prompt, answer, completion id and sources into the
// dedicated comparison_prompt_results table.
// Used by: runSession once, after the seasonal follow-ups complete.
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

// Purpose: keep a lightweight in-memory trace of how the conversation branches
// evolved.
// How: store a label, current message count and current role sequence each time
// the session appends a meaningful prompt or answer.
// Used by: runSession only; the trace is returned to the caller for debugging.
function addTrace(trace, label, messages) {
  trace.push({
    label,
    messageCount: messages.length,
    roles: messages.map((message) => message.role),
  });
}

// Purpose: execute one complete experimental session: 1 general prompt,
// 4 seasonal follow-ups and 1 comparison prompt.
// How: load the profile and seasonal interest rows, start a DB transaction,
// build prompts, call OpenAI sequentially, save every answer, then commit on
// success or roll back and mark failure on error.
// Used by: main.js for one-off runs and model_batch.js for the large
// experiment loops.
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
    ensureUsableCompletion(generalCompletion, generalAnswer);
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
      ensureUsableCompletion(completion, answer);
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
      ensureUsableCompletion(completion, answer);
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
  MODEL_NAME,
  PROVIDER_NAME,
  createDbClient,
  getAllProfiles,
  getInterestGroupRows,
  runSession,
};
