const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { Client } = require("pg");

// Optional: pass a batch_id to scope to one batch, e.g.
//   PGDATABASE=... node scripts/claude_batch_status.js msgbatch_019eVWvYcZNh64tLuFD5hdN7
const BATCH_ID = process.argv[2] || null;

// Claude Sonnet 4.6 BATCH rates = 50% off standard ($3 / $15 per 1M input/output).
const IN_RATE = 1.5 / 1_000_000;
const OUT_RATE = 7.5 / 1_000_000;
// Web search server tool ~ $10 / 1000 searches (standard). Batch-discount not
// guaranteed on server tools — treat this line as an estimate to verify.
const SEARCH_RATE = 10 / 1000;

function usd(n) {
  return "$" + n.toFixed(3);
}

(async () => {
  const client = new Client({
    user: process.env.PGUSER || "postgres",
    host: process.env.PGHOST || "localhost",
    password: process.env.PGPASSWORD,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || "digital_ai_index_db",
  });
  await client.connect();

  const scope = BATCH_ID ? "WHERE batch_id = $1" : "";
  const params = BATCH_ID ? [BATCH_ID] : [];

  console.log(
    `DB: ${client.database} | ${BATCH_ID ? `batch ${BATCH_ID}` : "all batches"}`,
  );

  // 1) Batch-level progress (updates on every poll, even while in_progress)
  const runs = await client.query(
    `
      SELECT batch_id, pass_type, processing_status,
             request_counts_json->>'succeeded'  AS succeeded,
             request_counts_json->>'errored'    AS errored,
             request_counts_json->>'processing' AS processing,
             (synced_at IS NOT NULL)            AS synced
      FROM claude_batch_runs
      ${scope}
      ORDER BY created_at
    `,
    params,
  );
  console.log("\n=== batch runs ===");
  console.table(runs.rows);

  // 2) Token breakdown by request kind + status (fills in AFTER poll syncs an ended batch)
  const breakdown = await client.query(
    `
      SELECT request_kind, status, COUNT(*)::int AS rows,
             COALESCE(SUM((usage_json->>'input_tokens')::int), 0)::int  AS input_tokens,
             COALESCE(SUM((usage_json->>'output_tokens')::int), 0)::int AS output_tokens,
             COALESCE(SUM((usage_json->'server_tool_use'->>'web_search_requests')::int), 0)::int AS searches
      FROM claude_batch_requests
      ${scope}
      GROUP BY request_kind, status
      ORDER BY request_kind, status
    `,
    params,
  );
  console.log("\n=== tokens by kind / status ===");
  console.table(breakdown.rows);

  // 3) Totals + estimated cost
  const totals = await client.query(
    `
      SELECT COALESCE(SUM((usage_json->>'input_tokens')::int), 0)::int  AS input_tokens,
             COALESCE(SUM((usage_json->>'output_tokens')::int), 0)::int AS output_tokens,
             COALESCE(SUM((usage_json->'server_tool_use'->>'web_search_requests')::int), 0)::int AS searches,
             COUNT(*)::int AS total_rows,
             COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded_rows,
             COUNT(*) FILTER (WHERE status = 'errored')::int   AS errored_rows,
             COUNT(*) FILTER (WHERE finalized_at IS NOT NULL)::int AS finalized_rows
      FROM claude_batch_requests
      ${scope}
    `,
    params,
  );
  const t = totals.rows[0];
  const inputCost = t.input_tokens * IN_RATE;
  const outputCost = t.output_tokens * OUT_RATE;
  const searchCost = t.searches * SEARCH_RATE;

  console.log("\n=== TOTAL (Sonnet 4.6 Batch rates: $1.5 / $7.5 per 1M) ===");
  console.log(`rows: ${t.total_rows} (succeeded ${t.succeeded_rows}, errored ${t.errored_rows}, finalized ${t.finalized_rows})`);
  console.log(`input:  ${t.input_tokens} tok  -> ${usd(inputCost)}`);
  console.log(`output: ${t.output_tokens} tok  -> ${usd(outputCost)}`);
  console.log(`web searches: ${t.searches}  -> ~${usd(searchCost)} (est. $10/1k)`);
  console.log(`TOKEN COST: ${usd(inputCost + outputCost)}   |   +search ≈ ${usd(inputCost + outputCost + searchCost)}`);

  if (t.input_tokens === 0 && t.output_tokens === 0) {
    console.log("\n(0 tokens = the batch is still in_progress / not yet synced. Run this again after poll shows 'ended'.)");
  }

  await client.end();
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
