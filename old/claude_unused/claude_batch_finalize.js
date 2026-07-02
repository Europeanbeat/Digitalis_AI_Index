const {
  RUN_NOTES,
  MODEL_NAME,
  PROVIDER_NAME,
  createDbClient,
  getProfile,
  saveSessionRun,
  updateSessionRunStatus,
  saveGeneralPromptAnswer,
  saveConstraintPromptAnswer,
  saveComparisonPromptAnswer,
  saveRequestLogEntry,
  getCurrentDatabaseName,
} = require("./claude_batch_shared");

const PROFILE_ID_FILTER = process.argv[2] ? Number(process.argv[2]) : null;
const INTEREST_TYPE_FILTER = process.argv[3] || null;
const REPEAT_INDEX_FILTER = process.argv[4] ? Number(process.argv[4]) : null;

async function assertTableExists(dbClient, tableName) {
  const result = await dbClient.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
      LIMIT 1
    `,
    [tableName],
  );

  if (!result.rows.length) {
    throw new Error(
      `Required table public.${tableName} is missing. Run the request_logs / Claude staging migrations before finalize.`,
    );
  }
}

async function getFinalizableSessions(dbClient) {
  const params = [PROVIDER_NAME, MODEL_NAME];
  const filters = [];

  if (PROFILE_ID_FILTER) {
    params.push(PROFILE_ID_FILTER);
    filters.push(`r.profile_id = $${params.length}`);
  }

  if (INTEREST_TYPE_FILTER) {
    params.push(INTEREST_TYPE_FILTER);
    filters.push(`r.interest_type = $${params.length}`);
  }

  if (REPEAT_INDEX_FILTER) {
    params.push(REPEAT_INDEX_FILTER);
    filters.push(`r.repeat_index = $${params.length}`);
  }

  const extraWhere = filters.length ? ` AND ${filters.join(" AND ")}` : "";

  const result = await dbClient.query(
    `
      SELECT
        r.session_id,
        r.profile_id,
        r.interest_group_id,
        r.repeat_index,
        r.destination_name,
        MIN(r.interest_type) AS interest_type
      FROM claude_batch_requests r
      WHERE r.provider_name = $1
        AND r.model_name = $2
        ${extraWhere}
      GROUP BY
        r.session_id,
        r.profile_id,
        r.interest_group_id,
        r.repeat_index,
        r.destination_name
      HAVING
        COUNT(*) FILTER (WHERE r.request_kind = 'general' AND r.status = 'succeeded') = 1
        AND COUNT(*) FILTER (WHERE r.request_kind = 'constraint' AND r.status = 'succeeded') = 4
        AND COUNT(*) FILTER (WHERE r.request_kind = 'comparison' AND r.status = 'succeeded') = 1
        AND COUNT(*) FILTER (WHERE r.finalized_at IS NOT NULL) = 0
      ORDER BY r.profile_id, r.interest_group_id, r.repeat_index
    `,
    params,
  );

  return result.rows;
}

async function getSessionRequests(dbClient, sessionId) {
  const result = await dbClient.query(
    `
      SELECT *
      FROM claude_batch_requests
      WHERE session_id = $1
      ORDER BY request_order
    `,
    [sessionId],
  );

  return result.rows;
}

async function sessionAlreadyCommitted(dbClient, sessionId) {
  const result = await dbClient.query(
    `
      SELECT 1
      FROM session_runs
      WHERE session_id = $1
      LIMIT 1
    `,
    [sessionId],
  );

  return result.rows.length > 0;
}

async function matchingCompletedSessionExists(
  dbClient,
  profileId,
  interestGroupId,
  repeatIndex,
) {
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
      LIMIT 1
    `,
    [profileId, interestGroupId, repeatIndex, PROVIDER_NAME, MODEL_NAME],
  );

  return result.rows.length > 0;
}

async function markSessionFinalized(dbClient, sessionId) {
  await dbClient.query(
    `
      UPDATE claude_batch_requests
      SET finalized_at = CURRENT_TIMESTAMP
      WHERE session_id = $1
    `,
    [sessionId],
  );
}

