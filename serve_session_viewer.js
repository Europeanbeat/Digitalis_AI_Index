const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");
const { Client } = require("pg");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { listLiveSessions } = require("./scripts/live_trace_store");

const PORT = Number(process.env.SESSION_VIEWER_PORT || 8760);
const HTML_FILE = path.join(__dirname, "session_viewer.html");
const DB_PREFIX = process.env.SESSION_VIEWER_DB_PREFIX || "digital_ai_index";
const DEFAULT_LIMIT = Number(process.env.SESSION_VIEWER_DEFAULT_LIMIT || 120);

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function validateDatabaseName(databaseName) {
  return (
    typeof databaseName === "string" &&
    databaseName.startsWith(DB_PREFIX) &&
    /^[a-zA-Z0-9_]+$/.test(databaseName)
  );
}

function createClient(database) {
  return new Client({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database,
  });
}

async function withDb(database, callback) {
  if (!validateDatabaseName(database)) {
    throw new Error(`Invalid database name: ${database}`);
  }

  const client = createClient(database);
  await client.connect();

  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

async function getTablePresence(dbClient) {
  const result = await dbClient.query(`
    SELECT
      to_regclass('public.request_logs') AS request_logs_table,
      to_regclass('public.session_runs') AS session_runs_table
  `);

  return {
    hasRequestLogs: Boolean(result.rows[0]?.request_logs_table),
    hasSessionRuns: Boolean(result.rows[0]?.session_runs_table),
  };
}

async function listDatabases() {
  const adminDb = process.env.PGADMIN_DATABASE || process.env.PGDATABASE || "postgres";
  const client = createClient(adminDb);
  await client.connect();

  try {
    const dbResult = await client.query(
      `
        SELECT datname
        FROM pg_database
        WHERE datistemplate = false
          AND datallowconn = true
          AND datname LIKE $1
        ORDER BY datname
      `,
      [`${DB_PREFIX}%`],
    );

    const databases = [];

    for (const row of dbResult.rows) {
      const database = row.datname;
      try {
        const summary = await withDb(database, async (dbClient) => {
          const tablePresence = await getTablePresence(dbClient);

          if (!tablePresence.hasSessionRuns) {
            return {
              session_count: 0,
              completed_count: 0,
              failed_count: 0,
              latest_created_at: null,
              has_request_logs: tablePresence.hasRequestLogs,
            };
          }

          const counts = await dbClient.query(`
            SELECT
              COUNT(*)::int AS session_count,
              COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_count,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
              MAX(created_at) AS latest_created_at
            FROM session_runs
          `);

          return {
            ...counts.rows[0],
            has_request_logs: tablePresence.hasRequestLogs,
          };
        });

        databases.push({
          name: database,
          sessionCount: summary.session_count,
          completedCount: summary.completed_count,
          failedCount: summary.failed_count,
          latestCreatedAt: summary.latest_created_at,
          hasRequestLogs: summary.has_request_logs,
        });
      } catch (error) {
        databases.push({
          name: database,
          error: error.message,
        });
      }
    }

    return databases;
  } finally {
    await client.end();
  }
}

function replaceSequentialPlaceholders(sql, startIndex) {
  let current = startIndex;
  return sql.replace(/\?/g, () => {
    const token = `$${current}`;
    current += 1;
    return token;
  });
}

function buildSearchClause(query, startIndex) {
  if (!query) {
    return { clause: "", values: [], nextIndex: startIndex };
  }

  const like = `%${query}%`;
  const values = [like, like, like, like, like, like, like, like, like, like];
  const clause = replaceSequentialPlaceholders(
    `
      AND (
        sr.session_id ILIKE ?
        OR EXISTS (
          SELECT 1
          FROM request_logs rl
          WHERE rl.session_id = sr.session_id
            AND (
              COALESCE(rl.provider_request_id, '') ILIKE ?
              OR COALESCE(rl.completion_id, '') ILIKE ?
              OR rl.request_log_id::text ILIKE ?
            )
        )
        OR COALESCE(sr.destination_name, '') ILIKE ?
        OR COALESCE(p.profile_name, '') ILIKE ?
        OR COALESCE(ig.interest_type, '') ILIKE ?
        OR COALESCE(sr.model_name, '') ILIKE ?
        OR COALESCE(sr.provider_name, '') ILIKE ?
        OR COALESCE(sr.run_notes, '') ILIKE ?
      )
    `,
    startIndex,
  );

  return { clause, values, nextIndex: startIndex + values.length };
}

async function getSessions(database, searchParams) {
  const provider = searchParams.get("provider");
  const status = searchParams.get("status");
  const interestType = searchParams.get("interestType");
  const profileId = searchParams.get("profileId");
  const query = searchParams.get("q");
  const limit = Math.min(
    Math.max(Number(searchParams.get("limit") || DEFAULT_LIMIT), 1),
    500,
  );

  return withDb(database, async (client) => {
    const values = [];
    let index = 1;
    const clauses = [];

    if (provider) {
      clauses.push(`sr.provider_name = $${index}`);
      values.push(provider);
      index += 1;
    }

    if (status) {
      clauses.push(`sr.status = $${index}`);
      values.push(status);
      index += 1;
    }

    if (interestType) {
      clauses.push(`ig.interest_type = $${index}`);
      values.push(interestType);
      index += 1;
    }

    if (profileId) {
      clauses.push(`sr.profile_id = $${index}`);
      values.push(Number(profileId));
      index += 1;
    }

    const search = buildSearchClause(query, index);
    values.push(...search.values);
    index = search.nextIndex;

    values.push(limit);

    const whereClause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const result = await client.query(
      `
        SELECT
          sr.session_id,
          sr.profile_id,
          p.profile_name,
          p.age,
          p.gender,
          p.travel_party,
          p.stay_nights,
          p.budget_per_day_eur,
          sr.interest_group_id,
          ig.interest_type,
          sr.repeat_index,
          sr.destination_name,
          sr.provider_name,
          sr.model_name,
          sr.run_notes,
          sr.status,
          sr.error_message,
          sr.created_at,
          COUNT(cpa.constraint_answer_id)::int AS constraint_count
        FROM session_runs sr
        JOIN profiles p
          ON p.profile_id = sr.profile_id
        JOIN interest_groups ig
          ON ig.interest_group_id = sr.interest_group_id
        LEFT JOIN constraint_prompt_answers cpa
          ON cpa.session_id = sr.session_id
        ${whereClause}
        ${search.clause}
        GROUP BY
          sr.session_id,
          sr.profile_id,
          p.profile_name,
          p.age,
          p.gender,
          p.travel_party,
          p.stay_nights,
          p.budget_per_day_eur,
          sr.interest_group_id,
          ig.interest_type,
          sr.repeat_index,
          sr.destination_name,
          sr.provider_name,
          sr.model_name,
          sr.run_notes,
          sr.status,
          sr.error_message,
          sr.created_at
        ORDER BY sr.created_at DESC, sr.session_id DESC
        LIMIT $${index}
      `,
      values,
    );

    const facets = await client.query(`
      SELECT
        ARRAY(
          SELECT DISTINCT provider_name
          FROM session_runs
          WHERE provider_name IS NOT NULL
          ORDER BY provider_name
        ) AS providers,
        ARRAY(
          SELECT DISTINCT status
          FROM session_runs
          WHERE status IS NOT NULL
          ORDER BY status
        ) AS statuses,
        ARRAY(
          SELECT DISTINCT interest_type
          FROM interest_groups
          ORDER BY interest_type
        ) AS interest_types
    `);

    return {
      sessions: result.rows,
      facets: facets.rows[0],
    };
  });
}

function requestUnionSql() {
  return `
    SELECT
      'general' AS request_kind,
      gpa.session_id,
      gpa.completion_id,
      gpa.prompt_text,
      gpa.general_prompt_answer AS answer_text,
      NULL::varchar AS season_name,
      NULL::varchar AS travel_time_frame,
      sr.profile_id,
      p.profile_name,
      p.profile_language,
      p.age,
      p.gender,
      p.travel_party,
      p.stay_nights,
      p.budget_per_day_eur,
      p.price_sensitivity,
      sr.interest_group_id,
      ig.interest_type,
      sr.repeat_index,
      sr.destination_name,
      sr.provider_name,
      sr.model_name,
      sr.run_notes,
      sr.status,
      sr.error_message,
      gpa.sources_json,
      gpa.created_at
    FROM general_prompt_answers gpa
    JOIN session_runs sr
      ON sr.session_id = gpa.session_id
    JOIN profiles p
      ON p.profile_id = sr.profile_id
    JOIN interest_groups ig
      ON ig.interest_group_id = sr.interest_group_id

    UNION ALL

    SELECT
      'constraint' AS request_kind,
      cpa.session_id,
      cpa.completion_id,
      cpa.prompt_text,
      cpa.constraint_prompt_answer AS answer_text,
      cpa.season_name,
      cpa.travel_time_frame,
      sr.profile_id,
      p.profile_name,
      p.profile_language,
      p.age,
      p.gender,
      p.travel_party,
      p.stay_nights,
      p.budget_per_day_eur,
      p.price_sensitivity,
      sr.interest_group_id,
      cpa.interest_type,
      sr.repeat_index,
      sr.destination_name,
      sr.provider_name,
      sr.model_name,
      sr.run_notes,
      sr.status,
      sr.error_message,
      cpa.sources_json,
      cpa.created_at
    FROM constraint_prompt_answers cpa
    JOIN session_runs sr
      ON sr.session_id = cpa.session_id
    JOIN profiles p
      ON p.profile_id = sr.profile_id

    UNION ALL

    SELECT
      'comparison' AS request_kind,
      cpr.session_id,
      cpr.completion_id,
      cpr.prompt_text,
      cpr.comparison_prompt_answer AS answer_text,
      NULL::varchar AS season_name,
      NULL::varchar AS travel_time_frame,
      sr.profile_id,
      p.profile_name,
      p.profile_language,
      p.age,
      p.gender,
      p.travel_party,
      p.stay_nights,
      p.budget_per_day_eur,
      p.price_sensitivity,
      sr.interest_group_id,
      cpr.interest_type,
      sr.repeat_index,
      sr.destination_name,
      sr.provider_name,
      sr.model_name,
      sr.run_notes,
      sr.status,
      sr.error_message,
      cpr.sources_json,
      cpr.created_at
    FROM comparison_prompt_results cpr
    JOIN session_runs sr
      ON sr.session_id = cpr.session_id
    JOIN profiles p
      ON p.profile_id = sr.profile_id
  `;
}

async function getRequestRows(client, filters = {}) {
  const clauses = [];
  const values = [];
  let index = 1;

  if (filters.provider) {
    clauses.push(`r.provider_name = $${index}`);
    values.push(filters.provider);
    index += 1;
  }

  if (filters.status) {
    clauses.push(`r.status = $${index}`);
    values.push(filters.status);
    index += 1;
  }

  if (filters.interestType) {
    clauses.push(`r.interest_type = $${index}`);
    values.push(filters.interestType);
    index += 1;
  }

  if (filters.profileId) {
    clauses.push(`r.profile_id = $${index}`);
    values.push(Number(filters.profileId));
    index += 1;
  }

  if (filters.completionId) {
    clauses.push(`r.completion_id = $${index}`);
    values.push(filters.completionId);
    index += 1;
  }

  if (filters.query) {
    const like = `%${filters.query}%`;
    clauses.push(
      `
        (
          COALESCE(r.completion_id, '') ILIKE $${index}
          OR COALESCE(r.session_id, '') ILIKE $${index + 1}
          OR COALESCE(r.profile_name, '') ILIKE $${index + 2}
          OR COALESCE(r.destination_name, '') ILIKE $${index + 3}
          OR COALESCE(r.interest_type, '') ILIKE $${index + 4}
          OR COALESCE(r.prompt_text, '') ILIKE $${index + 5}
          OR COALESCE(r.answer_text, '') ILIKE $${index + 6}
        )
      `,
    );
    values.push(like, like, like, like, like, like, like);
    index += 7;
  }

  const whereClause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return { whereClause, values, nextIndex: index };
}

async function getRequests(database, searchParams) {
  const provider = searchParams.get("provider");
  const status = searchParams.get("status");
  const interestType = searchParams.get("interestType");
  const profileId = searchParams.get("profileId");
  const query = searchParams.get("q");
  const pageSize = Math.min(
    Math.max(Number(searchParams.get("pageSize") || 20), 1),
    100,
  );
  const requestedPage = Math.max(Number(searchParams.get("page") || 1), 1);

  return withDb(database, async (client) => {
    const tablePresence = await getTablePresence(client);
    if (!tablePresence.hasRequestLogs) {
      return {
        requests: [],
        facets: {
          providers: [],
          statuses: [],
          interest_types: [],
        },
        totalCount: 0,
        totalPages: 0,
        page: 1,
        pageSize,
      };
    }

    const clauses = [];
    const values = [];
    let index = 1;

    if (provider) {
      clauses.push(`rl.provider_name = $${index}`);
      values.push(provider);
      index += 1;
    }

    if (status) {
      clauses.push(`rl.status = $${index}`);
      values.push(status);
      index += 1;
    }

    if (interestType) {
      clauses.push(`ig.interest_type = $${index}`);
      values.push(interestType);
      index += 1;
    }

    if (profileId) {
      clauses.push(`rl.profile_id = $${index}`);
      values.push(Number(profileId));
      index += 1;
    }

    if (query) {
      const like = `%${query}%`;
      clauses.push(
        `
          (
            rl.request_log_id::text ILIKE $${index}
            OR COALESCE(rl.completion_id, '') ILIKE $${index + 1}
            OR COALESCE(rl.provider_request_id, '') ILIKE $${index + 2}
            OR COALESCE(rl.session_id, '') ILIKE $${index + 3}
            OR COALESCE(p.profile_name, '') ILIKE $${index + 4}
            OR COALESCE(rl.destination_name, '') ILIKE $${index + 5}
            OR COALESCE(ig.interest_type, '') ILIKE $${index + 6}
            OR COALESCE(rl.prompt_text, '') ILIKE $${index + 7}
            OR COALESCE(rl.answer_text, '') ILIKE $${index + 8}
          )
        `,
      );
      values.push(like, like, like, like, like, like, like, like, like);
      index += 9;
    }
    const whereClause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const countResult = await client.query(
      `
        SELECT COUNT(*)::int AS total_count
        FROM request_logs rl
        LEFT JOIN profiles p
          ON p.profile_id = rl.profile_id
        LEFT JOIN interest_groups ig
          ON ig.interest_group_id = rl.interest_group_id
        ${whereClause}
      `,
      values,
    );

    const totalCount = Number(countResult.rows[0]?.total_count || 0);
    const totalPages = totalCount > 0 ? Math.ceil(totalCount / pageSize) : 0;
    const page = totalPages > 0 ? Math.min(requestedPage, totalPages) : 1;
    const offset = (page - 1) * pageSize;

    const queryValues = [...values, pageSize, offset];

    const result = await client.query(
      `
        SELECT
          rl.request_log_id,
          rl.request_kind,
          rl.session_id,
          rl.completion_id,
          rl.provider_request_id,
          rl.prompt_text,
          rl.answer_text,
          rl.season_name,
          rl.travel_time_frame,
          rl.profile_id,
          p.profile_name,
          p.age,
          p.gender,
          p.travel_party,
          p.stay_nights,
          p.budget_per_day_eur,
          rl.interest_group_id,
          ig.interest_type,
          rl.repeat_index,
          rl.destination_name,
          rl.provider_name,
          rl.model_name,
          rl.run_notes,
          rl.status,
          rl.error_message,
          rl.started_at,
          rl.finished_at,
          rl.usage_json
        FROM request_logs rl
        LEFT JOIN profiles p
          ON p.profile_id = rl.profile_id
        LEFT JOIN interest_groups ig
          ON ig.interest_group_id = rl.interest_group_id
        ${whereClause}
        ORDER BY rl.started_at DESC, rl.request_log_id DESC
        LIMIT $${index}
        OFFSET $${index + 1}
      `,
      queryValues,
    );

    const facets = await client.query(`
      SELECT
        ARRAY(
          SELECT DISTINCT provider_name
          FROM request_logs
          WHERE provider_name IS NOT NULL
          ORDER BY provider_name
        ) AS providers,
        ARRAY(
          SELECT DISTINCT status
          FROM request_logs
          WHERE status IS NOT NULL
          ORDER BY status
        ) AS statuses,
        ARRAY(
          SELECT DISTINCT interest_type
          FROM interest_groups
          ORDER BY interest_type
        ) AS interest_types
    `);

    return {
      requests: result.rows,
      facets: facets.rows[0],
      totalCount,
      totalPages,
      page,
      pageSize,
    };
  });
}

function liveSearchMatch(session, request, query) {
  if (!query) {
    return true;
  }

  const needle = String(query).trim().toLowerCase();
  if (!needle) {
    return true;
  }

  const haystack = [
    session.sessionId,
    request?.liveRequestId,
    request?.providerRequestId,
    request?.completionId,
    session.profileName,
    session.destinationName,
    session.interestType,
    request?.requestKind,
    request?.seasonName,
    request?.travelTimeFrame,
    request?.promptText,
    request?.answerText,
    session.runNotes,
  ]
    .filter(Boolean)
    .join(" \n ")
    .toLowerCase();

  return haystack.includes(needle);
}

function toLiveUsageJson(request) {
  return request?.usage || null;
}

function toLiveRequestRow(session, request) {
  return {
    request_log_id: request.liveRequestId,
    live_request_id: request.liveRequestId,
    request_kind: request.requestKind,
    session_id: session.sessionId,
    completion_id: request.completionId || null,
    provider_request_id: request.providerRequestId || null,
    prompt_text: request.promptText || "",
    answer_text: request.answerText || null,
    season_name: request.seasonName || null,
    travel_time_frame: request.travelTimeFrame || null,
    profile_id: session.profileId,
    profile_name: session.profileName,
    age: session.age,
    gender: session.gender,
    travel_party: session.travelParty,
    stay_nights: session.stayNights,
    budget_per_day_eur: session.budgetPerDayEur,
    interest_group_id: session.interestGroupId,
    interest_type: session.interestType,
    repeat_index: session.repeatIndex,
    destination_name: session.destinationName,
    provider_name: session.providerName,
    model_name: session.modelName,
    run_notes: session.runNotes,
    status: request.status || session.status || "started",
    error_message: request.errorMessage || session.errorMessage || null,
    started_at: request.startedAt || session.startedAt,
    finished_at: request.finishedAt || session.finishedAt || null,
    usage_json: toLiveUsageJson(request),
    response_meta_json:
      request.responseMeta ||
      (Array.isArray(request.providerEvents) && request.providerEvents.length
        ? { providerEvents: request.providerEvents }
        : null),
    sources_json: request.sources || [],
    message_history_json: request.messageHistory || [],
    params_json: session.params || null,
    is_live: true,
  };
}

async function getLiveFeed(database, searchParams) {
  const query = searchParams.get("q");
  const feedLimit = Math.min(
    Math.max(Number(searchParams.get("feedLimit") || 40), 1),
    200,
  );
  const sessions = await listLiveSessions(database);

  const feed = sessions
    .filter((session) => liveSearchMatch(session, session.latestRequest, query))
    .slice(0, feedLimit)
    .map((session) => {
      const latestRequest = session.latestRequest || {};
      return {
        session_id: session.sessionId,
        profile_id: session.profileId,
        profile_name: session.profileName,
        interest_type: session.interestType,
        repeat_index: session.repeatIndex,
        destination_name: session.destinationName,
        provider_name: session.providerName,
        model_name: session.modelName,
        run_notes: session.runNotes,
        session_status: session.status,
        completed_requests: session.completedRequests,
        prompt_target: session.promptTarget || 6,
        latest_activity_at: session.latestActivityAt,
        request_log_id: latestRequest.liveRequestId || null,
        request_kind: latestRequest.requestKind || null,
        season_name: latestRequest.seasonName || null,
        travel_time_frame: latestRequest.travelTimeFrame || null,
        request_status: latestRequest.status || session.status,
        error_message: latestRequest.errorMessage || session.errorMessage || null,
        completion_id: latestRequest.completionId || null,
        provider_request_id: latestRequest.providerRequestId || null,
        usage_json: latestRequest.usage || null,
        started_at: latestRequest.startedAt || session.startedAt,
        finished_at: latestRequest.finishedAt || session.finishedAt || null,
      };
    });

  return { feed };
}

async function getLiveRequests(database, searchParams) {
  const query = searchParams.get("q");
  const limit = Math.min(
    Math.max(Number(searchParams.get("liveLimit") || 20), 1),
    100,
  );
  const sessions = await listLiveSessions(database);
  const allRequests = sessions
    .flatMap((session) =>
      (session.requests || [])
        .filter((request) => liveSearchMatch(session, request, query))
        .map((request) => toLiveRequestRow(session, request)),
    )
    .sort((left, right) => {
      const leftTime = Date.parse(left.finished_at || left.started_at || 0);
      const rightTime = Date.parse(right.finished_at || right.started_at || 0);
      return rightTime - leftTime;
    });
  const requests = allRequests.slice(0, limit);

  return {
    requests,
    totalCount: allRequests.length,
  };
}

async function getLiveRequestDetail(database, liveRequestId) {
  const sessions = await listLiveSessions(database);

  for (const session of sessions) {
    const request = (session.requests || []).find(
      (row) => String(row.liveRequestId) === String(liveRequestId),
    );

    if (!request) {
      continue;
    }

    const requestRow = toLiveRequestRow(session, request);
    const contextTurns = [];
    const history = Array.isArray(request.messageHistory) ? request.messageHistory : [];

    for (const message of history) {
      contextTurns.push(
        buildTurn(
          message.role || "unknown",
          message.role === "assistant" ? "Live assistant context" : "Live user context",
          normalizeMessageContent(message.content),
          {},
        ),
      );
    }

    if (request.answerText) {
      contextTurns.push(
        buildTurn("assistant", "Current live answer", request.answerText, {
          completionId: request.completionId,
          providerRequestId: request.providerRequestId,
          createdAt: request.finishedAt || request.startedAt,
          sources: request.sources || [],
          usage: request.usage || null,
        }),
      );
    } else if (request.errorMessage) {
      contextTurns.push(
        buildTurn("system", "Failure", request.errorMessage, {
          createdAt: request.finishedAt || request.startedAt,
        }),
      );
    }

    return {
      request: requestRow,
      session: {
        session_id: session.sessionId,
        profile_id: session.profileId,
        profile_name: session.profileName,
        interest_type: session.interestType,
        repeat_index: session.repeatIndex,
        destination_name: session.destinationName,
        provider_name: session.providerName,
        model_name: session.modelName,
        run_notes: session.runNotes,
        status: session.status,
      },
      contextTurns,
      note:
        "This view uses the live trace files, not the research tables. It lets you inspect Claude request state, context, params, and token usage before the full session commits.",
    };
  }

  return null;
}

function buildTurn(role, label, text, extra = {}) {
  return {
    role,
    label,
    text,
    ...extra,
  };
}

function normalizeMessageContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts = [];

    for (const item of content) {
      if (typeof item?.text === "string" && item.text.trim()) {
        textParts.push(item.text);
      } else if (typeof item === "string" && item.trim()) {
        textParts.push(item);
      }
    }

    if (textParts.length) {
      return textParts.join("\n\n");
    }

    return JSON.stringify(content, null, 2);
  }

  if (content && typeof content === "object") {
    if (typeof content.text === "string") {
      return content.text;
    }

    return JSON.stringify(content, null, 2);
  }

  return String(content ?? "");
}

