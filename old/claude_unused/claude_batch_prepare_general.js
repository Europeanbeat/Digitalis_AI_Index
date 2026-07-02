const {
  RUN_NOTES,
  MODEL_NAME,
  PROVIDER_NAME,
  anthropic,
  createDbClient,
  getAllProfiles,
  getInterestGroupRows,
  buildGeneralPrompt,
  buildBatchRequestParams,
  buildBatchSessionId,
  buildBatchCustomId,
  getCurrentDatabaseName,
  upsertBatchRun,
  upsertBatchRequest,
} = require("./claude_batch_shared");

const REPEAT_COUNT = Number(process.env.REPEAT_COUNT || 5);
const PROFILE_ID_FILTER = process.argv[2] ? Number(process.argv[2]) : null;
const INTEREST_TYPE_FILTER = process.argv[3] || null;
const REPEAT_INDEX_FILTER = process.argv[4] ? Number(process.argv[4]) : null;
const GENERAL_TRACKED_STATUSES = ["submitting", "queued", "succeeded"];

async function sessionAlreadyTracked(dbClient, profileId, interestGroupId, repeatIndex, sessionId) {
  const result = await dbClient.query(
    `
      SELECT 1
      FROM session_runs
      WHERE profile_id = $1
        AND interest_group_id = $2
        AND repeat_index = $3
        AND provider_name = $4
        AND model_name = $5
        AND status = 'completed'
      UNION ALL
      SELECT 1
      FROM claude_batch_requests
      WHERE session_id = $6
        AND request_kind = 'general'
        AND status = ANY($7::text[])
      LIMIT 1
    `,
    [
      profileId,
      interestGroupId,
      repeatIndex,
      PROVIDER_NAME,
      MODEL_NAME,
      sessionId,
      GENERAL_TRACKED_STATUSES,
    ],
  );

  return result.rows.length > 0;
}

async function main() {
  const dbClient = createDbClient();
  await dbClient.connect();

  try {
    const databaseName = await getCurrentDatabaseName(dbClient);
    let profiles = await getAllProfiles(dbClient);
    let interestGroups = await getInterestGroupRows(dbClient);

    if (PROFILE_ID_FILTER) {
      profiles = profiles.filter((profile) => profile.profile_id === PROFILE_ID_FILTER);
    }

    if (INTEREST_TYPE_FILTER) {
      interestGroups = interestGroups.filter(
        (group) => group.interest_type === INTEREST_TYPE_FILTER,
      );
    }

    const requestPayloads = [];
    const stagedRows = [];

    for (const profile of profiles) {
      for (const interestGroup of interestGroups) {
        const repeatIndexes = REPEAT_INDEX_FILTER
          ? [REPEAT_INDEX_FILTER]
          : Array.from({ length: REPEAT_COUNT }, (_, index) => index + 1);

        for (const repeatIndex of repeatIndexes) {
          const sessionId = buildBatchSessionId(
            profile.profile_id,
            interestGroup.interest_group_id,
            repeatIndex,
          );

          const alreadyTracked = await sessionAlreadyTracked(
            dbClient,
            profile.profile_id,
            interestGroup.interest_group_id,
            repeatIndex,
            sessionId,
          );

          if (alreadyTracked) {
            continue;
          }

          const promptText = buildGeneralPrompt(profile);
          const messageHistory = [{ role: "user", content: promptText }];
          const customId = buildBatchCustomId({
            destinationName: profile.destination_name,
            profileId: profile.profile_id,
            interestGroupId: interestGroup.interest_group_id,
            repeatIndex,
            requestKind: "general",
          });

          requestPayloads.push({
            custom_id: customId,
            params: buildBatchRequestParams(messageHistory),
          });

          stagedRows.push({
            batchId: null,
            customId,
            passType: "general",
            sessionId,
            profileId: profile.profile_id,
            interestGroupId: interestGroup.interest_group_id,
            interestId: null,
            requestOrder: 1,
            requestKind: "general",
            branchLabel: "general",
            interestType: interestGroup.interest_type,
            seasonName: null,
            travelTimeFrame: null,
            repeatIndex,
            destinationName: profile.destination_name,
            providerName: PROVIDER_NAME,
            modelName: MODEL_NAME,
            runNotes: RUN_NOTES,
            status: "queued",
            promptText,
            messageHistory,
            completionId: null,
            providerRequestId: null,
            answerText: null,
            sources: [],
            usage: null,
            responseMeta: null,
            rawResult: null,
            errorJson: null,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            finalizedAt: null,
          });
        }
      }
    }

    if (!requestPayloads.length) {
      console.log("No new Claude general requests to queue.");
      return;
    }

    await dbClient.query("BEGIN");
    try {
      for (const row of stagedRows) {
        await upsertBatchRequest(dbClient, {
          ...row,
          status: "submitting",
          batchId: null,
        });
      }
      await dbClient.query("COMMIT");
    } catch (error) {
      await dbClient.query("ROLLBACK");
      throw error;
    }

    const batch = await anthropic.messages.batches.create({
      requests: requestPayloads,
    });

    await dbClient.query("BEGIN");
    try {
      await upsertBatchRun(dbClient, {
        batchId: batch.id,
        passType: "general",
        destinationName: profiles[0]?.destination_name || null,
        providerName: PROVIDER_NAME,
        modelName: MODEL_NAME,
        runNotes: RUN_NOTES,
        processingStatus: batch.processing_status,
        requestCounts: batch.request_counts || null,
        rawBatch: batch,
        endedAt: batch.processing_status === "ended" ? new Date().toISOString() : null,
        syncedAt: null,
      });

      for (const row of stagedRows) {
        await upsertBatchRequest(dbClient, {
          ...row,
          batchId: batch.id,
          status: "queued",
        });
      }

      await dbClient.query("COMMIT");
    } catch (error) {
      await dbClient.query("ROLLBACK");
      throw error;
    }

    console.log(`Queued Claude general batch: ${batch.id}`);
    console.log(`Database: ${databaseName}`);
    console.log(`Requests queued: ${requestPayloads.length}`);
  } finally {
    await dbClient.end();
  }
}

main().catch((error) => {
  console.error("Claude general batch prepare failed:");
  console.error(error);
  process.exitCode = 1;
});
