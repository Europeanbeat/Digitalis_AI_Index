const path = require("node:path");
const { Client } = require("pg");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RUN_NOTES = process.env.RUN_NOTES || null;

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
          ig.motivation AS group_motivation,
          ti.motivation AS seasonal_motivation,
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
        ig.motivation AS group_motivation,
        ti.motivation AS seasonal_motivation,
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
  const recommendationTarget =
    typeof profileData.travel_party === "string" &&
    profileData.travel_party.toLowerCase().includes("on my own")
      ? "for me"
      : "for us";

  return `I am a ${profileData.age}-year-old ${profileData.gender}. I would like to travel to ${profileData.destination_name} for ${profileData.stay_nights} nights ${profileData.travel_party}. Could you recommend some activities and programmes in the area ${recommendationTarget} within a budget of max ${budget} EUR per person per day?`;
}

function getConstraintMotivation(interestRow) {
  return interestRow.seasonal_motivation || interestRow.group_motivation;
}

function buildConstraintPrompt(interestRow) {
  const motivation = getConstraintMotivation(interestRow);

  if (!motivation) {
    throw new Error(
      `Missing constraint motivation for interest_group_id=${interestRow.interest_group_id}`,
    );
  }

  return `On this trip I am travelling mainly to ${motivation}. Could you recommend 5 places in the area ${interestRow.travel_time_frame}?`;
}

function buildComparisonPrompt(profileData, interestRow) {
  if (!interestRow.group_motivation) {
    throw new Error(
      `Missing group motivation for interest_group_id=${interestRow.interest_group_id}`,
    );
  }

  return `Besides ${profileData.destination_name}, could you recommend five other lakeside destinations in Europe where I could best ${interestRow.group_motivation}, and which also fit my profile and budget?`;
}

function createSessionId(profileId, interestGroupId, repeatIndex) {
  return `session_${profileId}_${interestGroupId}_${repeatIndex}_${Date.now()}`;
}

function toPlainJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function addTrace(trace, label, messages) {
  trace.push({
    label,
    messageCount: messages.length,
    roles: messages.map((message) => message.role),
  });
}

async function saveSessionRun(
  dbClient,
  profileData,
  sessionId,
  interestGroupId,
  repeatIndex,
  providerName,
  modelName,
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
        run_notes,
        status,
        error_message
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `,
    [
      sessionId,
      profileData.profile_id,
      interestGroupId,
      repeatIndex,
      profileData.destination_name,
      providerName,
      modelName,
      RUN_NOTES,
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
  providerName,
  modelName,
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
      providerName,
      modelName,
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
  providerName,
  modelName,
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
      providerName,
      modelName,
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
  providerName,
  modelName,
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
      providerName,
      modelName,
      promptText,
      answerText,
      completionId,
      JSON.stringify(sources),
    ],
  );
}

async function saveRequestLogEntry(
  dbClient,
  payload,
) {
  await dbClient.query(
    `
      INSERT INTO request_logs (
        session_id,
        profile_id,
        interest_group_id,
        interest_id,
        request_order,
        request_kind,
        branch_label,
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
        error_message,
        started_at,
        finished_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb,
        $18, $19, $20, $21::jsonb, $22::jsonb, $23::jsonb, $24, $25, $26
      )
    `,
    [
      payload.sessionId,
      payload.profileId,
      payload.interestGroupId,
      payload.interestId || null,
      payload.requestOrder,
      payload.requestKind,
      payload.branchLabel || null,
      payload.seasonName || null,
      payload.travelTimeFrame || null,
      payload.repeatIndex,
      payload.destinationName || null,
      payload.providerName,
      payload.modelName,
      payload.runNotes ?? RUN_NOTES,
      payload.status || "completed",
      payload.promptText,
      JSON.stringify(payload.messageHistory || []),
      payload.completionId || null,
      payload.providerRequestId || null,
      payload.answerText || null,
      JSON.stringify(payload.sources || []),
      JSON.stringify(payload.usage || null),
      JSON.stringify(payload.responseMeta || null),
      payload.errorMessage || null,
      payload.startedAt || null,
      payload.finishedAt || null,
    ],
  );
}

module.exports = {
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
};
