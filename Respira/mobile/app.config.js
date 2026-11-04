const path = require("path");
const dotenv = require("dotenv");

// Expo normally loads mobile/.env. Respira also keeps shared local values in
// the repository-level .env, so load both without requiring any map key.
dotenv.config({ path: path.join(__dirname, "..", ".env") });
dotenv.config({ path: path.join(__dirname, ".env"), override: true });

module.exports = ({ config }) => config;