async function getSessionBundle(client, sessionId) {
  const sessionResult = await client.query(
    `
      SELECT
        sr.*,
        p.profile_name,
        p.profile_language,
        p.age,
        p.gender,
        p.travel_party,
        p.stay_nights,
        p.budget_per_day_eur,
        p.price_sensitivity,
        ig.interest_type
      FROM session_runs sr
      JOIN profiles p
        ON p.profile_id = sr.profile_id
      JOIN interest_groups ig
        ON ig.interest_group_id = sr.interest_group_id
      WHERE sr.session_id = $1
      LIMIT 1
    `,
    [sessionId],
  );

  if (!sessionResult.rows.length) {
    return null;
  }

  const generalResult = await client.query(
    `
      SELECT *
      FROM general_prompt_answers
      WHERE session_id = $1
      LIMIT 1
    `,
    [sessionId],
  );
  const constraintsResult = await client.query(
    `
      SELECT *
      FROM constraint_prompt_answers
      WHERE session_id = $1
      ORDER BY interest_id ASC
    `,
    [sessionId],
  );
  const comparisonResult = await client.query(
    `
      SELECT *
      FROM comparison_prompt_results
      WHERE session_id = $1
      LIMIT 1
    `,
    [sessionId],
  );

  return {
    session: sessionResult.rows[0],
    general: generalResult.rows[0] || null,
    constraints: constraintsResult.rows,
    comparison: comparisonResult.rows[0] || null,
  };
}

