const {
  ANTHROPIC_EFFORT,
  ENABLE_THINKING,
  LOW_OUTPUT_TOKEN_THRESHOLD,
  MAX_CONSECUTIVE_LOW_OUTPUT_PAUSE_TURNS,
  MAX_PAUSE_TURNS,
  MAX_PROVIDER_EVENTS_PER_REQUEST,
  MAX_TOOL_CALLS,
  TOP_P,
  runSession,
} = require("./session_flow_claude");

const PROFILE_ID = Number(process.argv[2] || 1);
const FOLLOW_UP_LIMIT = Number(process.argv[3] || 4);
const INTEREST_TYPE = process.argv[4] || null;
const REPEAT_INDEX = Number(process.argv[5] || 1);
const SAVE_TO_DB = !process.argv.includes("--no-save");

function formatUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return "tokens n/a";
  }

  const input = Number(usage.input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  const total = input + output;
  return `in ${input} · out ${output} · total ${total}`;
}

function printSources(sources) {
  if (!sources.length) {
    return;
  }

  console.log("\nSOURCES:");
  for (const [index, source] of sources.entries()) {
    const label = source.title || source.url || `Source ${index + 1}`;
    console.log(`${index + 1}. ${label}`);
    if (source.url) {
      console.log(`   ${source.url}`);
    }
  }
}

function printSection(title, content) {
  console.log(`\n${title}:`);
  console.log(content);
}

function handleProgress(event) {
  switch (event.step) {
    case "general_started":
      console.log("\n[progress] general prompt started");
      break;
    case "general_completed":
      console.log(
        `[progress] general prompt completed (${event.completionId || "no completion id"})`,
      );
      break;
    case "constraint_started":
      console.log(
        `[progress] constraint started: ${event.interestType || "group"} / ${event.seasonName || "season"}`,
      );
      break;
    case "constraint_completed":
      console.log(
        `[progress] constraint completed: ${event.interestType || "group"} / ${event.seasonName || "season"} (${event.completionId || "no completion id"})`,
      );
      break;
    case "provider_event":
      console.log(
        `[provider] ${event.requestKind || event.interestType || "request"} · step ${event.sequence || "?"} · ${event.stopReason || "unknown"} · ${event.providerRequestId || "no request id"} · ${formatUsage(event.usage)} · cum in ${event.cumulativeInputTokens ?? "n/a"} · cum out ${event.cumulativeOutputTokens ?? "n/a"}${event.lowOutputPauseTurn ? ` · low-output pause ${event.consecutiveLowOutputPauseTurns}/${MAX_CONSECUTIVE_LOW_OUTPUT_PAUSE_TURNS}` : ""}`,
      );
      break;
    case "comparison_started":
      console.log("[progress] comparison prompt started");
      break;
    case "comparison_completed":
      console.log(
        `[progress] comparison prompt completed (${event.completionId || "no completion id"})`,
      );
      break;
    case "session_completed":
      console.log("[progress] session completed");
      break;
    case "session_failed":
      console.log(`[progress] session failed: ${event.error || "unknown error"}`);
      break;
    default:
      break;
  }
}

async function main() {
  console.log(`Starting Claude session -> profile ${PROFILE_ID}, interest ${INTEREST_TYPE || "(any)"}, repeat ${REPEAT_INDEX}`);
  console.log(`Save to DB: ${SAVE_TO_DB ? "yes" : "no"}`);
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

  const result = await runSession({
    profileId: PROFILE_ID,
    followUpLimit: FOLLOW_UP_LIMIT,
    interestType: INTEREST_TYPE,
    repeatIndex: REPEAT_INDEX,
    saveToDb: SAVE_TO_DB,
    onProgress: handleProgress,
  });

  console.log("PROFILE OBJECT:");
  console.dir(result.profile, { depth: null });

  printSection("SESSION ID", result.sessionId);
  printSection("MODEL", result.modelName);
  printSection("SAVE TO DB", SAVE_TO_DB ? "yes" : "no");
  printSection("REPEAT INDEX", String(REPEAT_INDEX));
  printSection("TOP P", String(TOP_P));
  printSection("ANTHROPIC THINKING", ENABLE_THINKING ? "on" : "off");
  printSection("ANTHROPIC TOOL CHOICE", ENABLE_THINKING ? "auto" : "forced web_search");
  printSection(
    "ANTHROPIC EFFORT",
    ENABLE_THINKING ? ANTHROPIC_EFFORT : "(ignored while thinking is off)",
  );
  printSection("RUN NOTES", result.runNotes || "(none)");
  printSection("MESSAGES TRACE", JSON.stringify(result.trace, null, 2));

  printSection("GENERAL COMPLETION ID", result.general.completionId);
  printSection("GENERAL PROMPT", result.general.prompt);
  printSection("GENERAL ANSWER", result.general.answer);
  printSources(result.general.sources);

  for (const item of result.followUps) {
    printSection(
      `FOLLOW-UP [${item.interestId}] ${item.interestType} / ${item.seasonName}`,
      item.prompt,
    );
    printSection("COMPLETION ID", item.completionId);
    printSection("ANSWER", item.answer);
    printSources(item.sources);
  }

  if (result.comparison) {
    printSection("COMPARISON PROMPT", result.comparison.prompt);
    printSection("COMPARISON COMPLETION ID", result.comparison.completionId);
    printSection("COMPARISON ANSWER", result.comparison.answer);
    printSources(result.comparison.sources);
  }
}

main().catch((error) => {
  console.error("\nScript failed:");
  console.error(error);
  process.exitCode = 1;
});
