const fs = require("node:fs/promises");
const path = require("node:path");
const ExcelJS = require("exceljs");
const { createDbClient } = require("./session_flow");

function parseArgs(argv) {
  const options = {
    runId: null,
    outputDir: null,
    latest: false,
  };

  for (const arg of argv) {
    if (arg.startsWith("--run-id=")) {
      options.runId = arg.slice("--run-id=".length);
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length);
    } else if (arg === "--latest") {
      options.latest = true;
    }
  }

  return options;
}

function widthForValue(value) {
  if (value === null || value === undefined) {
    return 10;
  }

  const stringValue = String(value).replace(/\s+/g, " ");
  return Math.min(Math.max(stringValue.length + 2, 10), 80);
}

function applyHeaderStyle(row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1F4E78" },
  };
  row.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
}

function addDataSheet(workbook, sheetName, rows) {
  const sheet = workbook.addWorksheet(sheetName, {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  if (!rows.length) {
    sheet.getCell("A1").value = "No rows exported";
    return sheet;
  }

  const headers = Object.keys(rows[0]);
  sheet.columns = headers.map((header) => ({
    header,
    key: header,
    width: widthForValue(header),
  }));

  for (const row of rows) {
    sheet.addRow(row);
  }

  applyHeaderStyle(sheet.getRow(1));
  sheet.autoFilter = {
    from: "A1",
    to: sheet.getRow(1).getCell(headers.length).address,
  };

  headers.forEach((header, index) => {
    const column = sheet.getColumn(index + 1);
    let maxWidth = widthForValue(header);

    for (let rowIndex = 2; rowIndex <= sheet.rowCount; rowIndex += 1) {
      const cellValue = sheet.getRow(rowIndex).getCell(index + 1).value;
      maxWidth = Math.max(maxWidth, widthForValue(cellValue));
    }

    const lower = header.toLowerCase();
    if (
      lower.includes("prompt") ||
      lower.includes("answer") ||
      lower.includes("sources_json")
    ) {
      column.width = Math.min(Math.max(maxWidth, 40), 120);
      column.alignment = { vertical: "top", wrapText: true };
    } else {
      column.width = maxWidth;
    }
  });

  return sheet;
}

function addSummarySheet(workbook, context) {
  const sheet = workbook.addWorksheet("Summary");
  sheet.columns = [{ width: 32 }, { width: 26 }, { width: 30 }];

  sheet.getCell("A1").value = "Explorer Prompt Export";
  sheet.getCell("A1").font = { bold: true, size: 16 };

  const rows = [
    ["Explorer run id", context.runId, ""],
    ["Provider", context.providerName, ""],
    ["Model", context.modelName, ""],
    ["Total rows", context.totalRows, ""],
    ["Distinct prompts", context.distinctPromptCount, ""],
    ["Repeat count", context.repeatCount, ""],
  ];

  sheet.getRow(8).values = ["Prompt ID", "Rows", "Prompt text"];
  applyHeaderStyle(sheet.getRow(8));

  for (const row of rows) {
    sheet.addRow(row);
  }

  while (sheet.rowCount < 8) {
    sheet.addRow([]);
  }

  for (const item of context.promptBreakdown) {
    sheet.addRow([item.prompt_id, item.row_count, item.prompt_text]);
  }

  return sheet;
}

function toCsv(rows) {
  if (!rows.length) {
    return "";
  }

  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];

  for (const row of rows) {
    const values = headers.map((header) => {
      const value = row[header];
      if (value === null || value === undefined) {
        return "";
      }
      const raw =
        typeof value === "object" ? JSON.stringify(value) : String(value);
      return `"${raw.replace(/"/g, '""')}"`;
    });
    lines.push(values.join(","));
  }

  return `${lines.join("\n")}\n`;
}

function toSqlLiteral(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }

  if (typeof value === "number") {
    return String(value);
  }

  const text =
    typeof value === "object" ? JSON.stringify(value) : String(value);
  return `'${text.replace(/'/g, "''")}'`;
}