function buildSessionThread(bundle) {
  const thread = [];

  if (bundle.general) {
    thread.push({
      turnType: "general",
      title: "General prompt",
      promptText: bundle.general.prompt_text,
      answerText: bundle.general.general_prompt_answer,
      completionId: bundle.general.completion_id,
      sources: bundle.general.sources_json || [],
      createdAt: bundle.general.created_at,
    });
  }

  for (const row of bundle.constraints) {
    thread.push({
      turnType: "constraint",
      title: `${row.interest_type} / ${row.season_name}`,
      subtitle: row.travel_time_frame,
      promptText: row.prompt_text,
      answerText: row.constraint_prompt_answer,
      completionId: row.completion_id,
      sources: row.sources_json || [],
      createdAt: row.created_at,
    });
  }

  if (bundle.comparison) {
    thread.push({
      turnType: "comparison",
      title: "Comparison prompt",
      promptText: bundle.comparison.prompt_text,
      answerText: bundle.comparison.comparison_prompt_answer,
      completionId: bundle.comparison.completion_id,
      sources: bundle.comparison.sources_json || [],
      createdAt: bundle.comparison.created_at,
    });
  }

  return thread;
}

async function getSessionDetail(database, sessionId) {
  return withDb(database, async (client) => {
    const bundle = await getSessionBundle(client, sessionId);

    if (!bundle) {
      return null;
    }

    return {
      session: bundle.session,
      thread: buildSessionThread(bundle),
    };
  });
}

