const fs = require("node:fs/promises");
const path = require("node:path");
const ExcelJS = require("exceljs");
const { createDbClient } = require("./session_flow");

function parseArgs(argv) {
  const options = {
    output: null,
  };

  for (const arg of argv) {
    if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
    }
  }

  return options;
}

function slugTimestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");

  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "_",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

function seasonSortValue(seasonName) {
  switch (seasonName) {
    case "Summer":
      return 1;
    case "Autumn":
      return 2;
    case "Winter":
      return 3;
    case "Spring":
      return 4;
    default:
      return 99;
  }
}

function applyHeaderStyle(row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1F4E78" },
  };
  row.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  row.border = {
    bottom: { style: "thin", color: { argb: "FFD9E2F3" } },
  };
}

function widthForValue(value) {
  if (value === null || value === undefined) {
    return 10;
  }

  const stringValue =
    value instanceof Date ? value.toISOString() : String(value).replace(/\s+/g, " ");
  return Math.min(Math.max(stringValue.length + 2, 10), 80);
}

function addDataSheet(workbook, sheetName, rows) {
  const sheet = workbook.addWorksheet(sheetName, {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  if (!rows.length) {
    sheet.getCell("A1").value = "No rows exported";
    sheet.getCell("A1").font = { italic: true };
    return sheet;
  }

  const headers = Object.keys(rows[0]);
  sheet.columns = headers.map((header) => ({
    header,
    key: header,
    width: widthForValue(header),
  }));

  rows.forEach((row) => {
    const normalized = {};
    for (const header of headers) {
      const value = row[header];
      normalized[header] =
        value instanceof Date ? value : value === undefined ? null : value;
    }
    sheet.addRow(normalized);
  });

  applyHeaderStyle(sheet.getRow(1));

  for (const [index, header] of headers.entries()) {
    let maxWidth = widthForValue(header);
    for (let rowIndex = 2; rowIndex <= sheet.rowCount; rowIndex += 1) {
      const cellValue = sheet.getRow(rowIndex).getCell(index + 1).value;
      maxWidth = Math.max(maxWidth, widthForValue(cellValue));
    }
    sheet.getColumn(index + 1).width = maxWidth;
  }

  headers.forEach((header, index) => {
    const lower = header.toLowerCase();
    const column = sheet.getColumn(index + 1);

    if (
      lower.includes("answer") ||
      lower.includes("prompt") ||
      lower.includes("error_message") ||
      lower.includes("sources_json")
    ) {
      column.width = Math.min(Math.max(column.width, 40), 120);
      column.alignment = { vertical: "top", wrapText: true };
    } else if (lower.includes("created_at")) {
      column.width = Math.max(column.width, 22);
      column.numFmt = "yyyy-mm-dd hh:mm:ss";
    }
  });

  sheet.autoFilter = {
    from: "A1",
    to: sheet.getRow(1).getCell(headers.length).address,
  };

  return sheet;
}

function addSummarySheet(workbook, context) {
  const sheet = workbook.addWorksheet("Summary", {
    views: [{ state: "frozen", ySplit: 4 }],
  });

  sheet.columns = [
    { width: 32 },
    { width: 24 },
    { width: 24 },
  ];

  sheet.getCell("A1").value = "AI Visibility DB Export";
  sheet.getCell("A1").font = { bold: true, size: 16 };

  sheet.getCell("A3").value = "Exported at";
  sheet.getCell("B3").value = context.exportedAt;
  sheet.getCell("B3").numFmt = "yyyy-mm-dd hh:mm:ss";

  sheet.getCell("A4").value = "Database";
  sheet.getCell("B4").value = context.databaseName;

  applyHeaderStyle(sheet.getRow(6));
  sheet.getRow(6).values = ["Table", "Row count", "Notes"];

  const summaryRows = [
    ["session_runs", context.counts.sessionRuns, "Session header / audit rows"],
    ["general_prompt_answers", context.counts.general, "One general answer per session"],
    ["constraint_prompt_answers", context.counts.constraint, "Four seasonal answers per session"],
    ["comparison_prompt_results", context.counts.comparison, "One comparison answer per session"],
  ];

  if (typeof context.counts.explorerPromptResults === "number") {
    summaryRows.push([
      "explorer_prompt_results",
      context.counts.explorerPromptResults,
      "One row per explorer prompt repetition",
    ]);
  }

  for (const row of summaryRows) {
    sheet.addRow(row);
  }

  const statusStartRow = 12;
  sheet.getCell(`A${statusStartRow}`).value = "Session status";
  sheet.getCell(`A${statusStartRow}`).font = { bold: true };
  applyHeaderStyle(sheet.getRow(statusStartRow + 1));
  sheet.getRow(statusStartRow + 1).values = ["Status", "Count", ""];
  for (const item of context.statusCounts) {
    sheet.addRow([item.status, item.count, ""]);
  }

  const qualityStartRow = statusStartRow + 4 + context.statusCounts.length;
  sheet.getCell(`A${qualityStartRow}`).value = "Quality checks";
  sheet.getCell(`A${qualityStartRow}`).font = { bold: true };
  applyHeaderStyle(sheet.getRow(qualityStartRow + 1));
  sheet.getRow(qualityStartRow + 1).values = ["Check", "Value", "Expected"];
  sheet.addRow([
    "Completed sessions",
    context.progress.completedSessions,
    "Current saved complete sessions",
  ]);
  sheet.addRow([
    "Equivalent completed prompts",
    context.progress.completedPromptsEquivalent,
    "completed_sessions × 6",
  ]);
  sheet.addRow([
    "Integrity mismatches",
    context.progress.integrityMismatches,
    "0",
  ]);

  return sheet;
}

async function fetchRows(dbClient, queryText) {
  const result = await dbClient.query(queryText);
  return result.rows;
}

async function tableExists(dbClient, tableName) {
  const result = await dbClient.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = $1
      ) AS present
    `,
    [tableName],
  );

  return Boolean(result.rows[0]?.present);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dbClient = createDbClient();
  await dbClient.connect();

  try {
    const hasExplorerPromptResults = await tableExists(dbClient, "explorer_prompt_results");

    const sessionRuns = await fetchRows(
      dbClient,
      `
        SELECT
          session_id,
          profile_id,
          interest_group_id,
          repeat_index,
          destination_name,
          provider_name,
          model_name,
          status,
          error_message,
          created_at
        FROM session_runs
        ORDER BY profile_id, interest_group_id, repeat_index, created_at
      `,
    );

    const generalAnswers = await fetchRows(
      dbClient,
      `
        SELECT
          general_answer_id,
          session_id,
          profile_id,
          destination_name,
          repeat_index,
          provider_name,
          model_name,
          prompt_text,
          general_prompt_answer,
          completion_id,
          sources_json,
          created_at
        FROM general_prompt_answers
        ORDER BY profile_id, repeat_index, created_at
      `,
    );

    const constraintAnswers = await fetchRows(
      dbClient,
      `
        SELECT
          constraint_answer_id,
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
          sources_json,
          created_at
        FROM constraint_prompt_answers
        ORDER BY profile_id, interest_group_id, repeat_index, interest_id, created_at
      `,
    );

    constraintAnswers.sort((a, b) => {
      return (
        a.profile_id - b.profile_id ||
        a.interest_group_id - b.interest_group_id ||
        a.repeat_index - b.repeat_index ||
        seasonSortValue(a.season_name) - seasonSortValue(b.season_name) ||
        a.constraint_answer_id - b.constraint_answer_id
      );
    });

    const comparisonAnswers = await fetchRows(
      dbClient,
      `
        SELECT
          comparison_answer_id,
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
          sources_json,
          created_at
        FROM comparison_prompt_results
        ORDER BY profile_id, interest_group_id, repeat_index, created_at
      `,
    );

    const explorerPromptResults = hasExplorerPromptResults
      ? await fetchRows(
          dbClient,
          `
            SELECT
              explorer_result_id,
              explorer_run_id,
              prompt_id,
              repeat_index,
              provider_name,
              model_name,
              prompt_text,
              answer_text,
              completion_id,
              sources_json
            FROM explorer_prompt_results
            ORDER BY explorer_run_id, prompt_id, repeat_index
          `,
        )
      : [];

    const statusCounts = await fetchRows(
      dbClient,
      `
        SELECT status, COUNT(*)::int AS count
        FROM session_runs
        GROUP BY status
        ORDER BY status
      `,
    );

    const integrity = await dbClient.query(`
      WITH completed AS (
        SELECT session_id
        FROM session_runs
        WHERE status = 'completed'
      ),
      general_counts AS (
        SELECT session_id, COUNT(*)::int AS cnt
        FROM general_prompt_answers
        GROUP BY session_id
      ),
      constraint_counts AS (
        SELECT session_id, COUNT(*)::int AS cnt
        FROM constraint_prompt_answers
        GROUP BY session_id
      ),
      comparison_counts AS (
        SELECT session_id, COUNT(*)::int AS cnt
        FROM comparison_prompt_results
        GROUP BY session_id
      )
      SELECT COUNT(*)::int AS mismatch_count
      FROM completed c
      LEFT JOIN general_counts g ON g.session_id = c.session_id
      LEFT JOIN constraint_counts cp ON cp.session_id = c.session_id
      LEFT JOIN comparison_counts cm ON cm.session_id = c.session_id
      WHERE COALESCE(g.cnt, 0) <> 1
         OR COALESCE(cp.cnt, 0) <> 4
         OR COALESCE(cm.cnt, 0) <> 1
    `);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Codex";
    workbook.created = new Date();
    workbook.modified = new Date();

    addSummarySheet(workbook, {
      exportedAt: new Date(),
      databaseName: process.env.PGDATABASE || "digital_ai_index_db",
      counts: {
        sessionRuns: sessionRuns.length,
        general: generalAnswers.length,
        constraint: constraintAnswers.length,
        comparison: comparisonAnswers.length,
        explorerPromptResults: explorerPromptResults.length,
      },
      statusCounts,
      progress: {
        completedSessions: sessionRuns.filter((row) => row.status === "completed").length,
        completedPromptsEquivalent:
          sessionRuns.filter((row) => row.status === "completed").length * 6,
        integrityMismatches: integrity.rows[0]?.mismatch_count || 0,
      },
    });

    addDataSheet(workbook, "session_runs", sessionRuns);
    addDataSheet(workbook, "general_answers", generalAnswers);
    addDataSheet(workbook, "constraint_answers", constraintAnswers);
    addDataSheet(workbook, "comparison_answers", comparisonAnswers);
    if (hasExplorerPromptResults) {
      addDataSheet(workbook, "explorer_prompt_results", explorerPromptResults);
    }

    const outputDir = path.join(
      __dirname,
      "..",
      "outputs",
      `db_export_${slugTimestamp()}`,
    );
    await fs.mkdir(outputDir, { recursive: true });
    const outputPath =
      options.output || path.join(outputDir, "ai_visibility_db_export.xlsx");

    await workbook.xlsx.writeFile(outputPath);

    console.log(JSON.stringify({
      outputPath,
      counts: {
        sessionRuns: sessionRuns.length,
        generalAnswers: generalAnswers.length,
        constraintAnswers: constraintAnswers.length,
        comparisonAnswers: comparisonAnswers.length,
        explorerPromptResults: explorerPromptResults.length,
      },
      integrityMismatches: integrity.rows[0]?.mismatch_count || 0,
    }, null, 2));
  } finally {
    await dbClient.end();
  }
}

main().catch((error) => {
  console.error("Excel export failed:");
  console.error(error);
  process.exitCode = 1;
});
