const {
  RUN_NOTES,
  MODEL_NAME,
  PROVIDER_NAME,
  anthropic,
  createDbClient,
  getProfile,
  getTravelInterests,
  buildConstraintPrompt,
  buildComparisonPrompt,
  buildBatchRequestParams,
  buildBatchCustomId,
  cloneClaudeMessages,
  getCurrentDatabaseName,
  upsertBatchRun,
  upsertBatchRequest,
} = require("./claude_batch_shared");

const FOLLOW_UP_LIMIT = Number(process.env.FOLLOW_UP_LIMIT || 4);
const PROFILE_ID_FILTER = process.argv[2] ? Number(process.argv[2]) : null;
const INTEREST_TYPE_FILTER = process.argv[3] || null;
const REPEAT_INDEX_FILTER = process.argv[4] ? Number(process.argv[4]) : null;
const BRANCH_TRACKED_STATUSES = new Set(["submitting", "queued", "succeeded"]);

async function getEligibleGeneralRows(dbClient) {
  const filters = [];
  const params = [];

  if (PROFILE_ID_FILTER) {
    params.push(PROFILE_ID_FILTER);
    filters.push(`g.profile_id = $${params.length}`);
  }

  if (INTEREST_TYPE_FILTER) {
    params.push(INTEREST_TYPE_FILTER);
    filters.push(`g.interest_type = $${params.length}`);
  }

  if (REPEAT_INDEX_FILTER) {
    params.push(REPEAT_INDEX_FILTER);
    filters.push(`g.repeat_index = $${params.length}`);
  }

  const whereClause = filters.length ? ` AND ${filters.join(" AND ")}` : "";

  const result = await dbClient.query(
    `
      SELECT g.*
      FROM claude_batch_requests g
      WHERE g.request_kind = 'general'
        AND g.status = 'succeeded'
        ${whereClause}
      ORDER BY g.profile_id, g.interest_group_id, g.repeat_index
    `,
    params,
  );

  return result.rows;
}

async function getExistingBranchRows(dbClient, sessionId) {
  const result = await dbClient.query(
    `
      SELECT *
      FROM claude_batch_requests
      WHERE session_id = $1
        AND request_kind IN ('constraint', 'comparison')
    `,
    [sessionId],
  );

  return result.rows;
}

async function main() {
  const dbClient = createDbClient();
  await dbClient.connect();

  try {
    const databaseName = await getCurrentDatabaseName(dbClient);
    const generalRows = await getEligibleGeneralRows(dbClient);

    if (!generalRows.length) {
      console.log("No Claude general rows are ready for branch batching.");
      return;
    }

    const requestPayloads = [];
    const stagedRows = [];

    for (const generalRow of generalRows) {
      const profile = await getProfile(dbClient, generalRow.profile_id);
      const interestRows = await getTravelInterests(dbClient, {
        interestType: generalRow.interest_type,
        limit: FOLLOW_UP_LIMIT,
      });
      const existingBranchRows = await getExistingBranchRows(dbClient, generalRow.session_id);
      const existingBranchByKey = new Map(
        existingBranchRows.map((row) => {
          const key =
            row.request_kind === "constraint"
              ? `constraint:${row.interest_id}`
              : "comparison";
          return [key, row];
        }),
      );

      if (interestRows.length < FOLLOW_UP_LIMIT) {
        throw new Error(
          `Expected ${FOLLOW_UP_LIMIT} travel interests for ${generalRow.interest_type}, got ${interestRows.length}.`,
        );
      }

      const baseMessages = [
        ...cloneClaudeMessages(generalRow.message_history_json || []),
        { role: "assistant", content: generalRow.answer_text },
      ];

      for (const [index, interestRow] of interestRows.entries()) {
        const promptText = buildConstraintPrompt(interestRow);
        const messageHistory = [
          ...cloneClaudeMessages(baseMessages),
          { role: "user", content: promptText },
        ];
        const customId = buildBatchCustomId({
          destinationName: generalRow.destination_name,
          profileId: generalRow.profile_id,
          interestGroupId: generalRow.interest_group_id,
          repeatIndex: generalRow.repeat_index,
          requestKind: "constraint",
          interestId: interestRow.interest_id,
        });
        const existingRow = existingBranchByKey.get(`constraint:${interestRow.interest_id}`);

        if (existingRow && BRANCH_TRACKED_STATUSES.has(existingRow.status)) {
          continue;
        }

        requestPayloads.push({
          custom_id: customId,
          params: buildBatchRequestParams(messageHistory),
        });

        stagedRows.push({
          batchId: null,
          customId,
          passType: "branch",
          sessionId: generalRow.session_id,
          profileId: generalRow.profile_id,
          interestGroupId: generalRow.interest_group_id,
          interestId: interestRow.interest_id,
          requestOrder: index + 2,
          requestKind: "constraint",
          branchLabel: `${interestRow.interest_type} / ${interestRow.season_name}`,
          interestType: interestRow.interest_type,
          seasonName: interestRow.season_name,
          travelTimeFrame: interestRow.travel_time_frame,
          repeatIndex: generalRow.repeat_index,
          destinationName: generalRow.destination_name,
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

      const comparisonPrompt = buildComparisonPrompt(profile, interestRows[0]);
      const comparisonHistory = [
        ...cloneClaudeMessages(baseMessages),
        { role: "user", content: comparisonPrompt },
      ];
      const comparisonCustomId = buildBatchCustomId({
        destinationName: generalRow.destination_name,
        profileId: generalRow.profile_id,
        interestGroupId: generalRow.interest_group_id,
        repeatIndex: generalRow.repeat_index,
        requestKind: "comparison",
      });
      const existingComparisonRow = existingBranchByKey.get("comparison");

      if (!existingComparisonRow || !BRANCH_TRACKED_STATUSES.has(existingComparisonRow.status)) {
        requestPayloads.push({
          custom_id: comparisonCustomId,
          params: buildBatchRequestParams(comparisonHistory),
        });

        stagedRows.push({
          batchId: null,
          customId: comparisonCustomId,
          passType: "branch",
          sessionId: generalRow.session_id,
          profileId: generalRow.profile_id,
          interestGroupId: generalRow.interest_group_id,
          interestId: null,
          requestOrder: 6,
          requestKind: "comparison",
          branchLabel: "comparison",
          interestType: interestRows[0].interest_type,
          seasonName: null,
          travelTimeFrame: null,
          repeatIndex: generalRow.repeat_index,
          destinationName: generalRow.destination_name,
          providerName: PROVIDER_NAME,
          modelName: MODEL_NAME,
          runNotes: RUN_NOTES,
          status: "queued",
          promptText: comparisonPrompt,
          messageHistory: comparisonHistory,
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

    if (!requestPayloads.length) {
      console.log("No Claude branch requests need queueing or requeueing.");
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
        passType: "branch",
        destinationName: generalRows[0]?.destination_name || null,
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

    console.log(`Queued Claude branch batch: ${batch.id}`);
    console.log(`Database: ${databaseName}`);
    console.log(`Requests queued: ${requestPayloads.length}`);
  } finally {
    await dbClient.end();
  }
}

main().catch((error) => {
  console.error("Claude branch batch prepare failed:");
  console.error(error);
  process.exitCode = 1;
});
