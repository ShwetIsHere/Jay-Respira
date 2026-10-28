from __future__ import annotations

import os
import pickle
from pathlib import Path
from typing import Any

import joblib

DEFAULT_MODEL_PATH = Path(__file__).resolve().parents[1] / "model" / "respira_random_forest.pkl"
MODEL_PATH_ENV_KEY = "RISK_MODEL_PATH"


def resolve_model_path() -> Path:
    configured = os.getenv(MODEL_PATH_ENV_KEY)
    if configured:
        return Path(configured).expanduser().resolve()
    return DEFAULT_MODEL_PATH


def load_model() -> Any:
    path = resolve_model_path()
    if not path.exists():
        raise FileNotFoundError(f"Model file not found at {path}.")

    try:
        if joblib is not None:
            return joblib.load(path)
    except Exception:
        pass

    try:
        with path.open("rb") as model_file:
            return pickle.load(model_file)
    except Exception as exc:  # pragma: no cover - exercised in API tests
        raise ValueError(f"Model file is unreadable or incompatible: {exc}") from exc
