from __future__ import annotations

import math
import logging
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, Dict, Literal

import numpy as np
import pandas as pd
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field
from fastapi.responses import JSONResponse

from model_loader import load_model

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("respira.api")

DEFAULT_MEDIUM_THRESHOLD = 0.5
DEFAULT_HIGH_THRESHOLD = 0.8
FEATURE_ORDER = [
    "pm2_5_24h_mean",
    "nitrogen_dioxide_24h_mean",
    "ozone_8h_max",
]


class RiskFeatures(BaseModel):
    model_config = ConfigDict(extra="forbid")

    pm2_5_24h_mean: float = Field(..., description="Daily PM2.5 concentration mean")
    nitrogen_dioxide_24h_mean: float = Field(..., description="Daily nitrogen dioxide mean")
    ozone_8h_max: float = Field(..., description="Maximum rolling 8-hour ozone mean")

    @classmethod
    def validate(cls, payload: Dict[str, Any]) -> "RiskFeatures":
        model = cls.model_validate(payload)
        for field_name, value in model.model_dump().items():
            if not math.isfinite(value):
                raise HTTPException(status_code=422, detail=f"Field '{field_name}' must be finite.")
            if value < 0:
                raise HTTPException(status_code=422, detail=f"Field '{field_name}' must be >= 0.")
        return model


class HealthResponse(BaseModel):
    status: str
    model_loaded: bool


class PredictResponse(BaseModel):
    prediction: int
    risk_probability: float
    risk_level: Literal["low", "medium", "high"]
    features: RiskFeatures


def _get_risk_thresholds() -> tuple[float, float]:
    medium_threshold = float(os.getenv("RISK_MODEL_MEDIUM_THRESHOLD", DEFAULT_MEDIUM_THRESHOLD))
    high_threshold = float(os.getenv("RISK_MODEL_HIGH_THRESHOLD", DEFAULT_HIGH_THRESHOLD))
    if not (0 < medium_threshold < 1 and 0 < high_threshold < 1 and medium_threshold < high_threshold):
        raise ValueError("Risk thresholds must be finite values in (0,1) with medium < high.")
    return medium_threshold, high_threshold


def _classify_risk(probability: float) -> Literal["low", "medium", "high"]:
    medium_threshold, high_threshold = _get_risk_thresholds()
    if probability >= high_threshold:
        return "high"
    if probability >= medium_threshold:
        return "medium"
    return "low"


@asynccontextmanager
async def lifespan(app: FastAPI):
    global MODEL
    try:
        MODEL = load_model()
        logger.info("event=model_loaded classes=%s", getattr(MODEL, "classes_", None))
    except Exception:
        MODEL = None
        logger.exception("event=model_load_failed; prediction endpoint will return HTTP 503")
    yield
    MODEL = None


