const { runSession } = require("./session_flow");

const PROFILE_ID = Number(process.argv[2] || 1);
const FOLLOW_UP_LIMIT = Number(process.argv[3] || 4);

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

async function main() {
  const result = await runSession({
    profileId: PROFILE_ID,
    followUpLimit: FOLLOW_UP_LIMIT,
    saveToDb: true,
  });

  console.log("PROFILE OBJECT:");
  console.dir(result.profile, { depth: null });

  printSection("SESSION ID", result.sessionId);
  printSection("MODEL", result.modelName);
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
