const path = require("node:path");
const { Client } = require("pg");
const OpenAI = require("openai");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const MODEL_NAME = process.env.OPENAI_MODEL || "gpt-4o-search-preview";
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.OpenAI_API_KEY ||
  process.env.OpenAI_APIKey ||
  process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  throw new Error(
    "Missing OPENAI_API_KEY. Add it to /Users/bence/Desktop/Digitális_AI_Index/.env",
  );
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

async function getTravelInterests(dbClient, limit) {
  const safeLimit = Number(limit) > 0 ? Number(limit) : 4;

  const result = await dbClient.query(
    `
      SELECT *
      FROM travel_interests
      ORDER BY interest_id
      LIMIT $1
    `,
    [safeLimit],
  );

  return result.rows;
}

function buildGeneralPrompt(profileData) {
  const stayText = `${profileData.stay_nights} éjszakára`;
  const budgetText = `max ${profileData.budget_per_day_eur} euro per nap per fő`;

  return `Én egy ${profileData.age} éves, ${profileData.gender} vagyok ${profileData.origin_country}, szeretnék ${profileData.travel_party}, ${stayText} ${profileData.destination_name} menni. Tudnál a térségben programokat ajánlani nekünk ${budgetText} költséggel?`;
}

function buildConstraintPrompt(interestRow) {
  return `Kifejezetten ezek érdekelnek: ${interestRow.interest_attributes}. Ajánlj 5 helyet a térségben ${interestRow.travel_time_frame}.`;
}

function buildComparisonPrompt(profileData, interestRow) {
  return `${profileData.destination_name} kívül tudnál ajánlani még öt másik tóparti desztinációt Európában, ahol kifejezetten jó a ${interestRow.interest_type.toLowerCase()} kínálat és illik a profilomhoz és pénztárcámhoz?`;
}

function createSessionId(profileId) {
  return `session_${profileId}_${Date.now()}`;
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

async function runChat(messages) {
  return openai.chat.completions.create({
    model: MODEL_NAME,
    messages,
    web_search_options: {
      search_context_size: "low",
    },
  });
}

async function saveGeneralPromptAnswer(dbClient, profileData, sessionId, promptText, answerText) {
  await dbClient.query(
    `
      INSERT INTO general_prompt_answers (
        profile_id,
        destination_name,
        model_name,
        session_id,
        prompt_text,
        general_prompt_answer
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [
      profileData.profile_id,
      profileData.destination_name,
      MODEL_NAME,
      sessionId,
      promptText,
      answerText,
    ],
  );
}

async function saveConstraintPromptAnswer(
  dbClient,
  profileData,
  interestRow,
  sessionId,
  promptText,
  answerText,
) {
  await dbClient.query(
    `
      INSERT INTO constraint_prompt_answers (
        profile_id,
        interest_id,
        destination_name,
        interest_type,
        season_name,
        travel_time_frame,
        model_name,
        session_id,
        prompt_text,
        constraint_prompt_answer
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `,
    [
      profileData.profile_id,
      interestRow.interest_id,
      profileData.destination_name,
      interestRow.interest_type,
      interestRow.season_name,
      interestRow.travel_time_frame,
      MODEL_NAME,
      sessionId,
      promptText,
      answerText,
    ],
  );
}

async function saveComparisonPromptAnswer(
  dbClient,
  profileData,
  interestRow,
  sessionId,
  promptText,
  answerText,
) {
  await dbClient.query(
    `
      INSERT INTO comparison_prompt_results (
        profile_id,
        interest_id,
        destination_name,
        interest_type,
        season_name,
        travel_time_frame,
        model_name,
        session_id,
        prompt_text,
        comparison_prompt_answer
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `,
    [
      profileData.profile_id,
      interestRow.interest_id,
      profileData.destination_name,
      interestRow.interest_type,
      interestRow.season_name,
      interestRow.travel_time_frame,
      MODEL_NAME,
      sessionId,
      promptText,
      answerText,
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
  const saveToDb = Boolean(options.saveToDb);
  const dbClient = createDbClient();

  await dbClient.connect();

  try {
    const profileData = await getProfile(dbClient, profileId);
    const travelInterests = await getTravelInterests(dbClient, followUpLimit);
    const sessionId = createSessionId(profileData.profile_id);
    const messages = [];
    const trace = [];

    addTrace(trace, "Kezdet: üres messages tömb", messages);

    const generalPrompt = buildGeneralPrompt(profileData);
    messages.push({ role: "user", content: generalPrompt });
    addTrace(trace, "General prompt bekerült", messages);

    const generalCompletion = await runChat(messages);
    const generalAnswer = getAssistantText(generalCompletion);
    messages.push({ role: "assistant", content: generalAnswer });
    addTrace(trace, "General answer bekerült", messages);

    if (saveToDb) {
      await saveGeneralPromptAnswer(
        dbClient,
        profileData,
        sessionId,
        generalPrompt,
        generalAnswer,
      );
    }

    const followUps = [];

    for (const interestRow of travelInterests) {
      const prompt = buildConstraintPrompt(interestRow);
      messages.push({ role: "user", content: prompt });
      addTrace(
        trace,
        `Constraint user prompt bekerült: ${interestRow.interest_type} / ${interestRow.season_name}`,
        messages,
      );

      const completion = await runChat(messages);
      const answer = getAssistantText(completion);
      messages.push({ role: "assistant", content: answer });
      addTrace(
        trace,
        `Constraint answer bekerült: ${interestRow.interest_type} / ${interestRow.season_name}`,
        messages,
      );

      if (saveToDb) {
        await saveConstraintPromptAnswer(
          dbClient,
          profileData,
          interestRow,
          sessionId,
          prompt,
          answer,
        );
      }

      followUps.push({
        interestId: interestRow.interest_id,
        interestType: interestRow.interest_type,
        seasonName: interestRow.season_name,
        travelTimeFrame: interestRow.travel_time_frame,
        completionId: completion.id,
        prompt,
        answer,
        sources: extractWebSources(completion),
        rawApiResponse: toPlainJson(completion),
      });
    }

    let comparison = null;

    if (travelInterests.length) {
      const lastInterest = travelInterests[travelInterests.length - 1];
      const prompt = buildComparisonPrompt(profileData, lastInterest);
      messages.push({ role: "user", content: prompt });
      addTrace(trace, "Comparison prompt bekerült", messages);

      const completion = await runChat(messages);
      const answer = getAssistantText(completion);
      messages.push({ role: "assistant", content: answer });
      addTrace(trace, "Comparison answer bekerült", messages);

      if (saveToDb) {
        await saveComparisonPromptAnswer(
          dbClient,
          profileData,
          lastInterest,
          sessionId,
          prompt,
          answer,
        );
      }

      comparison = {
        interestId: lastInterest.interest_id,
        interestType: lastInterest.interest_type,
        seasonName: lastInterest.season_name,
        travelTimeFrame: lastInterest.travel_time_frame,
        completionId: completion.id,
        prompt,
        answer,
        sources: extractWebSources(completion),
        rawApiResponse: toPlainJson(completion),
      };
    }

    return {
      sessionId,
      modelName: MODEL_NAME,
      saveToDb,
      profile: profileData,
      trace,
      general: {
        completionId: generalCompletion.id,
        prompt: generalPrompt,
        answer: generalAnswer,
        sources: extractWebSources(generalCompletion),
        rawApiResponse: toPlainJson(generalCompletion),
      },
      followUps,
      comparison,
    };
  } finally {
    await dbClient.end();
  }
}

module.exports = {
  runSession,
};
