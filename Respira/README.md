# Respira Risk Monitor

This workspace now includes a Python FastAPI inference service, a TypeScript mobile risk client, and the supporting monitoring utilities around the trained scikit-learn model.

## Verified model contract

The shipped model at `Respira/model/respira_random_forest.pkl` loads successfully with scikit-learn and exposes the expected contract:

- `feature_names_in_`: `['pm2_5_24h_mean', 'nitrogen_dioxide_24h_mean', 'ozone_8h_max']`
- `n_features_in_`: `3`
- `classes_`: `[0, 1]`
- `predict_proba`: available
- `predict`: available

The model expects exactly these three inputs, in order:

- `pm2_5_24h_mean`
- `nitrogen_dioxide_24h_mean`
- `ozone_8h_max`

No latitude, longitude, date, trigger history, or other side fields are passed to the model. The mobile app never loads the pickle directly; it calls the Python API instead.

## Included deliverables

- Python FastAPI inference API in `risk-model-api/`
- Feature engineering utilities in `risk-model-api/feature_engineering.py`
- TypeScript Open-Meteo and risk model clients in `mobile/utils/`
- Location-aware Expo dashboard with map and risk estimate card in `mobile/App.tsx`
- Location permission configuration in `mobile/app.json`
- Environment and usage docs in `.env.example`

## Quick start

Use two terminals. On Windows, start the FastAPI model API in Terminal 1:

```bat
cd /d "E:\Project\jay dsml\Respira\risk-model-api"
.venv\Scripts\python.exe -m uvicorn app:app --host 0.0.0.0 --port 8000
```

In Terminal 2, start Expo:

```bat
cd /d "E:\Project\jay dsml\Respira\mobile"
npx expo start --lan --clear
```

Set `EXPO_PUBLIC_RISK_MODEL_API_URL` in `mobile/.env` to the computer's current LAN IP, for example `http://192.168.1.20:8000`. The phone and computer must be on the same network.

The Google Maps API key is read as `GOOGLE_MAPS_API_KEY` (without the `EXPO_PUBLIC_` prefix) and passed to native app configuration by `mobile/app.config.js`. A custom native Maps key is not used by Expo Go. The `mobile` project is prepared for an EAS Android development build; it can build in Expo's cloud, so Android Studio and a local Android SDK are not required.

Destination search is served by the FastAPI `/geocode` endpoint and uses Photon geocoding with OpenStreetMap data. It requires no Google Geocoding key. Search queries are sent to the Photon service through the backend; observe the provider's fair-use policy before public or high-volume deployment. Search results display OpenStreetMap attribution.

The **Explore** tab provides the destination risk checker. It searches real Photon/OpenStreetMap place results through the backend, fetches destination air observations from Open-Meteo, and requests a model estimate for the selected coordinates. Comparisons are shown only when the two estimates use the same observation date; these are historical environmental estimates and not travel-safety or personal asthma predictions.

### Build and run the Android development client

The previous Maps key was pasted into chat. Revoke it in Google Cloud and create a replacement before building. Enable billing and **Maps SDK for Android**. Restrict the replacement key to Maps SDK for Android. After EAS creates the Android signing keystore, further restrict the key to Android app `com.shwetishere.respira` and that keystore's SHA-1 certificate fingerprint.

1. From `mobile`, sign in to Expo and link this folder to an EAS project:

   ```bat
   cd /d "E:\Project\jay dsml\Respira\mobile"
   npx eas-cli@latest login
   npx eas-cli@latest init
   ```

2. In the linked project on `expo.dev`, open **Project settings → Environment variables**. Add `GOOGLE_MAPS_API_KEY` to the **development** environment using the replacement key, with **Sensitive** visibility. Do not use the `EXPO_PUBLIC_` prefix. The Android package name is `com.shwetishere.respira`.

3. Build the installable Android development APK in EAS cloud:

   ```bat
   npx eas-cli@latest build --platform android --profile development
   ```

   This profile includes `expo-dev-client`. EAS builds the APK and provides an install link/QR code. Open it on your Android phone to install Respira's development client. The cloud build uses Expo prebuild; `mobile/.easignore` excludes the old generated `android` directory and local `.env`, so the native key comes from the EAS environment variable.

4. Put the computer's current LAN URL in `mobile/.env`, for example `EXPO_PUBLIC_RISK_MODEL_API_URL=http://192.168.1.20:8000`. Start the Python API in one terminal using the command above. In another terminal, start Metro:

   ```bat
   cd /d "E:\Project\jay dsml\Respira\mobile"
   npx expo start --dev-client --lan --clear
   ```

   Open the installed **Respira development build** (not Expo Go) and scan/connect to the Metro QR code. The phone and computer must be on the same Wi-Fi, and the backend URL must point to the computer's current LAN IP.

If the Google key is restricted to Android apps, obtain the EAS Android keystore SHA-1 from `npx eas-cli@latest credentials --platform android` and add it to the key's Android app restrictions alongside the package name. Rebuild after changing Google Maps settings or native app configuration. No server is started by these setup steps.

## Risk model API

- Health: `GET /health`
- Predict: `POST /predict`

The FastAPI service rejects invalid data, missing values, NaN/Inf, and malformed model metadata.

## Mobile monitoring

The dashboard requests foreground location permission, gets the device's current GPS coordinates, displays them on a map, and fetches Open-Meteo air-quality data for that location. It requests PM2.5, nitrogen dioxide, and ozone in µg/m³; `carbon_dioxide` is a different gas and cannot substitute for NO2.

The app only calculates a result when it can find a complete, gap-free 24-hour record for a previous local day. The dashboard labels that result as historical and shows its observation time. There is no continuous/background location monitoring in this dashboard; each check is on demand.

Development diagnostics are printed in the Expo/Metro terminal with `[RESPIRA]` stage labels. They include the device coordinates, the live Open-Meteo observations, calculated features, model request/response, and UI acceptance, linked by a request ID. The FastAPI terminal logs model loading, health checks, input features, class labels, inference, request status, and duration using the same request ID. Neither log includes the Google Maps key. Device-specific logs may require the Expo Go developer console or native Android log tools.

The separate `backgroundMonitoring.ts` utility uses the same validated, complete-prior-day feature pipeline; the dashboard does not run background tracking. Notifications are currently unsupported and are not represented as sent by the app.

## Clinical validity and limitations

The model's class-1 probability is not the probability that a particular person will have an asthma attack. This prototype estimates environmental conditions from population-level pollution inputs; it is not clinically validated, cannot diagnose or predict an individual attack, and does not replace a clinician's advice or asthma action plan. The model's training horizon and feature units should be confirmed before treating historical daily inputs as current risk. For real deployments, keep the model private, use protected infrastructure, and enforce access controls.

## Checks

```bat
cd /d "E:\Project\jay dsml\Respira\mobile"
npm run typecheck
npm test
```

```bat
cd /d "E:\Project\jay dsml\Respira\risk-model-api"
.venv\Scripts\python.exe -m pytest -q
```
