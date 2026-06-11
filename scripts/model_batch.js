const {
  MODEL_NAME,
  PROVIDER_NAME,
  createDbClient,
  getAllProfiles,
  getInterestGroupRows,
  runSession,
} = require("./session_flow");

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

    console.log(`Profiles: ${profiles.length}`);
    if (PROFILE_ID_FILTER) {
      console.log(`Profile filter: ${PROFILE_ID_FILTER}`);
    }
    console.log(`Interest groups: ${interestGroups.length}`);
    console.log(`Repeat count: ${REPEAT_COUNT}`);
    console.log(`Total sessions: ${totalSessions}`);
    console.log(`Total prompts for this model: ${totalPrompts}`);
    console.log(`Save to DB: ${saveToDb ? "yes" : "no"}`);
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

            console.log(`  session_id: ${result.sessionId}`);
            console.log(`  completed prompts: ${completedPrompts}/${totalPrompts}`);
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
