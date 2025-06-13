const Analytics = require("../models/Analytics");
const axios = require("axios");

const analyticsLogger = async (req, res, next) => {
  const meta_account = req.body?.meta_account || "guest";
  await Analytics.create({ route: req.originalUrl, method: req.method, userMeta: meta_account });

  try {
    await axios.post("https://www.google-analytics.com/mp/collect", {
      client_id: "555",
      events: [{
        name: "page_view",
        params: { page_path: req.originalUrl }
      }]
    }, {
      params: { measurement_id: process.env.GA_MEASUREMENT_ID, api_secret: process.env.GA_API_SECRET }
    });
  } catch (err) {}

  next();
};

module.exports = { analyticsLogger };