app = FastAPI(title="Respira Risk Model API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:19006",
        "http://127.0.0.1:19006",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:8081",
        "http://127.0.0.1:8081",
        "http://10.30.203.52:8081",
        "http://10.169.247.52:8081",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

MODEL = None


@app.exception_handler(RequestValidationError)
async def log_request_validation_error(request: Request, exc: RequestValidationError):
    issues = [
        {"location": error.get("loc"), "type": error.get("type")}
        for error in exc.errors()
    ]
    logger.warning(
        "event=request_validation_failed request_id=%s issues=%s",
        getattr(request.state, "request_id", "unavailable"),
        issues,
    )
    return JSONResponse(status_code=422, content={"detail": jsonable_encoder(exc.errors())})


@app.middleware("http")
async def log_request(request: Request, call_next):
    supplied_id = request.headers.get("X-Request-ID", "")
    request_id = supplied_id if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", supplied_id) else uuid.uuid4().hex
    request.state.request_id = request_id
    started_at = time.perf_counter()
    logger.info(
        "event=request_started request_id=%s method=%s path=%s",
        request_id,
        request.method,
        request.url.path,
    )
    try:
        response = await call_next(request)
    except Exception:
        logger.exception("event=request_failed request_id=%s", request_id)
        raise

    duration_ms = round((time.perf_counter() - started_at) * 1000, 2)
    response.headers["X-Request-ID"] = request_id
    logger.info(
        "event=request_completed request_id=%s status=%s duration_ms=%s",
        request_id,
        response.status_code,
        duration_ms,
    )
    return response


@app.get("/health", response_model=HealthResponse)
def health(request: Request) -> Dict[str, Any]:
    logger.info("event=health_check request_id=%s model_loaded=%s", request.state.request_id, MODEL is not None)
    return {"status": "ok" if MODEL is not None else "degraded", "model_loaded": MODEL is not None}


@app.post("/predict", response_model=PredictResponse)
def predict(payload: Dict[str, Any], request: Request) -> Dict[str, Any]:
    request_id = request.state.request_id
    if set(payload.keys()) != set(FEATURE_ORDER):
        logger.warning("event=validation_failed request_id=%s reason=missing_or_extra_features", request_id)
        raise HTTPException(status_code=422, detail=f"Missing or extra features. Expected keys: {FEATURE_ORDER}")

    try:
        feature_data = RiskFeatures.validate(payload)
    except HTTPException:
        logger.warning("event=validation_failed request_id=%s reason=invalid_feature_value", request_id)
        raise
    except Exception as exc:
        logger.warning("event=validation_failed request_id=%s error=%s", request_id, exc)
        raise HTTPException(status_code=422, detail=f"Feature validation failed: {exc}") from exc

    logger.info("event=features_validated request_id=%s features=%s", request_id, feature_data.model_dump())
    if MODEL is None:
        logger.error("event=inference_unavailable request_id=%s reason=model_not_loaded", request_id)
        raise HTTPException(
            status_code=503,
            detail="Risk model is unavailable. Ensure the model file exists and is compatible with the training contract.",
        )

    values = pd.DataFrame(
        [feature_data.model_dump()],
        columns=FEATURE_ORDER,
        dtype=float,
    )
    try:
        probabilities = MODEL.predict_proba(values)[0]
        classes = np.asarray(getattr(MODEL, "classes_", None))
        if classes.size == 0:
            raise ValueError("The model does not expose classes_.")
        if 1 not in classes:
            raise ValueError("The model does not define a positive class '1'.")
        class_index = int(np.where(classes == 1)[0][0])
        risk_probability = float(probabilities[class_index])
        prediction = int(MODEL.predict(values)[0])
        if prediction not in (0, 1) or not math.isfinite(risk_probability) or not 0 <= risk_probability <= 1:
            raise ValueError("The model returned an invalid prediction or probability.")
    except Exception as exc:
        logger.exception("event=inference_failed request_id=%s", request_id)
        raise HTTPException(status_code=500, detail=f"Model inference failed: {exc}") from exc

    risk_level = _classify_risk(risk_probability)
    logger.info(
        "event=inference_completed request_id=%s classes=%s prediction=%s class_1_probability=%s risk_level=%s",
        request_id,
        classes.tolist(),
        prediction,
        risk_probability,
        risk_level,
    )
    return {
        "prediction": prediction,
        "risk_probability": risk_probability,
        "risk_level": risk_level,
        "features": feature_data.model_dump(),
    }


@app.get("/geocode")
async def geocode_destination(q: str, request: Request) -> Dict[str, Any]:
    query = q.strip()
    request_id = request.state.request_id
    if len(query) < 3 or len(query) > 200:
        raise HTTPException(status_code=422, detail="Search query must be between 3 and 200 characters.")

    logger.info("event=geocode_started request_id=%s query=%s", request_id, query)
    started_at = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                "https://photon.komoot.io/api/",
                params={"q": query, "limit": 5, "lang": "en"},
                headers={"User-Agent": "Respira-DestinationSearch/1.0"},
            )
    except httpx.TimeoutException as exc:
        logger.warning("event=geocode_timeout request_id=%s", request_id)
        raise HTTPException(status_code=504, detail="Destination search timed out.") from exc
    except httpx.HTTPError as exc:
        logger.exception("event=geocode_request_failed request_id=%s", request_id)
        raise HTTPException(status_code=502, detail="Destination search provider could not be reached.") from exc

    duration_ms = round((time.perf_counter() - started_at) * 1000, 2)
    if response.is_error:
        logger.warning(
            "event=geocode_provider_error request_id=%s http_status=%s duration_ms=%s",
            request_id,
            response.status_code,
            duration_ms,
        )
        raise HTTPException(status_code=502, detail="Destination search provider failed.")
    try:
        payload = response.json()
    except ValueError as exc:
        logger.warning(
            "event=geocode_invalid_response request_id=%s http_status=%s duration_ms=%s",
            request_id,
            response.status_code,
            duration_ms,
        )
        raise HTTPException(status_code=502, detail="Destination search provider returned an invalid response.") from exc

    if not isinstance(payload, dict):
        logger.warning(
            "event=geocode_invalid_response request_id=%s reason=payload_not_object duration_ms=%s",
            request_id,
            duration_ms,
        )
        raise HTTPException(status_code=502, detail="Destination search provider returned an invalid response.")

    provider_results = payload.get("features", [])
    if not isinstance(provider_results, list):
        logger.warning(
            "event=geocode_invalid_response request_id=%s reason=features_not_list duration_ms=%s",
            request_id,
            duration_ms,
        )
        raise HTTPException(status_code=502, detail="Destination search provider returned an invalid response.")
    logger.info(
        "event=geocode_completed request_id=%s provider=photon http_status=%s result_count=%s duration_ms=%s",
        request_id,
        response.status_code,
        len(provider_results),
        duration_ms,
    )
    results = []
    for result in provider_results[:5]:
        if not isinstance(result, dict):
            continue
        properties = result.get("properties")
        geometry = result.get("geometry")
        if not isinstance(properties, dict) or not isinstance(geometry, dict):
            continue
        coordinates = geometry.get("coordinates")
        if not isinstance(coordinates, list) or len(coordinates) < 2:
            continue
        longitude, latitude = coordinates[:2]
        name = properties.get("name")
        if not isinstance(name, str) or not name.strip():
            name = properties.get("street") or properties.get("city") or properties.get("country")
        address_parts = [
            properties.get(part)
            for part in ("housenumber", "street", "postcode", "city", "district", "state", "country")
        ]
        address = ", ".join(
            dict.fromkeys(part.strip() for part in address_parts if isinstance(part, str) and part.strip())
        )
        osm_id = properties.get("osm_id")
        osm_type = properties.get("osm_type")
        if (
            isinstance(latitude, (int, float))
            and math.isfinite(latitude)
            and -90 <= latitude <= 90
            and isinstance(longitude, (int, float))
            and math.isfinite(longitude)
            and -180 <= longitude <= 180
            and isinstance(osm_id, (int, str))
            and isinstance(osm_type, str)
            and bool(osm_type.strip())
            and bool(address)
            and isinstance(name, str)
            and bool(name.strip())
        ):
            results.append({
                "id": f"{osm_type}:{osm_id}",
                "name": name.strip(),
                "address": address,
                "latitude": latitude,
                "longitude": longitude,
            })

    return {"results": results}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
