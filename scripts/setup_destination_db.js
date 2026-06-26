const fs = require("node:fs/promises");
const path = require("node:path");
const { Client } = require("pg");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const PROFILE_TEMPLATES = [
  {
    profile_id: 1,
    profile_name: "Fiatal egyedülálló",
    profile_language: "EN",
    age: 25,
    gender: "man",
    travel_party: "on my own",
    stay_nights: 3,
    budget_per_day_eur: 100.0,
    price_sensitivity: "közepes",
  },
  {
    profile_id: 2,
    profile_name: "Fiatal pár, gyermektelen",
    profile_language: "EN",
    age: 30,
    gender: "woman",
    travel_party: "with my partner",
    stay_nights: 3,
    budget_per_day_eur: 200.0,
    price_sensitivity: "alacsony",
  },
  {
    profile_id: 3,
    profile_name: "Család kisgyermekkel",
    profile_language: "EN",
    age: 34,
    gender: "man",
    travel_party: "with my partner and our young child",
    stay_nights: 7,
    budget_per_day_eur: 50.0,
    price_sensitivity: "magas",
  },
  {
    profile_id: 4,
    profile_name: "Család iskoláskorú gyermekkel",
    profile_language: "EN",
    age: 42,
    gender: "man",
    travel_party: "with my partner and our children",
    stay_nights: 7,
    budget_per_day_eur: 100.0,
    price_sensitivity: "közepes",
  },
  {
    profile_id: 5,
    profile_name: "Egyedülálló szülő",
    profile_language: "EN",
    age: 38,
    gender: "woman",
    travel_party: "with my child, as a single parent",
    stay_nights: 5,
    budget_per_day_eur: 50.0,
    price_sensitivity: "magas",
  },
  {
    profile_id: 6,
    profile_name: "Fiatal baráti társaság",
    profile_language: "EN",
    age: 25,
    gender: "man",
    travel_party: "with a group of friends",
    stay_nights: 3,
    budget_per_day_eur: 100.0,
    price_sensitivity: "közepes",
  },
  {
    profile_id: 7,
    profile_name: "Középkorú pár, gyermektelen",
    profile_language: "EN",
    age: 48,
    gender: "woman",
    travel_party: "with my partner",
    stay_nights: 5,
    budget_per_day_eur: 200.0,
    price_sensitivity: "alacsony",
  },
  {
    profile_id: 8,
    profile_name: "Üres fészek, aktív (dolgozó)",
    profile_language: "EN",
    age: 56,
    gender: "man",
    travel_party: "with my partner",
    stay_nights: 7,
    budget_per_day_eur: 200.0,
    price_sensitivity: "alacsony",
  },
  {
    profile_id: 9,
    profile_name: "Nyugdíjas pár",
    profile_language: "EN",
    age: 67,
    gender: "woman",
    travel_party: "with my partner",
    stay_nights: 7,
    budget_per_day_eur: 100.0,
    price_sensitivity: "közepes",
  },
  {
    profile_id: 10,
    profile_name: "Idős egyedülálló",
    profile_language: "EN",
    age: 72,
    gender: "woman",
    travel_party: "on my own",
    stay_nights: 4,
    budget_per_day_eur: 100.0,
    price_sensitivity: "közepes",
  },
  {
    profile_id: 11,
    profile_name: "Többgenerációs család",
    profile_language: "EN",
    age: 45,
    gender: "woman",
    travel_party:
      "as a three-generation family, together with grandparents, parents and children",
    stay_nights: 7,
    budget_per_day_eur: 100.0,
    price_sensitivity: "közepes",
  },
  {
    profile_id: 12,
    profile_name: "Aktív szenior baráti társaság",
    profile_language: "EN",
    age: 62,
    gender: "man",
    travel_party: "with a group of friends",
    stay_nights: 5,
    budget_per_day_eur: 100.0,
    price_sensitivity: "közepes",
  },
];

