const {
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
} = require("./session_flow_claude");

const REPEAT_COUNT = Number(process.env.REPEAT_COUNT || 5);
const SESSION_DELAY_MS = Number(process.env.SESSION_DELAY_MS || 0);
const PROFILE_ID_FILTER = process.env.PROFILE_ID
  ? Number(process.env.PROFILE_ID)
  : null;
const ESTIMATED_SECONDS_PER_SESSION = Number(
  process.env.ESTIMATED_SECONDS_PER_SESSION || 45,
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Claude Sonnet 4.6 SYNC rates ($3 / $15 per 1M input/output). Web search is a
// server tool billed separately (~$10 / 1000 searches; treat as an estimate).
const INPUT_TOKEN_RATE = 3 / 1_000_000;
const OUTPUT_TOKEN_RATE = 15 / 1_000_000;
const WEB_SEARCH_RATE = 10 / 1000;

function usd(value) {
  return "$" + value.toFixed(3);
}

// Sum token usage across a completed session's 6 responses using the raw API
// responses runSession already returns (general + follow-ups + comparison).
function sumSessionUsage(result) {
  const parts = [
    result.general,
    ...(result.followUps || []),
    result.comparison,
  ].filter(Boolean);

  let input = 0;
  let output = 0;
  let searches = 0;

  for (const part of parts) {
    const usage = part.rawApiResponse && part.rawApiResponse.usage;
    if (!usage) {
      continue;
    }
    input += Number(usage.input_tokens || 0);
    output += Number(usage.output_tokens || 0);
    searches += Number(
      (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0,
    );
  }

  return { input, output, searches };
}

async function sessionAlreadyExists(
  dbClient,
  profileId,
  interestGroupId,
  repeatIndex,
) {
  const result = await dbClient.query(
    `
      SELECT session_id
      FROM session_runs
      WHERE profile_id = $1
        AND interest_group_id = $2
        AND repeat_index = $3
        AND provider_name = $4
        AND model_name = $5
        AND status = 'completed'
      LIMIT 1
    `,
    [
      profileId,
      interestGroupId,
      repeatIndex,
      PROVIDER_NAME,
      MODEL_NAME,
    ],
  );

  return result.rows[0] || null;
}

async function main() {
  const saveToDb = process.argv.includes("--save");
  const startedAt = Date.now();
  const dbClient = createDbClient();

  await dbClient.connect();

  let profiles = [];
  let interestGroups = [];

  try {
    profiles = await getAllProfiles(dbClient);
    interestGroups = await getInterestGroupRows(dbClient);
    if (PROFILE_ID_FILTER) {
      profiles = profiles.filter(
        (profileRow) => profileRow.profile_id === PROFILE_ID_FILTER,
      );
    }

    if (!profiles.length) {
      throw new Error(
        PROFILE_ID_FILTER
          ? `No profiles found for PROFILE_ID=${PROFILE_ID_FILTER}`
          : "No profiles found.",
      );
    }

    const totalSessions = profiles.length * interestGroups.length * REPEAT_COUNT;
    const promptsPerSession = 6;
    const totalPrompts = totalSessions * promptsPerSession;

    let completedSessions = 0;
    let completedPrompts = 0;
    let successfulSessions = 0;
    let skippedSessions = 0;
    let failedSessions = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalSearches = 0;

    console.log(`Profiles: ${profiles.length}`);
    if (PROFILE_ID_FILTER) {
      console.log(`Profile filter: ${PROFILE_ID_FILTER}`);
    }
    console.log(`Interest groups: ${interestGroups.length}`);
    console.log(`Repeat count: ${REPEAT_COUNT}`);
    console.log(`Total sessions: ${totalSessions}`);
    console.log(`Total prompts for this model: ${totalPrompts}`);
    console.log(`Save to DB: ${saveToDb ? "yes" : "no"}`);
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
    console.log(`Anthropic max pause turns: ${MAX_PAUSE_TURNS}`);
    console.log(
      `Anthropic max provider events/request: ${MAX_PROVIDER_EVENTS_PER_REQUEST}`,
    );
    console.log(
      `Anthropic low-output pause guard: ${MAX_CONSECUTIVE_LOW_OUTPUT_PAUSE_TURNS} turns at <= ${LOW_OUTPUT_TOKEN_THRESHOLD} output tokens`,
    );
    console.log(`Run notes: ${RUN_NOTES || "(none)"}`);
    console.log(`Session delay (ms): ${SESSION_DELAY_MS}`);
    console.log(
      `Estimated runtime: ~${Math.round(
        (totalSessions * ESTIMATED_SECONDS_PER_SESSION) / 3600,
      )} hours`,
    );

    for (const profileRow of profiles) {
      console.log(`\nPROFILE ${profileRow.profile_id} / ${profileRow.destination_name}`);

      for (const interestGroup of interestGroups) {
        for (let repeatIndex = 1; repeatIndex <= REPEAT_COUNT; repeatIndex += 1) {
          completedSessions += 1;

          console.log(
            `Session ${completedSessions}/${totalSessions} -> profile ${profileRow.profile_id}, group: ${interestGroup.interest_type}, repeat: ${repeatIndex}`,
          );

          if (saveToDb) {
            const existingSession = await sessionAlreadyExists(
              dbClient,
              profileRow.profile_id,
              interestGroup.interest_group_id,
              repeatIndex,
            );

            if (existingSession) {
              skippedSessions += 1;
              completedPrompts += promptsPerSession;
              console.log(`  skipped existing session_id: ${existingSession.session_id}`);
              console.log(`  completed prompts: ${completedPrompts}/${totalPrompts}`);
              continue;
            }
          }

          try {
            const result = await runSession({
              profileId: profileRow.profile_id,
              interestType: interestGroup.interest_type,
              followUpLimit: 4,
              repeatIndex,
              saveToDb,
            });

            successfulSessions += 1;
            completedPrompts += promptsPerSession;

            const usage = sumSessionUsage(result);
            totalInputTokens += usage.input;
            totalOutputTokens += usage.output;
            totalSearches += usage.searches;
            const sessionCost =
              usage.input * INPUT_TOKEN_RATE +
              usage.output * OUTPUT_TOKEN_RATE +
              usage.searches * WEB_SEARCH_RATE;
            const runningCost =
              totalInputTokens * INPUT_TOKEN_RATE +
              totalOutputTokens * OUTPUT_TOKEN_RATE +
              totalSearches * WEB_SEARCH_RATE;

            console.log(`  session_id: ${result.sessionId}`);
            console.log(`  completed prompts: ${completedPrompts}/${totalPrompts}`);
            console.log(
              `  tokens: in ${usage.input} · out ${usage.output} · searches ${usage.searches} · ~${usd(sessionCost)}`,
            );
            console.log(
              `  running total: in ${totalInputTokens} · out ${totalOutputTokens} · searches ${totalSearches} · ~${usd(runningCost)}`,
            );
          } catch (error) {
            failedSessions += 1;
            console.error(`  FAILED: ${error.message}`);
          }

          if (SESSION_DELAY_MS > 0) {
            await sleep(SESSION_DELAY_MS);
          }
        }
      }
    }

    console.log("\nBatch completed.");
    console.log(`Successful sessions: ${successfulSessions}`);
    console.log(`Skipped sessions: ${skippedSessions}`);
    console.log(`Failed sessions: ${failedSessions}`);
    console.log(
      `Total tokens: in ${totalInputTokens} · out ${totalOutputTokens} · searches ${totalSearches}`,
    );
    console.log(
      `Estimated cost: ${usd(
        totalInputTokens * INPUT_TOKEN_RATE +
          totalOutputTokens * OUTPUT_TOKEN_RATE +
          totalSearches * WEB_SEARCH_RATE,
      )} (Sonnet 4.6 sync rates $3/$15 per 1M; web search est. $10/1k)`,
    );
    console.log(
      `Elapsed minutes: ${((Date.now() - startedAt) / 1000 / 60).toFixed(1)}`,
    );
  } finally {
    await dbClient.end();
  }
}

main().catch((error) => {
  console.error("\nBatch failed:");
  console.error(error);
  process.exitCode = 1;
});
