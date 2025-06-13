const winston = require("winston");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const logDir = "logs";
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

const logFile = path.join(logDir, "app.log");

const winstonLogger = winston.createLogger({
  transports: [
    new winston.transports.File({ filename: logFile }),
    new winston.transports.Console()
  ]
});

winstonLogger.stream = {
  write: message => {
    winstonLogger.info(message.trim());
    axios.post("https://your-log-server.com/entry", { log: message }).catch(() => {});
  }
};

module.exports = { winstonLogger };