async function finalizeOneSession(dbClient, sessionRow) {
  const existingCommit = await sessionAlreadyCommitted(dbClient, sessionRow.session_id);
  const matchingCompleted = await matchingCompletedSessionExists(
    dbClient,
    sessionRow.profile_id,
    sessionRow.interest_group_id,
    sessionRow.repeat_index,
  );

  if (existingCommit || matchingCompleted) {
    await markSessionFinalized(dbClient, sessionRow.session_id);
    return "already_committed";
  }

  const profile = await getProfile(dbClient, sessionRow.profile_id);
  const requestRows = await getSessionRequests(dbClient, sessionRow.session_id);

  const generalRow = requestRows.find((row) => row.request_kind === "general");
  const comparisonRow = requestRows.find((row) => row.request_kind === "comparison");
  const constraintRows = requestRows.filter((row) => row.request_kind === "constraint");

  await dbClient.query("BEGIN");

  try {
    await saveSessionRun(
      dbClient,
      profile,
      sessionRow.session_id,
      sessionRow.interest_group_id,
      sessionRow.repeat_index,
      PROVIDER_NAME,
      MODEL_NAME,
      "running",
      null,
    );

    await saveGeneralPromptAnswer(
      dbClient,
      profile,
      sessionRow.session_id,
      sessionRow.repeat_index,
      PROVIDER_NAME,
      MODEL_NAME,
      generalRow.prompt_text,
      generalRow.answer_text,
      generalRow.completion_id,
      generalRow.sources_json || [],
    );

    for (const constraintRow of constraintRows) {
      await saveConstraintPromptAnswer(
        dbClient,
        profile,
        constraintRow,
        sessionRow.session_id,
        sessionRow.repeat_index,
        PROVIDER_NAME,
        MODEL_NAME,
        constraintRow.prompt_text,
        constraintRow.answer_text,
        constraintRow.completion_id,
        constraintRow.sources_json || [],
      );
    }

    await saveComparisonPromptAnswer(
      dbClient,
      profile,
      comparisonRow,
      sessionRow.session_id,
      sessionRow.repeat_index,
      PROVIDER_NAME,
      MODEL_NAME,
      comparisonRow.prompt_text,
      comparisonRow.answer_text,
      comparisonRow.completion_id,
      comparisonRow.sources_json || [],
    );

    for (const requestRow of requestRows) {
      await saveRequestLogEntry(dbClient, {
        sessionId: requestRow.session_id,
        profileId: requestRow.profile_id,
        interestGroupId: requestRow.interest_group_id,
        interestId: requestRow.interest_id,
        requestOrder: requestRow.request_order,
        requestKind: requestRow.request_kind,
        branchLabel: requestRow.branch_label,
        seasonName: requestRow.season_name,
        travelTimeFrame: requestRow.travel_time_frame,
        repeatIndex: requestRow.repeat_index,
        destinationName: requestRow.destination_name,
        providerName: requestRow.provider_name,
        modelName: requestRow.model_name,
        runNotes: requestRow.run_notes || RUN_NOTES,
        status: "completed",
        promptText: requestRow.prompt_text,
        messageHistory: requestRow.message_history_json || [],
        completionId: requestRow.completion_id,
        providerRequestId: requestRow.provider_request_id,
        answerText: requestRow.answer_text,
        sources: requestRow.sources_json || [],
        usage: requestRow.usage_json || null,
        responseMeta: requestRow.response_meta_json || null,
        errorMessage: null,
        startedAt: requestRow.started_at,
        finishedAt: requestRow.finished_at,
      });
    }

    await updateSessionRunStatus(dbClient, sessionRow.session_id, "completed", null);
    await markSessionFinalized(dbClient, sessionRow.session_id);

    await dbClient.query("COMMIT");
    return "committed";
  } catch (error) {
    await dbClient.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const dbClient = createDbClient();
  await dbClient.connect();

  try {
    await assertTableExists(dbClient, "request_logs");
    await assertTableExists(dbClient, "claude_batch_runs");
    await assertTableExists(dbClient, "claude_batch_requests");

    const databaseName = await getCurrentDatabaseName(dbClient);
    const sessions = await getFinalizableSessions(dbClient);

    if (!sessions.length) {
      console.log("No Claude sessions are ready to finalize.");
      return;
    }

    let committed = 0;
    let alreadyCommitted = 0;
    let failed = 0;

    for (const sessionRow of sessions) {
      try {
        const result = await finalizeOneSession(dbClient, sessionRow);
        if (result === "committed") {
          committed += 1;
        } else {
          alreadyCommitted += 1;
        }
      } catch (error) {
        failed += 1;
        console.error(
          `Finalize failed for session ${sessionRow.session_id}: ${error.message}`,
        );
      }
    }

    console.log(`Claude finalize complete for ${databaseName}`);
    console.log(`Committed sessions: ${committed}`);
    console.log(`Already committed sessions: ${alreadyCommitted}`);
    console.log(`Failed sessions: ${failed}`);
  } finally {
    await dbClient.end();
  }
}

main().catch((error) => {
  console.error("Claude batch finalize failed:");
  console.error(error);
  process.exitCode = 1;
});
