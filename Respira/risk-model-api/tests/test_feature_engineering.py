from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pandas as pd
import pytest

from feature_engineering import compute_daily_features


def _hourly_frame() -> pd.DataFrame:
    timestamps = pd.date_range("2024-01-01 00:00:00", periods=24, freq="h", tz="UTC")
    return pd.DataFrame(
        {
            "timestamp": timestamps,
            "pm2_5": [10 + i for i in range(24)],
            "nitrogen_dioxide": [20 + i * 0.5 for i in range(24)],
            "ozone": [50 + i for i in range(24)],
        }
    )


def test_daily_features_are_computed_correctly() -> None:
    features = compute_daily_features(_hourly_frame(), "2024-01-01")
    assert features["pm2_5_24h_mean"] == pytest.approx(21.5)
    assert features["nitrogen_dioxide_24h_mean"] == pytest.approx(25.75)
    assert features["ozone_8h_max"] == pytest.approx(69.5)


def test_missing_values_are_rejected() -> None:
    frame = _hourly_frame()
    frame.loc[0, "pm2_5"] = None
    with pytest.raises(ValueError, match="Incomplete daily observation set"):
        compute_daily_features(frame, "2024-01-01")


def test_incomplete_day_is_rejected() -> None:
    frame = _hourly_frame().iloc[:-1]
    with pytest.raises(ValueError, match="Incomplete daily observation set"):
        compute_daily_features(frame, "2024-01-01")


def test_full_length_day_with_timestamp_gap_is_rejected() -> None:
    frame = _hourly_frame()
    frame.loc[10, "timestamp"] = pd.Timestamp("2024-01-01 11:00:00", tz="UTC")
    with pytest.raises(ValueError, match="Incomplete daily observation set"):
        compute_daily_features(frame, "2024-01-01")


def test_timezone_and_gap_handling() -> None:
    frame = _hourly_frame()
    frame = frame.iloc[[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]].copy()
    frame.loc[5, "timestamp"] = pd.Timestamp("2024-01-01 05:00:00", tz="America/New_York")
    assert frame["timestamp"].dt.tz is not None
    with pytest.raises(ValueError):
        compute_daily_features(frame, "2024-01-01")