async function getRequestDetail(database, requestLogIdValue) {
  return withDb(database, async (client) => {
    const tablePresence = await getTablePresence(client);
    if (!tablePresence.hasRequestLogs) {
      return null;
    }

    const requestLogId = Number(requestLogIdValue);
    const result = await client.query(
      `
        SELECT *
        FROM request_logs
        WHERE request_log_id = $1
        LIMIT 1
      `,
      [requestLogId],
    );

    if (!result.rows.length) {
      return null;
    }

    const requestRow = result.rows[0];
    const requestMeta = await client.query(
      `
        SELECT
          rl.*,
          p.profile_name,
          p.profile_language,
          p.age,
          p.gender,
          p.travel_party,
          p.stay_nights,
          p.budget_per_day_eur,
          p.price_sensitivity,
          ig.interest_type
        FROM request_logs rl
        LEFT JOIN profiles p
          ON p.profile_id = rl.profile_id
        LEFT JOIN interest_groups ig
          ON ig.interest_group_id = rl.interest_group_id
        WHERE rl.request_log_id = $1
        LIMIT 1
      `,
      [requestLogId],
    );
    const request = requestMeta.rows[0];

    const contextTurns = [];
    const history = Array.isArray(request.message_history_json)
      ? request.message_history_json
      : [];

    for (const message of history) {
      contextTurns.push(
        buildTurn(
          message.role || "unknown",
          message.role === "assistant" ? "Saved assistant context" : "Saved user context",
          normalizeMessageContent(message.content),
          {},
        ),
      );
    }

    if (request.answer_text) {
      contextTurns.push(
        buildTurn("assistant", "Current saved answer", request.answer_text, {
          completionId: request.completion_id,
          providerRequestId: request.provider_request_id,
          createdAt: request.finished_at || request.started_at,
          sources: request.sources_json || [],
          usage: request.usage_json || null,
        }),
      );
    } else if (request.error_message) {
      contextTurns.push(
        buildTurn("system", "Failure", request.error_message, {
          createdAt: request.finished_at || request.started_at,
        }),
      );
    }

    let session = null;
    try {
      const bundle = await getSessionBundle(client, request.session_id);
      session = bundle?.session || null;
    } catch {
      session = null;
    }

    return {
      request,
      session,
      contextTurns,
      note:
        "This view uses the committed request_logs rows. It shows the exact saved input history, output, usage, and citations for a fully saved request.",
    };
  });
}

