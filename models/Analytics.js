const mongoose = require("mongoose");

const analyticsSchema = new mongoose.Schema({
  route: String,
  method: String,
  userMeta: String,
  timestamp: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Analytics", analyticsSchema);
