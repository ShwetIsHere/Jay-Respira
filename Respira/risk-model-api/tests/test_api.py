from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
from fastapi.testclient import TestClient

from app import app
from model_loader import load_model, resolve_model_path


class FakeModel:
    classes_ = [0, 1]

    def __init__(self):
        self.predict_calls = 0
        self.predict_proba_calls = 0
        self.received_features = None

    def predict_proba(self, values):
        self.predict_proba_calls += 1
        self.received_features = values.columns.tolist()
        return [[0.2, 0.8]]

    def predict(self, values):
        self.predict_calls += 1
        return [1]


class ReversedClassModel:
    classes_ = [1, 0]

    def predict_proba(self, values):
        return [[0.73, 0.27]]

    def predict(self, values):
        return [1]


class NoPosClassModel:
    classes_ = [0, 2]

    def predict_proba(self, values):
        return [[0.5, 0.5]]

    def predict(self, values):
        return [0]


@pytest.fixture
def client():
    return TestClient(app)


def test_health_endpoint(client):
    response = client.get("/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] in {"ok", "degraded"}
    assert "model_loaded" in payload


def test_valid_request_returns_prediction(client, monkeypatch):
    model = FakeModel()
    monkeypatch.setattr("app.MODEL", model)
    response = client.post(
        "/predict",
        json={
            "pm2_5_24h_mean": 60.2,
            "nitrogen_dioxide_24h_mean": 16.54,
            "ozone_8h_max": 129.5,
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["prediction"] == 1
    assert payload["risk_probability"] == pytest.approx(0.8)
    assert payload["risk_level"] == "high"
    assert response.headers["x-request-id"]
    assert model.predict_proba_calls == 1
    assert model.predict_calls == 1
    assert model.received_features == [
        "pm2_5_24h_mean",
        "nitrogen_dioxide_24h_mean",
        "ozone_8h_max",
    ]


def test_request_correlation_id_is_preserved(client, monkeypatch):
    monkeypatch.setattr("app.MODEL", FakeModel())
    response = client.post(
        "/predict",
        headers={"X-Request-ID": "respira-test-123"},
        json={
            "pm2_5_24h_mean": 30,
            "nitrogen_dioxide_24h_mean": 12,
            "ozone_8h_max": 50,
        },
    )
    assert response.headers["x-request-id"] == "respira-test-123"


def test_positive_probability_uses_class_label_not_array_position(client, monkeypatch):
    monkeypatch.setattr("app.MODEL", ReversedClassModel())
    response = client.post(
        "/predict",
        json={
            "pm2_5_24h_mean": 30,
            "nitrogen_dioxide_24h_mean": 12,
            "ozone_8h_max": 50,
        },
    )
    assert response.status_code == 200
    assert response.json()["risk_probability"] == pytest.approx(0.73)


def test_missing_model_returns_unavailable_not_fake_prediction(client, monkeypatch):
    monkeypatch.setattr("app.MODEL", None)
    response = client.post(
        "/predict",
        json={
            "pm2_5_24h_mean": 30,
            "nitrogen_dioxide_24h_mean": 12,
            "ozone_8h_max": 50,
        },
    )
    assert response.status_code == 503
    assert "model is unavailable" in response.json()["detail"].lower()


def test_missing_features_are_rejected(client):
    response = client.post("/predict", json={"pm2_5_24h_mean": 12.0, "nitrogen_dioxide_24h_mean": 3.0})
    assert response.status_code == 422


def test_invalid_feature_types_are_rejected(client):
    response = client.post(
        "/predict",
        json={
            "pm2_5_24h_mean": "not-a-number",
            "nitrogen_dioxide_24h_mean": 14.0,
            "ozone_8h_max": 50.0,
        },
    )
    assert response.status_code == 422


def test_nan_and_inf_are_rejected(client):
    payload_nan = json.dumps(
        {
            "pm2_5_24h_mean": float("nan"),
            "nitrogen_dioxide_24h_mean": 12.0,
            "ozone_8h_max": 9.0,
        },
        allow_nan=True,
    )
    response = client.post("/predict", content=payload_nan, headers={"content-type": "application/json"})
    assert response.status_code == 422

    payload_inf = json.dumps(
        {
            "pm2_5_24h_mean": float("inf"),
            "nitrogen_dioxide_24h_mean": 12.0,
            "ozone_8h_max": 9.0,
        },
        allow_nan=True,
    )
    response = client.post("/predict", content=payload_inf, headers={"content-type": "application/json"})
    assert response.status_code == 422


def test_missing_class_one_returns_error(client, monkeypatch):
    monkeypatch.setattr("app.MODEL", NoPosClassModel())
    response = client.post(
        "/predict",
        json={
            "pm2_5_24h_mean": 60.2,
            "nitrogen_dioxide_24h_mean": 16.54,
            "ozone_8h_max": 129.5,
        },
    )
    assert response.status_code == 500
    assert "class '1'" in response.json()["detail"]


def test_missing_model_file_is_detected(monkeypatch):
    monkeypatch.setenv("RISK_MODEL_PATH", "missing-model.pkl")
    assert resolve_model_path().name == "missing-model.pkl"
    with pytest.raises(FileNotFoundError, match="Model file not found"):
        load_model()


class FakeGeocodeResponse:
    def __init__(self, payload, status_code=200):
        self.payload = payload
        self.status_code = status_code
        self.is_error = status_code >= 400

    def json(self):
        return self.payload


class FakeGeocodeClient:
    def __init__(self, response, **_kwargs):
        self.response = response
        self.request = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def get(self, url, params, headers=None):
        self.request = {"url": url, "params": params, "headers": headers}
        return self.response


def test_geocode_returns_sanitized_photon_places(client, monkeypatch):
    response = FakeGeocodeResponse({
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {
                "osm_id": 123,
                "osm_type": "R",
                "name": "Vadodara",
                "city": "Vadodara",
                "state": "Gujarat",
                "country": "India",
            },
            "geometry": {"type": "Point", "coordinates": [73.2, 22.3]},
        }],
    })
    fake_client = FakeGeocodeClient(response)
    monkeypatch.setattr("app.httpx.AsyncClient", lambda **kwargs: fake_client)

    result = client.get("/geocode", params={"q": "Vadodara"})

    assert result.status_code == 200
    assert result.json() == {
        "results": [{
            "id": "R:123",
            "name": "Vadodara",
            "address": "Vadodara, Gujarat, India",
            "latitude": 22.3,
            "longitude": 73.2,
        }],
    }
    assert fake_client.request["url"] == "https://photon.komoot.io/api/"
    assert fake_client.request["params"] == {"q": "Vadodara", "limit": 5, "lang": "en"}
    assert fake_client.request["headers"] == {"User-Agent": "Respira-DestinationSearch/1.0"}


def test_geocode_empty_features_returns_empty_result_list(client, monkeypatch):
    monkeypatch.setattr(
        "app.httpx.AsyncClient",
        lambda **kwargs: FakeGeocodeClient(FakeGeocodeResponse({"type": "FeatureCollection", "features": []})),
    )

    response = client.get("/geocode", params={"q": "No such place"})

    assert response.status_code == 200
    assert response.json() == {"results": []}


def test_geocode_hides_provider_errors_and_rejects_malformed_places(client, monkeypatch):
    monkeypatch.setattr(
        "app.httpx.AsyncClient",
        lambda **kwargs: FakeGeocodeClient(FakeGeocodeResponse(
            {"error": "provider-detail"},
            status_code=503,
        )),
    )

    provider_error = client.get("/geocode", params={"q": "Vadodara"})

    assert provider_error.status_code == 502
    assert "provider-detail" not in provider_error.text

    monkeypatch.setattr(
        "app.httpx.AsyncClient",
        lambda **kwargs: FakeGeocodeClient(FakeGeocodeResponse({
            "type": "FeatureCollection",
            "features": [{"properties": {}, "geometry": {"coordinates": []}}],
        })),
    )
    malformed = client.get("/geocode", params={"q": "Vadodara"})
    assert malformed.status_code == 200
    assert malformed.json() == {"results": []}


def test_geocode_rejects_invalid_provider_payload(client, monkeypatch):
    monkeypatch.setattr(
        "app.httpx.AsyncClient",
        lambda **kwargs: FakeGeocodeClient(FakeGeocodeResponse({"type": "FeatureCollection", "features": None})),
    )

    response = client.get("/geocode", params={"q": "Vadodara"})

    assert response.status_code == 502
    assert "invalid response" in response.json()["detail"].lower()


def test_geocode_rejects_invalid_query(client):
    response = client.get("/geocode", params={"q": "ab"})
    assert response.status_code == 422
