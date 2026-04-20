const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { runSession } = require("./session_flow");

const PORT = Number(process.env.DEMO_PORT || 3000);
const HTML_PATH = path.join(__dirname, "demo.html");

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let rawBody = "";

    req.on("data", (chunk) => {
      rawBody += chunk;
    });

    req.on("end", () => {
      if (!rawBody) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(rawBody));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && req.url === "/") {
    const html = fs.readFileSync(HTML_PATH, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(req.method === "HEAD" ? "" : html);
    return;
  }

  if (req.method === "POST" && req.url === "/run-session") {
    try {
      const body = await readJsonBody(req);
      const result = await runSession(body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, {
        error: error.message || "Unknown error",
      });
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Demo server running on http://localhost:${PORT}`);
});