async function serveHtml(res) {
  const html = await fs.readFile(HTML_FILE, "utf8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function parseUrl(req) {
  return new URL(req.url, `http://${req.headers.host}`);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = parseUrl(req);
    const pathname = url.pathname;

    if (pathname === "/" || pathname === "/session-viewer") {
      await serveHtml(res);
      return;
    }

    if (pathname === "/api/databases") {
      const databases = await listDatabases();
      json(res, 200, { databases });
      return;
    }

    if (pathname === "/api/sessions") {
      const database = url.searchParams.get("database");
      if (!database) {
        json(res, 400, { error: "Missing ?database=..." });
        return;
      }

      const payload = await getSessions(database, url.searchParams);
      json(res, 200, payload);
      return;
    }

    if (pathname === "/api/requests") {
      const database = url.searchParams.get("database");
      if (!database) {
        json(res, 400, { error: "Missing ?database=..." });
        return;
      }

      const payload = await getRequests(database, url.searchParams);
      json(res, 200, payload);
      return;
    }

    if (pathname === "/api/live-feed") {
      const database = url.searchParams.get("database");
      if (!database) {
        json(res, 400, { error: "Missing ?database=..." });
        return;
      }

      const payload = await getLiveFeed(database, url.searchParams);
      json(res, 200, payload);
      return;
    }

    if (pathname === "/api/live-requests") {
      const database = url.searchParams.get("database");
      if (!database) {
        json(res, 400, { error: "Missing ?database=..." });
        return;
      }

      const payload = await getLiveRequests(database, url.searchParams);
      json(res, 200, payload);
      return;
    }

    if (pathname === "/api/session") {
      const database = url.searchParams.get("database");
      const sessionId = url.searchParams.get("sessionId");

      if (!database || !sessionId) {
        json(res, 400, { error: "Missing ?database=... or ?sessionId=..." });
        return;
      }

      const payload = await getSessionDetail(database, sessionId);

      if (!payload) {
        json(res, 404, { error: "Session not found." });
        return;
      }

      json(res, 200, payload);
      return;
    }

    if (pathname === "/api/request") {
      const database = url.searchParams.get("database");
      const requestLogId = url.searchParams.get("requestLogId");

      if (!database || !requestLogId) {
        json(res, 400, { error: "Missing ?database=... or ?requestLogId=..." });
        return;
      }

      const payload = await getRequestDetail(database, requestLogId);

      if (!payload) {
        json(res, 404, { error: "Request not found." });
        return;
      }

      json(res, 200, payload);
      return;
    }

    if (pathname === "/api/live-request") {
      const database = url.searchParams.get("database");
      const liveRequestId = url.searchParams.get("liveRequestId");

      if (!database || !liveRequestId) {
        json(res, 400, { error: "Missing ?database=... or ?liveRequestId=..." });
        return;
      }

      const payload = await getLiveRequestDetail(database, liveRequestId);

      if (!payload) {
        json(res, 404, { error: "Live request not found." });
        return;
      }

      json(res, 200, payload);
      return;
    }

    json(res, 404, { error: `Not found: ${pathname}` });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Session viewer running on http://localhost:${PORT}`);
});