function usage() {
  console.error(
    'Usage: node scripts/setup_destination_db.js <database_name> "<destination_name>"',
  );
}

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function createPgConfig(database) {
  if (!process.env.PGPASSWORD) {
    throw new Error("Missing PGPASSWORD. Add it to .env");
  }

  return {
    user: process.env.PGUSER || "postgres",
    host: process.env.PGHOST || "localhost",
    database,
    password: process.env.PGPASSWORD,
    port: Number(process.env.PGPORT || 5432),
  };
}

async function ensureDatabaseExists(databaseName) {
  const adminDb = process.env.PGMAINTENANCE_DB || "postgres";
  const adminClient = new Client(createPgConfig(adminDb));
  await adminClient.connect();

  try {
    const exists = await adminClient.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [databaseName],
    );

    if (!exists.rows.length) {
      await adminClient.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      return { created: true };
    }

    return { created: false };
  } finally {
    await adminClient.end();
  }
}

async function tableExists(client, tableName) {
  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
      LIMIT 1
    `,
    [tableName],
  );

  return Boolean(result.rows.length);
}

async function runSqlFile(client, filePath) {
  const sql = await fs.readFile(filePath, "utf8");
  await client.query(sql);
}

async function upsertProfiles(client, destinationName) {
  const values = [];
  const params = [];
  let index = 1;

  for (const profile of PROFILE_TEMPLATES) {
    values.push(
      `($${index}, $${index + 1}, $${index + 2}, $${index + 3}, $${index + 4}, $${index + 5}, $${index + 6}, $${index + 7}, $${index + 8}, $${index + 9})`,
    );
    params.push(
      profile.profile_id,
      profile.profile_name,
      profile.profile_language,
      profile.age,
      profile.gender,
      profile.travel_party,
      profile.stay_nights,
      profile.budget_per_day_eur,
      profile.price_sensitivity,
      destinationName,
    );
    index += 10;
  }

  await client.query(
    `
      INSERT INTO profiles (
        profile_id,
        profile_name,
        profile_language,
        age,
        gender,
        travel_party,
        stay_nights,
        budget_per_day_eur,
        price_sensitivity,
        destination_name
      ) VALUES
        ${values.join(",\n        ")}
      ON CONFLICT (profile_id) DO UPDATE SET
        profile_name = EXCLUDED.profile_name,
        profile_language = EXCLUDED.profile_language,
        age = EXCLUDED.age,
        gender = EXCLUDED.gender,
        travel_party = EXCLUDED.travel_party,
        stay_nights = EXCLUDED.stay_nights,
        budget_per_day_eur = EXCLUDED.budget_per_day_eur,
        price_sensitivity = EXCLUDED.price_sensitivity,
        destination_name = EXCLUDED.destination_name
    `,
    params,
  );
}

async function main() {
  const databaseName = process.argv[2];
  const destinationName = process.argv[3];

  if (!databaseName || !destinationName) {
    usage();
    process.exit(1);
  }

  const repoRoot = path.join(__dirname, "..");
  const schemaPath = path.join(repoRoot, "sql", "create_db.sql");
  const seedInterestsPath = path.join(
    repoRoot,
    "sql",
    "003_seed_travel_interests.sql",
  );

  const dbStatus = await ensureDatabaseExists(databaseName);
  const client = new Client(createPgConfig(databaseName));
  await client.connect();

  try {
    const hasProfilesTable = await tableExists(client, "profiles");

    if (!hasProfilesTable) {
      await runSqlFile(client, schemaPath);
    }

    await runSqlFile(client, seedInterestsPath);
    await upsertProfiles(client, destinationName);

    const counts = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM profiles) AS profiles,
        (SELECT COUNT(*)::int FROM interest_groups) AS interest_groups,
        (SELECT COUNT(*)::int FROM travel_interests) AS travel_interests
    `);

    console.log(
      JSON.stringify(
        {
          database: databaseName,
          destinationName,
          databaseCreated: dbStatus.created,
          schemaCreated: !hasProfilesTable,
          counts: counts.rows[0],
        },
        null,
        2,
      ),
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Destination DB setup failed:");
  console.error(error);
  process.exitCode = 1;
});
