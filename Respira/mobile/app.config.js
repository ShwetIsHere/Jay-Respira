require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY;

if (process.env.RESPIRA_REQUIRE_GOOGLE_MAPS_KEY === "1" && !googleMapsApiKey) {
  throw new Error("GOOGLE_MAPS_API_KEY must be configured for this native development build.");
}

module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    ...(googleMapsApiKey
      ? {
          config: {
            ...config.android?.config,
            googleMaps: { apiKey: googleMapsApiKey },
          },
        }
      : {}),
  },
  ios: {
    ...config.ios,
    ...(googleMapsApiKey
      ? {
          config: {
            ...config.ios?.config,
            googleMapsApiKey,
          },
        }
      : {}),
  },
});
