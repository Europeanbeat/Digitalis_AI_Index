const path = require("node:path");
const { Client } = require("pg");
const OpenAI = require("openai");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const PROFILE_ID = Number(process.argv[2] || 1);
const FOLLOW_UP_LIMIT = Number(process.argv[3] || 4);
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OpenAI_API_KEY;
const MODEL_NAME = process.env.OPENAI_MODEL || "gpt-4o-search-preview";

if (!OPENAI_API_KEY) {
  throw new Error(
    "Missing OPENAI_API_KEY. Add it to /Users/bence/Desktop/Digitális_AI_Index/.env",
  );
}

const dbClient = new Client({
  user: process.env.PGUSER || "postgres",
  host: process.env.PGHOST || "localhost",
  database: process.env.PGDATABASE || "digital_ai_index_db",
  password:
    process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || "Bence033",
  port: Number(process.env.PGPORT || 5432),
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function getProfile(profileId) {
  const result = await dbClient.query(
    "SELECT * FROM profiles WHERE profile_id = $1",
    [profileId],
  );

  if (!result.rows.length) {
    throw new Error(`No profile found for profile_id=${profileId}`);
  }

  return result.rows[0];
}

async function getTravelInterests(limit = FOLLOW_UP_LIMIT) {
  const result = await dbClient.query(
    `
      SELECT *
      FROM travel_interests
      ORDER BY interest_id
      LIMIT $1
    `,
    [limit],
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

async function runChat(messages) {
  return openai.chat.completions.create({
    model: MODEL_NAME,
    messages,
    web_search_options: {
      search_context_size: "low",
    },
  });
}

async function saveGeneralPromptAnswer(profileData, sessionId, promptText, answerText) {
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

async function main() {
  await dbClient.connect();

  try {
    const profileData = await getProfile(PROFILE_ID);
    const travelInterests = await getTravelInterests();
    const sessionId = createSessionId(profileData.profile_id);
    const generalPrompt = buildGeneralPrompt(profileData);

    const messages = [{ role: "user", content: generalPrompt }];
    const generalCompletion = await runChat(messages);
    const generalAnswerText = getAssistantText(generalCompletion);

    await saveGeneralPromptAnswer(
      profileData,
      sessionId,
      generalPrompt,
      generalAnswerText,
    );

    messages.push({ role: "assistant", content: generalAnswerText });

    console.log("PROFILE OBJECT:");
    console.dir(profileData, { depth: null });
    console.log("\nSESSION ID:");
    console.log(sessionId);
    console.log("\nGENERAL PROMPT:");
    console.log(generalPrompt);
    console.log("\nGENERAL ANSWER:");
    console.log(generalAnswerText);
    printSources(extractWebSources(generalCompletion));

    for (const interestRow of travelInterests) {
      const constraintPrompt = buildConstraintPrompt(interestRow);
      messages.push({ role: "user", content: constraintPrompt });

      const completion = await runChat(messages);
      const answerText = getAssistantText(completion);

      await saveConstraintPromptAnswer(
        profileData,
        interestRow,
        sessionId,
        constraintPrompt,
        answerText,
      );

      console.log(
        `\nFOLLOW-UP [${interestRow.interest_id}] ${interestRow.interest_type} / ${interestRow.season_name}:`,
      );
      console.log(constraintPrompt);
      console.log("\nANSWER:");
      console.log(answerText);
      printSources(extractWebSources(completion));

      messages.push({ role: "assistant", content: answerText });
    }
  } finally {
    await dbClient.end();
  }
}

main().catch((error) => {
  console.error("\nScript failed:");
  console.error(error);
  process.exitCode = 1;
});
