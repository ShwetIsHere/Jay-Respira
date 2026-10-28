from __future__ import annotations

import numpy as np
from typing import Dict, Iterable, List, Sequence

import pandas as pd

FEATURE_NAMES: List[str] = [
    "pm2_5_24h_mean",
    "nitrogen_dioxide_24h_mean",
    "ozone_8h_max",
]


def _coerce_timestamp_column(df: pd.DataFrame) -> pd.DataFrame:
    if "timestamp" in df.columns:
        timestamp_key = "timestamp"
    elif "time" in df.columns:
        timestamp_key = "time"
    else:
        raise ValueError("Hourly pollution data requires a 'timestamp' or 'time' column.")

    result = df.copy()
    result["timestamp"] = pd.to_datetime(result[timestamp_key], errors="raise", utc=True)
    if timestamp_key != "timestamp":
        result = result.drop(columns=[timestamp_key], errors="ignore")
    return result


def validate_hourly_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    if df is None or df.empty:
        raise ValueError("No hourly environmental observations were provided.")

    required_columns = {"pm2_5", "nitrogen_dioxide", "ozone"}
    missing = required_columns - set(df.columns)
    if missing:
        raise ValueError(f"Missing required pollution columns: {sorted(missing)}")

    result = _coerce_timestamp_column(df)
    result = result.sort_values("timestamp").drop_duplicates(subset=["timestamp"], keep="last")
    return result


def _is_complete_day(df: pd.DataFrame, target_date: pd.Timestamp) -> bool:
    day_rows = df[df["timestamp"].dt.normalize() == target_date.normalize()].sort_values("timestamp")
    if len(day_rows) != 24:
        return False
    required = ["pm2_5", "nitrogen_dioxide", "ozone"]
    for column in required:
        values = pd.to_numeric(day_rows[column], errors="coerce")
        if values.isna().any() or not np.isfinite(values).all() or (values < 0).any():
            return False
    timestamps = day_rows["timestamp"].tolist()
    return all(
        timestamps[index] - timestamps[index - 1] == pd.Timedelta(hours=1)
        for index in range(1, len(timestamps))
    )


def compute_daily_features(
    hourly_data: Iterable[dict] | pd.DataFrame,
    target_date: str | pd.Timestamp,
) -> Dict[str, float]:
    target_value = pd.Timestamp(target_date)
    if target_value.tzinfo is None:
        target_value = target_value.tz_localize("UTC")

    if isinstance(hourly_data, pd.DataFrame):
        df = validate_hourly_dataframe(hourly_data)
    else:
        df = pd.DataFrame(hourly_data)
        df = validate_hourly_dataframe(df)

    if not _is_complete_day(df, target_value):
        raise ValueError(f"Incomplete daily observation set for {target_value.date()}. Expected 24 hourly values without NaN gaps.")

    day_df = df[df["timestamp"].dt.normalize() == target_value.normalize()].copy()
    pm25_mean = float(day_df["pm2_5"].mean())
    no2_mean = float(day_df["nitrogen_dioxide"].mean())
    ozone_rolling = day_df["ozone"].astype(float).rolling(window=8, min_periods=8).mean()
    ozone_max = float(ozone_rolling.max())

    return {
        "pm2_5_24h_mean": pm25_mean,
        "nitrogen_dioxide_24h_mean": no2_mean,
        "ozone_8h_max": ozone_max,
    }


def validate_feature_order(values: Sequence[float]) -> Dict[str, float]:
    if len(values) != len(FEATURE_NAMES):
        raise ValueError(f"Expected {len(FEATURE_NAMES)} feature values, received {len(values)}.")

    return {name: float(value) for name, value in zip(FEATURE_NAMES, values)}
