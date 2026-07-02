const {
  RUN_NOTES,
  MODEL_NAME,
  PROVIDER_NAME,
  anthropic,
  createDbClient,
  parseBatchResult,
  getCurrentDatabaseName,
  upsertBatchRun,
  upsertBatchRequest,
} = require("./claude_batch_shared");

const BATCH_ID_FILTER = process.argv[2] || null;

async function getPendingBatchRuns(dbClient) {
  const params = [PROVIDER_NAME, MODEL_NAME];
  let sql = `
    SELECT *
    FROM claude_batch_runs
    WHERE provider_name = $1
      AND model_name = $2
      AND (processing_status <> 'ended' OR synced_at IS NULL)
  `;

  if (BATCH_ID_FILTER) {
    params.push(BATCH_ID_FILTER);
    sql += ` AND batch_id = $${params.length}`;
  }

  sql += " ORDER BY created_at";

  const result = await dbClient.query(sql, params);
  return result.rows;
}

async function syncBatchResults(dbClient, batchRow, currentBatch) {
  const results = await anthropic.messages.batches.results(batchRow.batch_id);

  for await (const item of results) {
    const parsed = parseBatchResult(item);
    const existingResult = await dbClient.query(
      `
        SELECT *
        FROM claude_batch_requests
        WHERE custom_id = $1
        LIMIT 1
      `,
      [item.custom_id],
    );

    const existingRow = existingResult.rows[0];
    if (!existingRow) {
      continue;
    }

    await upsertBatchRequest(dbClient, {
      batchId: batchRow.batch_id,
      customId: existingRow.custom_id,
      passType: existingRow.pass_type,
      sessionId: existingRow.session_id,
      profileId: existingRow.profile_id,
      interestGroupId: existingRow.interest_group_id,
      interestId: existingRow.interest_id,
      requestOrder: existingRow.request_order,
      requestKind: existingRow.request_kind,
      branchLabel: existingRow.branch_label,
      interestType: existingRow.interest_type,
      seasonName: existingRow.season_name,
      travelTimeFrame: existingRow.travel_time_frame,
      repeatIndex: existingRow.repeat_index,
      destinationName: existingRow.destination_name,
      providerName: existingRow.provider_name,
      modelName: existingRow.model_name,
      runNotes: existingRow.run_notes || RUN_NOTES,
      status: parsed.status,
      promptText: existingRow.prompt_text,
      messageHistory: existingRow.message_history_json || [],
      completionId: parsed.completionId,
      providerRequestId: parsed.providerRequestId,
      answerText: parsed.answerText,
      sources: parsed.sources,
      usage: parsed.usage,
      responseMeta: parsed.responseMeta,
      rawResult: parsed.rawResult,
      errorJson: parsed.errorJson,
      startedAt: existingRow.started_at,
      finishedAt: parsed.finishedAt,
      finalizedAt: existingRow.finalized_at,
    });
  }

  await upsertBatchRun(dbClient, {
    batchId: batchRow.batch_id,
    passType: batchRow.pass_type,
    destinationName: batchRow.destination_name,
    providerName: batchRow.provider_name,
    modelName: batchRow.model_name,
    runNotes: batchRow.run_notes || RUN_NOTES,
    processingStatus: currentBatch.processing_status,
    requestCounts: currentBatch.request_counts || null,
    rawBatch: currentBatch,
    endedAt: new Date().toISOString(),
    syncedAt: new Date().toISOString(),
  });
}

async function main() {
  const dbClient = createDbClient();
  await dbClient.connect();

  try {
    const databaseName = await getCurrentDatabaseName(dbClient);
    const batchRuns = await getPendingBatchRuns(dbClient);

    if (!batchRuns.length) {
      console.log("No Claude batches need polling.");
      return;
    }

    for (const batchRow of batchRuns) {
      const currentBatch = await anthropic.messages.batches.retrieve(batchRow.batch_id);

      await upsertBatchRun(dbClient, {
        batchId: batchRow.batch_id,
        passType: batchRow.pass_type,
        destinationName: batchRow.destination_name,
        providerName: batchRow.provider_name,
        modelName: batchRow.model_name,
        runNotes: batchRow.run_notes || RUN_NOTES,
        processingStatus: currentBatch.processing_status,
        requestCounts: currentBatch.request_counts || null,
        rawBatch: currentBatch,
        endedAt: currentBatch.processing_status === "ended" ? new Date().toISOString() : null,
        syncedAt: batchRow.synced_at,
      });

      if (currentBatch.processing_status === "ended" && !batchRow.synced_at) {
        await syncBatchResults(dbClient, batchRow, currentBatch);
      }

      console.log(
        `Batch ${batchRow.batch_id} -> ${currentBatch.processing_status} (${databaseName})`,
      );
    }
  } finally {
    await dbClient.end();
  }
}

main().catch((error) => {
  console.error("Claude batch poll failed:");
  console.error(error);
  process.exitCode = 1;
});
