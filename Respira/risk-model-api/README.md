# Respira Risk Model API

This service exposes the trained risk model without loading the pickle in the mobile app.

## Setup

```bash
python -m venv .venv
. .venv/bin/activate  # PowerShell: .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Place a valid scikit-learn model at `../model/respira_random_forest.pkl` or set `RISK_MODEL_PATH`.

## Run

```bash
uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```

## Verify health

```bash
curl http://localhost:8000/health
```

## Test prediction

```bash
curl -X POST http://localhost:8000/predict \
  -H 'Content-Type: application/json' \
  -d '{"pm2_5_24h_mean":60.2,"nitrogen_dioxide_24h_mean":16.54,"ozone_8h_max":129.5}'
```

## Production note

Authentication and authorization are intentionally left disabled for local development only. Production deployments must apply access controls, rate limiting, and network protections.

## Known limitations

- The service intentionally refuses to fabricate predictions when the model is missing or invalid.
- Feature engineering requires a complete 24-hour set. Historical or partial-day data is not treated as current risk.
- Prediction horizon and clinical validity must be reviewed before any real-world use.
