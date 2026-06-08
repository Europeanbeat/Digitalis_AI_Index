const http = require("http");
const fs = require("fs");

const FILE = "/Users/bence/Desktop/Digitális_AI_Index/architecture_preview.html";
const PORT = 8755;

http
  .createServer((req, res) => {
    fs.readFile(FILE, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end("error: " + err.message);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
  })
  .listen(PORT, () => console.log("serving on " + PORT));