function toInsertSql(rows) {
  if (!rows.length) {
    return "-- No explorer rows exported.\n";
  }

  const headers = Object.keys(rows[0]);
  const lines = [
    "-- Explorer prompt results export",
    `-- Run ID: ${rows[0].explorer_run_id}`,
    "",
  ];

  for (const row of rows) {
    const values = headers.map((header) => toSqlLiteral(row[header]));
    lines.push(
      `INSERT INTO explorer_prompt_results (${headers.join(", ")}) VALUES (${values.join(", ")});`,
    );
  }

  return `${lines.join("\n")}\n`;
}

async function getLatestRunId(dbClient) {
  const result = await dbClient.query(`
    SELECT explorer_run_id
    FROM explorer_prompt_results
    ORDER BY explorer_result_id DESC
    LIMIT 1
  `);

  return result.rows[0]?.explorer_run_id || null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dbClient = createDbClient();
  await dbClient.connect();

  try {
    const runId = options.runId || (options.latest ? await getLatestRunId(dbClient) : null);

    if (!runId) {
      throw new Error("Missing explorer run id. Use --run-id=<id> or --latest.");
    }

    const rowsResult = await dbClient.query(
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
        WHERE explorer_run_id = $1
        ORDER BY prompt_id, repeat_index, explorer_result_id
      `,
      [runId],
    );

    const rows = rowsResult.rows;

    if (!rows.length) {
      throw new Error(`No explorer rows found for run_id=${runId}`);
    }

    const promptBreakdownResult = await dbClient.query(
      `
        SELECT
          prompt_id,
          COUNT(*)::int AS row_count,
          MIN(prompt_text) AS prompt_text
        FROM explorer_prompt_results
        WHERE explorer_run_id = $1
        GROUP BY prompt_id
        ORDER BY prompt_id
      `,
      [runId],
    );

    const providerName = rows[0].provider_name || "";
    const modelName = rows[0].model_name || "";
    const distinctPromptCount = new Set(rows.map((row) => row.prompt_id)).size;
    const repeatCount = Math.max(...rows.map((row) => row.repeat_index));
    const outputDir =
      options.outputDir || path.join(__dirname, "..", "outputs", `explorer_bundle_${runId}`);

    await fs.mkdir(outputDir, { recursive: true });

    const summary = {
      explorerRunId: runId,
      providerName,
      modelName,
      totalRows: rows.length,
      distinctPromptCount,
      repeatCount,
      promptBreakdown: promptBreakdownResult.rows,
      files: {
        json: path.join(outputDir, "explorer_results.json"),
        csv: path.join(outputDir, "explorer_prompt_results.csv"),
        sql: path.join(outputDir, "explorer_prompt_results.sql"),
        excel: path.join(outputDir, "explorer_prompt_results.xlsx"),
        summaryJson: path.join(outputDir, "summary.json"),
        summaryTxt: path.join(outputDir, "summary.txt"),
      },
    };

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Codex";
    workbook.created = new Date();

    addSummarySheet(workbook, {
      runId,
      providerName,
      modelName,
      totalRows: rows.length,
      distinctPromptCount,
      repeatCount,
      promptBreakdown: promptBreakdownResult.rows,
    });
    addDataSheet(workbook, "explorer_prompt_results", rows);

    await fs.writeFile(summary.files.json, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
    await fs.writeFile(summary.files.csv, toCsv(rows), "utf8");
    await fs.writeFile(summary.files.sql, toInsertSql(rows), "utf8");
    await workbook.xlsx.writeFile(summary.files.excel);
    await fs.writeFile(summary.files.summaryJson, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

    const summaryText = [
      "Explorer Prompt Export Summary",
      `Run ID: ${runId}`,
      `Provider: ${providerName}`,
      `Model: ${modelName}`,
      `Total rows: ${rows.length}`,
      `Distinct prompts: ${distinctPromptCount}`,
      `Repeat count: ${repeatCount}`,
      "",
      "Prompt breakdown:",
      ...promptBreakdownResult.rows.map(
        (row) => `- Prompt ${row.prompt_id}: ${row.row_count} row(s)`,
      ),
    ].join("\n");

    await fs.writeFile(summary.files.summaryTxt, `${summaryText}\n`, "utf8");

    console.log(
      JSON.stringify(
        {
          runId,
          outputDir,
          totalRows: rows.length,
          files: summary.files,
        },
        null,
        2,
      ),
    );
  } finally {
    await dbClient.end();
  }
}

main().catch((error) => {
  console.error("Explorer export failed:");
  console.error(error);
  process.exitCode = 1;
});
