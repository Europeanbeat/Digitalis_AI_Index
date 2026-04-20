const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

function buildComparisonPrompt(profileData, interestRow) {
  return `[DESZTINÁCIÓ: ${profileData.destination_name}] kívül tudnál ajánlani még öt másik tóparti desztinációt Európában, ahol kifejezetten jó a ${interestRow.interest_type.toLowerCase()} kínálat és illik a profilomhoz és pénztárcámhoz?`;
}

module.exports = {
  buildComparisonPrompt,
};
