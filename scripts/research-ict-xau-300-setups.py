#!/usr/bin/env python3
"""Chronological XAUUSD SMC/ICT executed-setup study.

The script audits every independent candidate as rejected, valid-but-unfilled or executed. The
300-row research database is then sampled systematically from the complete chronological stream
of executed setups. Conditioning on a rule-valid fill defines the trade population; neither PnL
nor grade is used for sample selection.

Runtime dependencies: pandas, numpy and pyarrow.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
from collections import defaultdict, deque
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Literal

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

Side = Literal["long", "short"]
Status = Literal["REJECTED", "VALID_UNFILLED", "EXECUTED", "AMBIGUOUS", "DATA_INVALID"]
Model = Literal[
    "EXTERNAL_SWEEP_REVERSAL",
    "TREND_CONTINUATION",
    "FVG_REBALANCE",
    "FAILED_BREAKOUT",
]

START = pd.Timestamp("2023-07-16T00:00:00Z")
END = pd.Timestamp("2026-02-18T00:00:00Z")
SAMPLE_SIZE = 300
SLIPPAGE_BPS_PER_FILL = 0.5
MAX_ENTRY_WAIT_BARS = 8
MAX_HOLD_BARS = 180


@dataclass
class Sweep:
    side: Side
    sweep_index: int
    reclaim_index: int
    level_type: str
    level_scope: str
    level_price: float
    extreme: float
    penetration: float
    penetration_r5: float
    reclaim_bars: int
    spread: float


@dataclass
class Setup:
    sample_id: str
    source_candidate_number: int
    split: str
    timestamp_utc: str
    timestamp_new_york: str
    date_new_york: str
    weekday_new_york: str
    session: str
    model: Model
    direction: Side
    status: Status
    rejection_reasons: list[str]
    data_source: str
    symbol: str = "XAUUSD"
    timeframe_environment: str = "15m"
    timeframe_poi: str = "5m"
    timeframe_execution: str = "1m"
    bias_15m: str = "range"
    regime_15m: str = "range_normal_vol"
    liquidity_type: str = ""
    liquidity_scope: str = ""
    liquidity_price: float = 0.0
    sweep_time_utc: str = ""
    sweep_penetration_usd: float = 0.0
    sweep_penetration_r5: float = 0.0
    sweep_reclaim_bars: int = 0
    mss_pivot_price: float = 0.0
    mss_displacement_multiple: float = 0.0
    mss_body_ratio: float = 0.0
    mss_has_fvg: bool = False
    fvg_lower: float | None = None
    fvg_upper: float | None = None
    fvg_size_r1: float | None = None
    order_block_lower: float | None = None
    order_block_upper: float | None = None
    ob_fvg_overlap: bool = False
    five_minute_fvg_rebalance: bool = False
    retest_number: int | None = None
    entry_time_utc: str | None = None
    entry_mid: float | None = None
    entry_executed: float | None = None
    stop_mid: float | None = None
    stop_distance_usd: float | None = None
    stop_distance_r5: float | None = None
    nearest_liquidity_target: float | None = None
    nearest_liquidity_rr: float | None = None
    tp1_mid: float | None = None
    tp2_mid: float | None = None
    runner_target_mid: float | None = None
    exit_time_utc: str | None = None
    exit_reason: str | None = None
    spread_at_signal_usd: float = 0.0
    spread_at_entry_usd: float | None = None
    slippage_bps_per_fill: float = SLIPPAGE_BPS_PER_FILL
    gross_r: float | None = None
    cost_r: float | None = None
    net_r: float | None = None
    mfe_r: float | None = None
    mae_r: float | None = None
    false_mss: bool | None = None
    score_environment: int = 0
    score_liquidity: int = 0
    score_sweep: int = 0
    score_mss: int = 0
    score_ob_fvg: int = 0
    score_session_spread: int = 0
    score_target_rr: int = 0
    total_score: int = 0
    grade: str = "C"
    screenshot_reference: str = ""
    notes: str = ""


@dataclass
class Context:
    df: pd.DataFrame
    bars5: pd.DataFrame
    bars15: pd.DataFrame
    pivot_high_1m: np.ndarray
    pivot_low_1m: np.ndarray
    pivot_high_5m: np.ndarray
    pivot_low_5m: np.ndarray
    pivot_high_15m: np.ndarray
    pivot_low_15m: np.ndarray
    completed5: np.ndarray
    completed15: np.ndarray
    date_stats: dict[str, dict[str, float]]
    global_spread_p95: float


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--parquet", default="research-data/xauusd-huggingface/raw/0000.parquet")
    parser.add_argument("--samples", type=int, default=SAMPLE_SIZE)
    parser.add_argument("--csv", default="research-ict-xau-300-setups.csv")
    parser.add_argument("--json", default="research-ict-xau-300-setups.json")
    parser.add_argument("--report", default="docs/strategy/XAU_SMC_ICT_300_SETUP_ANALYSIS.md")
    return parser.parse_args()


def iso(ts: pd.Timestamp | datetime | np.datetime64 | None) -> str | None:
    if ts is None or pd.isna(ts):
        return None
    return pd.Timestamp(ts).tz_convert("UTC").isoformat().replace("+00:00", "Z")


def finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def load_source(path: Path) -> tuple[pd.DataFrame, dict[str, Any]]:
    columns = ["datetime", "open", "high", "low", "close", "spread", "tickvol"]
    schema = pq.read_schema(path)
    columns = [column for column in columns if column in schema.names]
    arrow = pq.read_table(path, columns=columns)
    time_col = arrow["datetime"]
    mask = pc.and_(
        pc.greater_equal(time_col, pa.scalar(START.tz_localize(None).to_pydatetime(), type=time_col.type)),
        pc.less(time_col, pa.scalar(END.tz_localize(None).to_pydatetime(), type=time_col.type)),
    )
    arrow = arrow.filter(mask)
    df = arrow.to_pandas()
    df["datetime"] = pd.to_datetime(df["datetime"], utc=True)
    df = df.sort_values("datetime").drop_duplicates("datetime", keep="first").reset_index(drop=True)
    for column in ["open", "high", "low", "close", "spread"]:
        df[column] = pd.to_numeric(df[column], errors="coerce").astype("float64")
    if "tickvol" not in df:
        df["tickvol"] = 0.0
    df["tickvol"] = pd.to_numeric(df["tickvol"], errors="coerce").fillna(0.0).astype("float64")
    valid = (
        df[["open", "high", "low", "close", "spread"]].notna().all(axis=1)
        & (df["open"] > 0)
        & (df["high"] >= df[["open", "close"]].max(axis=1))
        & (df["low"] <= df[["open", "close"]].min(axis=1))
        & (df["high"] >= df["low"])
        & (df["spread"] >= 0)
    )
    invalid_rows = int((~valid).sum())
    df = df.loc[valid].reset_index(drop=True)
    # Source spread is a MetaTrader-style integer point field: 160 -> approximately $0.160.
    df["spread_usd"] = df["spread"] / 1_000.0
    df["range"] = df["high"] - df["low"]
    df["body"] = (df["close"] - df["open"]).abs()
    df["body_ratio"] = np.where(df["range"] > 0, df["body"] / df["range"], 0.0)
    df["r1"] = df["range"].rolling(20, min_periods=20).median().shift(1)
    df["median_body20"] = df["body"].rolling(20, min_periods=20).median().shift(1)
    ny = df["datetime"].dt.tz_convert("America/New_York")
    df["ny_time"] = ny
    df["ny_date"] = ny.dt.strftime("%Y-%m-%d")
    df["ny_weekday"] = ny.dt.strftime("%a")
    df["ny_minute"] = ny.dt.hour * 60 + ny.dt.minute
    gaps = df["datetime"].diff().dt.total_seconds().fillna(60)
    source_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    metadata = {
        "path": str(path),
        "sha256": source_hash,
        "rows": int(len(df)),
        "invalidRowsRemoved": invalid_rows,
        "from": iso(df.iloc[0]["datetime"]),
        "through": iso(df.iloc[-1]["datetime"]),
        "duplicateTimestampsRemoved": int(arrow.num_rows - len(df) - invalid_rows),
        "gapsOverOneMinute": int((gaps > 60).sum()),
        "medianSpreadUsd": float(df["spread_usd"].median()),
        "p95SpreadUsd": float(df["spread_usd"].quantile(0.95)),
    }
    return df, metadata


def aggregate(df: pd.DataFrame, minutes: int) -> pd.DataFrame:
    indexed = df.set_index("datetime")
    out = indexed.resample(f"{minutes}min", label="left", closed="left", origin="epoch").agg(
        open=("open", "first"),
        high=("high", "max"),
        low=("low", "min"),
        close=("close", "last"),
        volume=("tickvol", "sum"),
        spread_usd=("spread_usd", "median"),
        source_rows=("close", "count"),
    )
    out = out.dropna(subset=["open", "high", "low", "close"]).reset_index()
    out["range"] = out["high"] - out["low"]
    out["r"] = out["range"].rolling(20, min_periods=20).median().shift(1)
    out["atr20"] = out["range"].rolling(20, min_periods=20).mean().shift(1)
    out["range_median100"] = out["range"].rolling(100, min_periods=40).median().shift(1)
    return out


def pivots(high: np.ndarray, low: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    size = len(high)
    ph = np.zeros(size, dtype=bool)
    pl = np.zeros(size, dtype=bool)
    if size < 5:
        return ph, pl
    for i in range(2, size - 2):
        ph[i] = high[i] > high[i - 1] and high[i] >= high[i - 2] and high[i] > high[i + 1] and high[i] >= high[i + 2]
        pl[i] = low[i] < low[i - 1] and low[i] <= low[i - 2] and low[i] < low[i + 1] and low[i] <= low[i + 2]
    return ph, pl


def completed_bar_map(one_minute_times: np.ndarray, higher_times: np.ndarray, duration_seconds: int) -> np.ndarray:
    # A one-minute bar timestamp is its open. At its close (t+60), only HTF bars ending by t+60 are known.
    closes = one_minute_times.astype("datetime64[s]").astype(np.int64) + 60
    ends = higher_times.astype("datetime64[s]").astype(np.int64) + duration_seconds
    return np.searchsorted(ends, closes, side="right") - 1


def build_date_stats(df: pd.DataFrame) -> dict[str, dict[str, float]]:
    stats: dict[str, dict[str, float]] = {}
    grouped = list(df.groupby("ny_date", sort=True))
    previous_high = previous_low = None
    previous_date = None
    for date_key, group in grouped:
        asian = group[(group["ny_minute"] >= 0) & (group["ny_minute"] < 4 * 60)]
        # Freeze to 20:00-00:00 ET by taking the previous NY calendar day's late session.
        current_date = pd.Timestamp(date_key)
        prev_key = (current_date - pd.Timedelta(days=1)).strftime("%Y-%m-%d")
        prev_late = df[(df["ny_date"] == prev_key) & (df["ny_minute"] >= 20 * 60)]
        stats[date_key] = {
            "previous_day_high": float(previous_high) if previous_high is not None else math.nan,
            "previous_day_low": float(previous_low) if previous_low is not None else math.nan,
            "asian_high": float(prev_late["high"].max()) if len(prev_late) else math.nan,
            "asian_low": float(prev_late["low"].min()) if len(prev_late) else math.nan,
            "previous_trading_date": previous_date or "",
        }
        previous_high = float(group["high"].max())
        previous_low = float(group["low"].min())
        previous_date = date_key
    return stats


def make_context(df: pd.DataFrame) -> Context:
    bars5 = aggregate(df, 5)
    bars15 = aggregate(df, 15)
    ph1, pl1 = pivots(df["high"].to_numpy(), df["low"].to_numpy())
    ph5, pl5 = pivots(bars5["high"].to_numpy(), bars5["low"].to_numpy())
    ph15, pl15 = pivots(bars15["high"].to_numpy(), bars15["low"].to_numpy())
    return Context(
        df=df,
        bars5=bars5,
        bars15=bars15,
        pivot_high_1m=ph1,
        pivot_low_1m=pl1,
        pivot_high_5m=ph5,
        pivot_low_5m=pl5,
        pivot_high_15m=ph15,
        pivot_low_15m=pl15,
        completed5=completed_bar_map(df["datetime"].to_numpy(), bars5["datetime"].to_numpy(), 300),
        completed15=completed_bar_map(df["datetime"].to_numpy(), bars15["datetime"].to_numpy(), 900),
        date_stats=build_date_stats(df),
        global_spread_p95=float(df["spread_usd"].quantile(0.95)),
    )


def recent_confirmed(indices: np.ndarray, completed_index: int, count: int, lookback: int = 160) -> list[int]:
    latest_pivot = completed_index - 2
    if latest_pivot < 2:
        return []
    start = max(2, latest_pivot - lookback)
    found = np.flatnonzero(indices[start : latest_pivot + 1]) + start
    return found[-count:].tolist()


def bias_and_regime(ctx: Context, one_index: int) -> tuple[str, str]:
    k = int(ctx.completed15[one_index])
    if k < 10:
        return "range", "range_normal_vol"
    highs = recent_confirmed(ctx.pivot_high_15m, k, 3)
    lows = recent_confirmed(ctx.pivot_low_15m, k, 3)
    bias = "range"
    if len(highs) >= 2 and len(lows) >= 2:
        hh = ctx.bars15.iloc[highs[-1]]["high"] > ctx.bars15.iloc[highs[-2]]["high"]
        hl = ctx.bars15.iloc[lows[-1]]["low"] > ctx.bars15.iloc[lows[-2]]["low"]
        lh = ctx.bars15.iloc[highs[-1]]["high"] < ctx.bars15.iloc[highs[-2]]["high"]
        ll = ctx.bars15.iloc[lows[-1]]["low"] < ctx.bars15.iloc[lows[-2]]["low"]
        close = float(ctx.bars15.iloc[k]["close"])
        if hh and hl and close > float(ctx.bars15.iloc[highs[-2]]["high"]):
            bias = "bullish"
        elif lh and ll and close < float(ctx.bars15.iloc[lows[-2]]["low"]):
            bias = "bearish"
    current_range = finite(ctx.bars15.iloc[k]["range"]) or 0.0
    median100 = finite(ctx.bars15.iloc[k]["range_median100"]) or current_range
    vol = "high_vol" if median100 > 0 and current_range >= 1.5 * median100 else "low_vol" if median100 > 0 and current_range <= 0.65 * median100 else "normal_vol"
    trend = "trend" if bias != "range" else "range"
    return bias, f"{trend}_{vol}"


def session_name(row: pd.Series) -> str | None:
    minute = int(row["ny_minute"])
    if row["ny_weekday"] in {"Sat", "Sun"}:
        return None
    if 2 * 60 <= minute < 5 * 60:
        return "london"
    if 7 * 60 <= minute < 11 * 60:
        return "new_york"
    return None


def last_confirmed_5m_level(ctx: Context, one_index: int, side: Side) -> tuple[float, str, str] | None:
    k = int(ctx.completed5[one_index])
    flags = ctx.pivot_low_5m if side == "long" else ctx.pivot_high_5m
    found = recent_confirmed(flags, k, 3, lookback=80)
    if not found:
        return None
    j = found[-1]
    price = float(ctx.bars5.iloc[j]["low" if side == "long" else "high"])
    kind = "5m_swing_low" if side == "long" else "5m_swing_high"
    if len(found) >= 2:
        prev = float(ctx.bars5.iloc[found[-2]]["low" if side == "long" else "high"])
        r5 = finite(ctx.bars5.iloc[k]["r"]) or abs(price) * 0.0005
        if abs(price - prev) <= 0.15 * r5:
            kind = "equal_lows" if side == "long" else "equal_highs"
    return price, kind, "internal"


def levels_for(ctx: Context, one_index: int, side: Side) -> list[tuple[float, str, str]]:
    row = ctx.df.iloc[one_index]
    stats = ctx.date_stats.get(str(row["ny_date"]), {})
    if side == "long":
        raw = [
            (stats.get("previous_day_low"), "previous_day_low", "external"),
            (stats.get("asian_low"), "asian_low", "external"),
        ]
    else:
        raw = [
            (stats.get("previous_day_high"), "previous_day_high", "external"),
            (stats.get("asian_high"), "asian_high", "external"),
        ]
    internal = last_confirmed_5m_level(ctx, one_index, side)
    if internal:
        raw.append(internal)
    result = []
    for price, kind, scope in raw:
        value = finite(price)
        if value is not None and value > 0:
            result.append((value, kind, scope))
    return result


def detect_reclaimed_sweep(ctx: Context, i: int, side: Side) -> Sweep | None:
    if i < 50:
        return None
    candidates: list[tuple[int, Sweep]] = []
    r5 = finite(ctx.bars5.iloc[max(0, int(ctx.completed5[i]))]["r"]) or float(ctx.df.iloc[i]["r1"] or 0)
    if not r5 or not math.isfinite(r5):
        return None
    for level_price, level_type, level_scope in levels_for(ctx, i, side):
        for s in range(max(0, i - 2), i + 1):
            sweep_row = ctx.df.iloc[s]
            current = ctx.df.iloc[i]
            threshold = max(2 * float(sweep_row["spread_usd"]), 0.10 * r5)
            if side == "long":
                penetration = level_price - float(sweep_row["low"])
                reclaimed = float(current["close"]) > level_price
                extreme = float(ctx.df.iloc[s : i + 1]["low"].min())
                expansion = level_price - extreme
            else:
                penetration = float(sweep_row["high"]) - level_price
                reclaimed = float(current["close"]) < level_price
                extreme = float(ctx.df.iloc[s : i + 1]["high"].max())
                expansion = extreme - level_price
            if penetration < threshold or not reclaimed:
                continue
            # A sweep can extend, but not more than 2.5x its initial penetration before reclaim.
            if expansion > max(penetration * 2.5, threshold * 3):
                continue
            quality = (2 if level_scope == "external" else 1) * 10 - (i - s)
            candidates.append((quality, Sweep(
                side=side,
                sweep_index=s,
                reclaim_index=i,
                level_type=level_type,
                level_scope=level_scope,
                level_price=level_price,
                extreme=extreme,
                penetration=expansion,
                penetration_r5=expansion / r5,
                reclaim_bars=i - s + 1,
                spread=float(sweep_row["spread_usd"]),
            )))
    return max(candidates, key=lambda item: item[0])[1] if candidates else None


def latest_structure_pivot(ctx: Context, i: int, side: Side, sweep_index: int) -> int | None:
    flags = ctx.pivot_high_1m if side == "long" else ctx.pivot_low_1m
    latest_confirmed = i - 2
    start = max(2, sweep_index - 15, i - 45)
    if latest_confirmed < start:
        return None
    found = np.flatnonzero(flags[start : latest_confirmed + 1]) + start
    if len(found) == 0:
        return None
    return int(found[-1])


def detect_mss(ctx: Context, i: int, side: Side, sweep: Sweep) -> tuple[int, float, float] | None:
    if i < 3 or i - sweep.sweep_index > 10:
        return None
    pivot = latest_structure_pivot(ctx, i, side, sweep.sweep_index)
    if pivot is None:
        return None
    level = float(ctx.df.iloc[pivot]["high" if side == "long" else "low"])
    previous_close = float(ctx.df.iloc[i - 1]["close"])
    current = ctx.df.iloc[i]
    crossed = previous_close <= level < float(current["close"]) if side == "long" else previous_close >= level > float(current["close"])
    median_body = finite(current["median_body20"]) or 0.0
    displacement = float(current["body"]) / median_body if median_body > 0 else 0.0
    body_ratio = float(current["body_ratio"])
    if not crossed or displacement < 1.5 or body_ratio < 0.60:
        return None
    return pivot, displacement, body_ratio


def find_one_minute_fvg(ctx: Context, i: int, side: Side) -> tuple[float, float, float] | None:
    if i < 2:
        return None
    if side == "long":
        lower = float(ctx.df.iloc[i - 2]["high"])
        upper = float(ctx.df.iloc[i]["low"])
    else:
        lower = float(ctx.df.iloc[i]["high"])
        upper = float(ctx.df.iloc[i - 2]["low"])
    if upper <= lower:
        return None
    r1 = finite(ctx.df.iloc[i]["r1"]) or 0.0
    if r1 <= 0 or upper - lower < 0.15 * r1:
        return None
    return lower, upper, (upper - lower) / r1


def find_order_block(ctx: Context, i: int, side: Side, sweep_index: int) -> tuple[float, float, int] | None:
    start = max(0, sweep_index - 3, i - 10)
    for j in range(i - 1, start - 1, -1):
        row = ctx.df.iloc[j]
        opposite = float(row["close"]) < float(row["open"]) if side == "long" else float(row["close"]) > float(row["open"])
        if opposite:
            return float(row["low"]), float(row["high"]), j
    return None


def touched_recent_5m_fvg(ctx: Context, i: int, side: Side, sweep: Sweep) -> bool:
    k = int(ctx.completed5[sweep.sweep_index])
    if k < 3:
        return False
    sweep_bars = ctx.df.iloc[sweep.sweep_index : sweep.reclaim_index + 1]
    touched_low = float(sweep_bars["low"].min())
    touched_high = float(sweep_bars["high"].max())
    for j in range(k - 1, max(1, k - 25), -1):
        if side == "long":
            lower = float(ctx.bars5.iloc[j - 2]["high"])
            upper = float(ctx.bars5.iloc[j]["low"])
        else:
            lower = float(ctx.bars5.iloc[j]["high"])
            upper = float(ctx.bars5.iloc[j - 2]["low"])
        if upper <= lower:
            continue
        if touched_high >= lower and touched_low <= upper:
            return True
    return False


def model_for(side: Side, bias: str, sweep: Sweep, rebalance: bool) -> Model:
    aligned = (side == "long" and bias == "bullish") or (side == "short" and bias == "bearish")
    opposite = (side == "long" and bias == "bearish") or (side == "short" and bias == "bullish")
    if rebalance and sweep.level_scope == "internal":
        return "FVG_REBALANCE"
    if sweep.level_scope == "external" and opposite:
        return "FAILED_BREAKOUT"
    if sweep.level_scope == "internal" and aligned:
        return "TREND_CONTINUATION"
    return "EXTERNAL_SWEEP_REVERSAL" if sweep.level_scope == "external" else "TREND_CONTINUATION"


def target_liquidity(ctx: Context, i: int, side: Side, entry: float) -> tuple[float | None, str | None]:
    opposite_side: Side = "short" if side == "long" else "long"
    candidates = levels_for(ctx, i, opposite_side)
    prices: list[tuple[float, str]] = []
    for price, kind, _scope in candidates:
        if (side == "long" and price > entry) or (side == "short" and price < entry):
            prices.append((price, kind))
    # Add the last few confirmed 5m opposing pivots, not just the latest one.
    k = int(ctx.completed5[i])
    flags = ctx.pivot_high_5m if side == "long" else ctx.pivot_low_5m
    for j in recent_confirmed(flags, k, 5, lookback=100):
        price = float(ctx.bars5.iloc[j]["high" if side == "long" else "low"])
        if (side == "long" and price > entry) or (side == "short" and price < entry):
            prices.append((price, "5m_target_swing"))
    if not prices:
        return None, None
    prices.sort(key=lambda item: abs(item[0] - entry))
    return prices[0]


def score_setup(
    *, side: Side, bias: str, sweep: Sweep, displacement: float, body_ratio: float,
    has_fvg: bool, overlap: bool, spread: float, spread_p95: float, nearest_rr: float | None,
) -> tuple[dict[str, int], int, str]:
    aligned = (side == "long" and bias == "bullish") or (side == "short" and bias == "bearish")
    environment = 2 if aligned else 1 if bias == "range" else 0
    liquidity = 2 if sweep.level_scope == "external" else 1
    sweep_score = 2 if sweep.reclaim_bars <= 2 and 0.10 <= sweep.penetration_r5 <= 0.75 else 1
    mss = 2 if displacement >= 2.0 and body_ratio >= 0.70 and has_fvg else 1
    ob_fvg = 1 if overlap else 0
    session_spread = 1 if spread <= spread_p95 else 0
    target = 2 if nearest_rr is not None and nearest_rr >= 2.0 else 1 if nearest_rr is not None and nearest_rr >= 1.5 else 0
    scores = {
        "environment": environment,
        "liquidity": liquidity,
        "sweep": sweep_score,
        "mss": mss,
        "ob_fvg": ob_fvg,
        "session_spread": session_spread,
        "target_rr": target,
    }
    total = sum(scores.values())
    grade = "A+" if total >= 11 else "A" if total >= 10 else "B" if total >= 8 else "C"
    return scores, total, grade


def entry_zone(fvg: tuple[float, float, float] | None, ob: tuple[float, float, int] | None) -> tuple[float, float, float] | None:
    if fvg and ob:
        lower = max(fvg[0], ob[0])
        upper = min(fvg[1], ob[1])
        if upper > lower:
            return lower, upper, (lower + upper) / 2
    if fvg:
        return fvg[0], fvg[1], (fvg[0] + fvg[1]) / 2
    if ob:
        return ob[0], ob[1], (ob[0] + ob[1]) / 2
    return None


def find_fill(ctx: Context, signal_i: int, side: Side, zone: tuple[float, float, float], r1: float) -> tuple[int, float, int] | None:
    lower, upper, midpoint = zone
    buffer = max(float(ctx.df.iloc[signal_i]["spread_usd"]), 0.05 * r1)
    touches = 0
    for j in range(signal_i + 1, min(len(ctx.df), signal_i + 1 + MAX_ENTRY_WAIT_BARS)):
        if (ctx.df.iloc[j]["datetime"] - ctx.df.iloc[j - 1]["datetime"]).total_seconds() > 60:
            return None
        row = ctx.df.iloc[j]
        touched = float(row["high"]) >= lower and float(row["low"]) <= upper
        if touched:
            touches += 1
        conservative_fill = float(row["low"]) <= midpoint - buffer if side == "long" else float(row["high"]) >= midpoint + buffer
        if touched and conservative_fill:
            return j, midpoint, touches
    return None


def simulate(
    ctx: Context, entry_i: int, side: Side, entry_mid: float, stop_mid: float,
    tp1: float, tp2: float, runner: float,
) -> dict[str, Any]:
    direction = 1.0 if side == "long" else -1.0
    if (side == "long" and stop_mid >= entry_mid) or (side == "short" and stop_mid <= entry_mid):
        raise ValueError(f"invalid stop side for {side}: entry={entry_mid}, stop={stop_mid}")
    risk_mid = abs(entry_mid - stop_mid)
    entry_spread = float(ctx.df.iloc[entry_i]["spread_usd"])
    entry_slip = entry_mid * SLIPPAGE_BPS_PER_FILL / 10_000
    entry_exec = entry_mid + direction * (entry_spread / 2 + entry_slip)
    quantities = [0.30, 0.40, 0.30]
    targets = [tp1, tp2, runner]
    open_qty = 1.0
    gross_r = 0.0
    net_pnl = 0.0
    target_hit = [False, False, False]
    mfe = 0.0
    mae = 0.0
    exit_i = entry_i
    exit_reason = "timeout"
    first_one_r_i: int | None = None
    first_half_adverse_i: int | None = None

    def exit_exec(mid: float, j: int) -> float:
        spread = float(ctx.df.iloc[j]["spread_usd"])
        slip = mid * SLIPPAGE_BPS_PER_FILL / 10_000
        return mid - direction * (spread / 2 + slip)

    max_j = min(len(ctx.df) - 1, entry_i + MAX_HOLD_BARS)
    for j in range(entry_i, max_j + 1):
        row = ctx.df.iloc[j]
        if j > entry_i and (row["datetime"] - ctx.df.iloc[j - 1]["datetime"]).total_seconds() > 60:
            exit_reason = "data_gap"
            max_j = j - 1
            break
        favorable = (float(row["high"]) - entry_mid) * direction if side == "long" else (entry_mid - float(row["low"]))
        adverse = (entry_mid - float(row["low"])) if side == "long" else (float(row["high"]) - entry_mid)
        mfe = max(mfe, favorable / risk_mid)
        mae = max(mae, adverse / risk_mid)
        if first_one_r_i is None and favorable >= risk_mid:
            first_one_r_i = j
        if first_half_adverse_i is None and adverse >= 0.5 * risk_mid:
            first_half_adverse_i = j

        stop_hit = float(row["low"]) <= stop_mid if side == "long" else float(row["high"]) >= stop_mid
        # Conservative same-bar ordering: stop precedes every target.
        if stop_hit and open_qty > 0:
            gross_r -= open_qty
            net_pnl += open_qty * (exit_exec(stop_mid, j) - entry_exec) * direction
            open_qty = 0.0
            exit_i = j
            exit_reason = "stop"
            break
        for target_index, target in enumerate(targets):
            if target_hit[target_index]:
                continue
            hit = float(row["high"]) >= target if side == "long" else float(row["low"]) <= target
            if hit:
                qty = min(quantities[target_index], open_qty)
                target_r = abs(target - entry_mid) / risk_mid
                gross_r += qty * target_r
                net_pnl += qty * (exit_exec(target, j) - entry_exec) * direction
                open_qty -= qty
                target_hit[target_index] = True
                exit_i = j
                exit_reason = f"tp{target_index + 1}" if open_qty > 1e-9 else "runner_target"
        if open_qty <= 1e-9:
            break
    if open_qty > 1e-9:
        j = max(entry_i, min(max_j, len(ctx.df) - 1))
        close_mid = float(ctx.df.iloc[j]["close"])
        close_r = (close_mid - entry_mid) * direction / risk_mid
        gross_r += open_qty * close_r
        net_pnl += open_qty * (exit_exec(close_mid, j) - entry_exec) * direction
        exit_i = j
        if exit_reason != "data_gap":
            exit_reason = "timeout"
    net_r = net_pnl / risk_mid
    false_mss = first_half_adverse_i is not None and (first_one_r_i is None or first_half_adverse_i <= first_one_r_i)
    return {
        "entry_exec": entry_exec,
        "exit_i": exit_i,
        "exit_reason": exit_reason,
        "gross_r": gross_r,
        "net_r": net_r,
        "cost_r": gross_r - net_r,
        "mfe_r": mfe,
        "mae_r": mae,
        "false_mss": false_mss,
        "targets_hit": target_hit,
    }


def evaluate_candidate(ctx: Context, i: int, side: Side, sweep: Sweep, candidate_number: int) -> Setup:
    row = ctx.df.iloc[i]
    mss = detect_mss(ctx, i, side, sweep)
    assert mss is not None
    pivot_i, displacement, body_ratio = mss
    bias, regime = bias_and_regime(ctx, i)
    session = session_name(row) or "outside"
    fvg = find_one_minute_fvg(ctx, i, side)
    ob = find_order_block(ctx, i, side, sweep.sweep_index)
    overlap = bool(fvg and ob and min(fvg[1], ob[1]) > max(fvg[0], ob[0]))
    rebalance = touched_recent_5m_fvg(ctx, i, side, sweep)
    model = model_for(side, bias, sweep, rebalance)
    zone = entry_zone(fvg, ob)
    r1 = finite(row["r1"]) or 0.0
    k5 = max(0, int(ctx.completed5[i]))
    r5 = finite(ctx.bars5.iloc[k5]["r"]) or 0.0
    reasons: list[str] = []
    status: Status = "REJECTED"
    entry_mid = zone[2] if zone else None
    stop_mid = None
    stop_distance = None
    stop_distance_r5 = None
    target_price = None
    target_kind = None
    nearest_rr = None
    if zone is None:
        reasons.append("NO_OB_OR_FVG_ENTRY_ZONE")
    if entry_mid is not None and r1 > 0:
        buffer = max(2 * float(row["spread_usd"]), 0.25 * r1)
        stop_mid = sweep.extreme - buffer if side == "long" else sweep.extreme + buffer
        stop_distance = abs(entry_mid - stop_mid)
        stop_distance_r5 = stop_distance / r5 if r5 > 0 else None
        stop_on_invalid_side = (side == "long" and stop_mid >= entry_mid) or (side == "short" and stop_mid <= entry_mid)
        if stop_distance <= 0 or stop_on_invalid_side:
            reasons.append("INVALID_STRUCTURE_STOP_SIDE")
        elif stop_distance_r5 is None or stop_distance_r5 < 0.60 or stop_distance_r5 > 2.00:
            reasons.append("STOP_DISTANCE_OUTSIDE_0_60_TO_2_00_R5")
        target_price, target_kind = target_liquidity(ctx, i, side, entry_mid)
        if target_price is not None and stop_distance > 0:
            nearest_rr = abs(target_price - entry_mid) / stop_distance
        if nearest_rr is None or nearest_rr < 1.5:
            reasons.append("NEAREST_LIQUIDITY_BELOW_1_5R")
    if session == "outside":
        reasons.append("OUTSIDE_LONDON_NEW_YORK_SESSION")
    if float(row["spread_usd"]) > ctx.global_spread_p95:
        reasons.append("ABNORMAL_SPREAD_ABOVE_GLOBAL_P95")

    scores, total, grade = score_setup(
        side=side,
        bias=bias,
        sweep=sweep,
        displacement=displacement,
        body_ratio=body_ratio,
        has_fvg=fvg is not None,
        overlap=overlap,
        spread=float(row["spread_usd"]),
        spread_p95=ctx.global_spread_p95,
        nearest_rr=nearest_rr,
    )
    setup_id = hashlib.sha256(
        f"xau-300-v1|{int(row['datetime'].timestamp())}|{side}|{sweep.sweep_index}|{sweep.level_type}|{sweep.level_price:.5f}".encode()
    ).hexdigest()[:20]
    result = Setup(
        sample_id=setup_id,
        source_candidate_number=candidate_number,
        split="UNASSIGNED",
        timestamp_utc=iso(row["datetime"]) or "",
        timestamp_new_york=pd.Timestamp(row["ny_time"]).isoformat(),
        date_new_york=str(row["ny_date"]),
        weekday_new_york=str(row["ny_weekday"]),
        session=session,
        model=model,
        direction=side,
        status=status,
        rejection_reasons=reasons,
        data_source="Andri-Supriadi/xauusd-m1-layering 0000.parquet midpoint proxy",
        bias_15m=bias,
        regime_15m=regime,
        liquidity_type=sweep.level_type,
        liquidity_scope=sweep.level_scope,
        liquidity_price=sweep.level_price,
        sweep_time_utc=iso(ctx.df.iloc[sweep.sweep_index]["datetime"]) or "",
        sweep_penetration_usd=sweep.penetration,
        sweep_penetration_r5=sweep.penetration_r5,
        sweep_reclaim_bars=sweep.reclaim_bars,
        mss_pivot_price=float(ctx.df.iloc[pivot_i]["high" if side == "long" else "low"]),
        mss_displacement_multiple=displacement,
        mss_body_ratio=body_ratio,
        mss_has_fvg=fvg is not None,
        fvg_lower=fvg[0] if fvg else None,
        fvg_upper=fvg[1] if fvg else None,
        fvg_size_r1=fvg[2] if fvg else None,
        order_block_lower=ob[0] if ob else None,
        order_block_upper=ob[1] if ob else None,
        ob_fvg_overlap=overlap,
        five_minute_fvg_rebalance=rebalance,
        entry_mid=entry_mid,
        stop_mid=stop_mid,
        stop_distance_usd=stop_distance,
        stop_distance_r5=stop_distance_r5,
        nearest_liquidity_target=target_price,
        nearest_liquidity_rr=nearest_rr,
        spread_at_signal_usd=float(row["spread_usd"]),
        score_environment=scores["environment"],
        score_liquidity=scores["liquidity"],
        score_sweep=scores["sweep"],
        score_mss=scores["mss"],
        score_ob_fvg=scores["ob_fvg"],
        score_session_spread=scores["session_spread"],
        score_target_rr=scores["target_rr"],
        total_score=total,
        grade=grade,
        notes=f"nearest_target={target_kind or 'none'}; same-bar stop/target ordering=stop-first; no news calendar available",
    )
    if reasons or zone is None or entry_mid is None or stop_mid is None or stop_distance is None:
        return result
    fill = find_fill(ctx, i, side, zone, r1)
    if fill is None:
        result.status = "VALID_UNFILLED"
        return result
    entry_i, entry_mid, retest_number = fill
    result.status = "EXECUTED"
    result.retest_number = retest_number
    result.entry_time_utc = iso(ctx.df.iloc[entry_i]["datetime"])
    result.entry_mid = entry_mid
    result.spread_at_entry_usd = float(ctx.df.iloc[entry_i]["spread_usd"])
    direction = 1 if side == "long" else -1
    risk = abs(entry_mid - stop_mid)
    # Frozen non-optimized management: 30% at 1R, 40% at min(2R, nearest liquidity), 30% at 2.5R-4R or next liquidity.
    tp1 = entry_mid + direction * risk
    tp2_r = max(1.5, min(2.0, nearest_rr or 2.0))
    runner_r = max(2.5, min(4.0, nearest_rr or 2.5))
    tp2 = entry_mid + direction * risk * tp2_r
    runner = entry_mid + direction * risk * runner_r
    result.tp1_mid = tp1
    result.tp2_mid = tp2
    result.runner_target_mid = runner
    simulation = simulate(ctx, entry_i, side, entry_mid, stop_mid, tp1, tp2, runner)
    result.entry_executed = simulation["entry_exec"]
    result.exit_time_utc = iso(ctx.df.iloc[simulation["exit_i"]]["datetime"])
    result.exit_reason = simulation["exit_reason"]
    result.gross_r = simulation["gross_r"]
    result.net_r = simulation["net_r"]
    result.cost_r = simulation["cost_r"]
    result.mfe_r = simulation["mfe_r"]
    result.mae_r = simulation["mae_r"]
    result.false_mss = simulation["false_mss"]
    if simulation["exit_reason"] == "data_gap":
        result.status = "AMBIGUOUS"
        result.rejection_reasons.append("DATA_GAP_DURING_TRADE")
    return result


def vectorized_sweep_events(ctx: Context) -> list[Sweep]:
    """Find reclaimed sweeps with NumPy first; expensive structure logic runs only on matches."""
    df = ctx.df
    n = len(df)
    completed5 = np.clip(ctx.completed5, 0, len(ctx.bars5) - 1)
    r5 = ctx.bars5["r"].to_numpy(dtype=float)[completed5]
    spread = df["spread_usd"].to_numpy(dtype=float)
    high = df["high"].to_numpy(dtype=float)
    low = df["low"].to_numpy(dtype=float)
    close = df["close"].to_numpy(dtype=float)
    times = df["datetime"].astype("int64").to_numpy() // 1_000_000_000
    minute = df["ny_minute"].to_numpy(dtype=int)
    weekday = df["ny_weekday"].to_numpy(dtype=str)
    in_session = (
        ~np.isin(weekday, ["Sat", "Sun"])
        & (((minute >= 120) & (minute < 300)) | ((minute >= 420) & (minute < 660)))
    )

    # Map daily external levels to every one-minute bar.
    dates = df["ny_date"].astype(str)
    external_arrays: dict[str, np.ndarray] = {}
    for key in ["previous_day_high", "previous_day_low", "asian_high", "asian_low"]:
        mapping = {date: values.get(key, math.nan) for date, values in ctx.date_stats.items()}
        external_arrays[key] = dates.map(mapping).to_numpy(dtype=float)

    # Latest usable 5m pivot at each completed 5m bar. A pivot j is first usable at k=j+2.
    last_high = np.full(len(ctx.bars5), np.nan)
    last_low = np.full(len(ctx.bars5), np.nan)
    high_kind = np.full(len(ctx.bars5), "5m_swing_high", dtype=object)
    low_kind = np.full(len(ctx.bars5), "5m_swing_low", dtype=object)
    current_high = current_low = math.nan
    previous_high = previous_low = math.nan
    current_high_kind = "5m_swing_high"
    current_low_kind = "5m_swing_low"
    h5 = ctx.bars5["high"].to_numpy(dtype=float)
    l5 = ctx.bars5["low"].to_numpy(dtype=float)
    r5bar = ctx.bars5["r"].to_numpy(dtype=float)
    for k in range(len(ctx.bars5)):
        j = k - 2
        if j >= 0 and ctx.pivot_high_5m[j]:
            previous_high, current_high = current_high, h5[j]
            tolerance = 0.15 * r5bar[k] if math.isfinite(r5bar[k]) else 0.0
            current_high_kind = "equal_highs" if math.isfinite(previous_high) and abs(current_high - previous_high) <= tolerance else "5m_swing_high"
        if j >= 0 and ctx.pivot_low_5m[j]:
            previous_low, current_low = current_low, l5[j]
            tolerance = 0.15 * r5bar[k] if math.isfinite(r5bar[k]) else 0.0
            current_low_kind = "equal_lows" if math.isfinite(previous_low) and abs(current_low - previous_low) <= tolerance else "5m_swing_low"
        last_high[k] = current_high
        last_low[k] = current_low
        high_kind[k] = current_high_kind
        low_kind[k] = current_low_kind
    internal_high = last_high[completed5]
    internal_low = last_low[completed5]
    internal_high_kind = high_kind[completed5]
    internal_low_kind = low_kind[completed5]

    level_specs: dict[Side, list[tuple[np.ndarray, str | np.ndarray, str, int]]] = {
        "long": [
            (external_arrays["previous_day_low"], "previous_day_low", "external", 30),
            (external_arrays["asian_low"], "asian_low", "external", 28),
            (internal_low, internal_low_kind, "internal", 15),
        ],
        "short": [
            (external_arrays["previous_day_high"], "previous_day_high", "external", 30),
            (external_arrays["asian_high"], "asian_high", "external", 28),
            (internal_high, internal_high_kind, "internal", 15),
        ],
    }
    best_by_reclaim: dict[tuple[int, Side], tuple[int, Sweep]] = {}
    for side, specs in level_specs.items():
        for level_values, kind_values, scope, base_quality in specs:
            for delay in range(3):
                length = n - delay
                if length <= 0:
                    continue
                s_idx = np.arange(length)
                i_idx = s_idx + delay
                levels = level_values[s_idx]
                extremes = low[s_idx].copy() if side == "long" else high[s_idx].copy()
                for offset in range(1, delay + 1):
                    extremes = np.minimum(extremes, low[s_idx + offset]) if side == "long" else np.maximum(extremes, high[s_idx + offset])
                penetration = levels - extremes if side == "long" else extremes - levels
                reclaimed = close[i_idx] > levels if side == "long" else close[i_idx] < levels
                threshold = np.maximum(2 * spread[s_idx], 0.10 * r5[s_idx])
                contiguous = times[i_idx] - times[s_idx] == delay * 60
                mask = (
                    np.isfinite(levels)
                    & np.isfinite(r5[s_idx])
                    & (r5[s_idx] > 0)
                    & (penetration >= threshold)
                    & (penetration <= 2.5 * r5[s_idx])
                    & reclaimed
                    & contiguous
                    & in_session[i_idx]
                )
                for pos in np.flatnonzero(mask):
                    s_i = int(s_idx[pos])
                    reclaim_i = int(i_idx[pos])
                    kind = str(kind_values[s_i]) if isinstance(kind_values, np.ndarray) else kind_values
                    quality = base_quality - delay
                    sweep = Sweep(
                        side=side,
                        sweep_index=s_i,
                        reclaim_index=reclaim_i,
                        level_type=kind,
                        level_scope=scope,
                        level_price=float(levels[pos]),
                        extreme=float(extremes[pos]),
                        penetration=float(penetration[pos]),
                        penetration_r5=float(penetration[pos] / r5[s_i]),
                        reclaim_bars=delay + 1,
                        spread=float(spread[s_i]),
                    )
                    key = (reclaim_i, side)
                    existing = best_by_reclaim.get(key)
                    if existing is None or quality > existing[0]:
                        best_by_reclaim[key] = (quality, sweep)
    # The same broken level can be observed as reclaimed on more than one minute. Keep earliest reclaim.
    dedup: dict[tuple[int, Side, str, int], Sweep] = {}
    for (_reclaim_i, side), (_quality, sweep) in sorted(best_by_reclaim.items()):
        key = (sweep.sweep_index, side, sweep.level_scope, round(sweep.level_price * 10))
        if key not in dedup or sweep.reclaim_index < dedup[key].reclaim_index:
            dedup[key] = sweep
    return sorted(dedup.values(), key=lambda item: (item.reclaim_index, item.sweep_index, item.side))


def collect_candidates(ctx: Context) -> list[Setup]:
    sweep_events = vectorized_sweep_events(ctx)
    print(f"Vectorized sweep pass found {len(sweep_events):,} independent reclaimed sweeps.", flush=True)
    candidates_with_index: list[tuple[int, Setup]] = []
    used_sweeps: set[tuple[int, Side]] = set()
    for sweep in sweep_events:
        key = (sweep.sweep_index, sweep.side)
        if key in used_sweeps:
            continue
        last = min(len(ctx.df) - 1, sweep.sweep_index + 10)
        for i in range(sweep.reclaim_index, last + 1):
            if session_name(ctx.df.iloc[i]) is None:
                break
            if detect_mss(ctx, i, sweep.side, sweep) is None:
                continue
            setup = evaluate_candidate(ctx, i, sweep.side, sweep, 0)
            candidates_with_index.append((i, setup))
            used_sweeps.add(key)
            break
    candidates_with_index.sort(key=lambda item: (item[0], item[1].direction, item[1].sample_id))
    candidates = [item[1] for item in candidates_with_index]
    for number, setup in enumerate(candidates, start=1):
        setup.source_candidate_number = number
    return candidates


def systematic_sample(candidates: list[Setup], count: int) -> list[Setup]:
    if len(candidates) < count:
        raise RuntimeError(f"Only {len(candidates)} independent candidates were found; requested {count}.")
    # Fixed, PnL/grade-blind systematic sampling across the supplied chronological stream.
    positions = np.linspace(0, len(candidates) - 1, num=count)
    selected_indices: list[int] = []
    used: set[int] = set()
    for position in positions:
        index = int(round(float(position)))
        while index in used and index + 1 < len(candidates):
            index += 1
        if index in used:
            index = max(i for i in range(len(candidates)) if i not in used)
        used.add(index)
        selected_indices.append(index)
    selected = [candidates[i] for i in sorted(selected_indices)]
    development_end = int(round(count * 0.60))
    validation_end = development_end + int(round(count * 0.20))
    for index, setup in enumerate(selected):
        setup.split = "development" if index < development_end else "validation" if index < validation_end else "out_of_sample"
    return selected


def safe_mean(values: Iterable[float | None]) -> float | None:
    clean = [float(v) for v in values if v is not None and math.isfinite(float(v))]
    return float(np.mean(clean)) if clean else None


def metrics(rows: list[Setup]) -> dict[str, Any]:
    executed = [row for row in rows if row.status == "EXECUTED" and row.net_r is not None]
    nets = np.array([float(row.net_r) for row in executed], dtype=float)
    gross = np.array([float(row.gross_r) for row in executed if row.gross_r is not None], dtype=float)
    profits = nets[nets > 0].sum() if len(nets) else 0.0
    losses = -nets[nets < 0].sum() if len(nets) else 0.0
    winners = nets[nets > 0]
    losers = nets[nets < 0]
    average_win = float(winners.mean()) if len(winners) else None
    average_loss_abs = float(-losers.mean()) if len(losers) else None
    cumulative = np.cumsum(nets) if len(nets) else np.array([], dtype=float)
    running_peak = np.maximum.accumulate(np.concatenate(([0.0], cumulative))) if len(nets) else np.array([], dtype=float)
    drawdowns = running_peak[1:] - cumulative if len(nets) else np.array([], dtype=float)

    def longest_streak(want_win: bool) -> int:
        longest = current = 0
        for value in nets:
            matches = value > 0 if want_win else value <= 0
            current = current + 1 if matches else 0
            longest = max(longest, current)
        return longest

    return {
        "candidateCount": len(rows),
        "rejectedCount": sum(row.status == "REJECTED" for row in rows),
        "validUnfilledCount": sum(row.status == "VALID_UNFILLED" for row in rows),
        "executedCount": len(executed),
        "ambiguousCount": sum(row.status == "AMBIGUOUS" for row in rows),
        "fillRateOfNonRejected": len(executed) / max(1, len(executed) + sum(row.status == "VALID_UNFILLED" for row in rows)),
        "winRate": float((nets > 0).mean()) if len(nets) else None,
        "meanGrossR": float(gross.mean()) if len(gross) else None,
        "meanNetR": float(nets.mean()) if len(nets) else None,
        "medianNetR": float(np.median(nets)) if len(nets) else None,
        "netR25thPercentile": float(np.quantile(nets, 0.25)) if len(nets) else None,
        "netR75thPercentile": float(np.quantile(nets, 0.75)) if len(nets) else None,
        "profitFactor": float(profits / losses) if losses > 0 else (math.inf if profits > 0 else None),
        "totalNetR": float(nets.sum()) if len(nets) else None,
        "averageWinR": average_win,
        "averageLossRAbs": average_loss_abs,
        "payoffRatio": average_win / average_loss_abs if average_win is not None and average_loss_abs else None,
        "breakEvenWinRate": average_loss_abs / (average_win + average_loss_abs) if average_win is not None and average_loss_abs else None,
        "maximumDrawdownR": float(drawdowns.max()) if len(drawdowns) else None,
        "longestWinningStreak": longest_streak(True),
        "longestNonWinningStreak": longest_streak(False),
        "meanCostR": safe_mean(row.cost_r for row in executed),
        "meanMfeR": safe_mean(row.mfe_r for row in executed),
        "meanMaeR": safe_mean(row.mae_r for row in executed),
        "falseMssRate": safe_mean(1.0 if row.false_mss else 0.0 for row in executed if row.false_mss is not None),
        "largestWinnerR": float(nets.max()) if len(nets) else None,
        "largestLoserR": float(nets.min()) if len(nets) else None,
        "largestWinnerShareOfPositiveR": float(nets.max() / profits) if len(nets) and profits > 0 else None,
    }


def bootstrap_mean_ci(rows: list[Setup], seed: int = 20260716, iterations: int = 5000) -> list[float] | None:
    values = [float(row.net_r) for row in rows if row.status == "EXECUTED" and row.net_r is not None]
    if len(values) < 2:
        return None
    rng = random.Random(seed)
    means = []
    for _ in range(iterations):
        means.append(sum(rng.choice(values) for _ in values) / len(values))
    means.sort()
    return [means[int(0.025 * (iterations - 1))], means[int(0.975 * (iterations - 1))]]


def group_metrics(rows: list[Setup], fields: list[str], grade_a_only: bool = False) -> list[dict[str, Any]]:
    groups: dict[tuple[Any, ...], list[Setup]] = defaultdict(list)
    for row in rows:
        if grade_a_only and row.grade not in {"A", "A+"}:
            continue
        groups[tuple(getattr(row, field) for field in fields)].append(row)
    result = []
    for key, group in groups.items():
        item = {field: value for field, value in zip(fields, key)}
        item.update(metrics(group))
        item["bootstrap95MeanNetR"] = bootstrap_mean_ci(group)
        result.append(item)
    return sorted(result, key=lambda item: (item.get("meanNetR") is not None, item.get("meanNetR") or -999), reverse=True)


def qualifying_grade_a_models(rows: list[Setup]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    models = group_metrics(rows, ["model"], grade_a_only=True)
    qualified = []
    for item in models:
        group = [row for row in rows if row.grade in {"A", "A+"} and row.model == item["model"]]
        split = {name: metrics([row for row in group if row.split == name]) for name in ["development", "validation", "out_of_sample"]}
        item["splitMetrics"] = split
        means = [split[name]["meanNetR"] for name in split]
        counts = [split[name]["executedCount"] for name in split]
        item["qualificationChecks"] = {
            "executedAtLeast20": (item["executedCount"] or 0) >= 20,
            "validationAndOosAtLeast5Each": counts[1] >= 5 and counts[2] >= 5,
            "overallPositiveExpectancy": item["meanNetR"] is not None and item["meanNetR"] > 0,
            "profitFactorAbove1": item["profitFactor"] is not None and item["profitFactor"] > 1,
            "allChronologicalSplitsPositive": all(value is not None and value > 0 for value in means),
            "largestWinnerBelow35PctPositiveR": item["largestWinnerShareOfPositiveR"] is not None and item["largestWinnerShareOfPositiveR"] <= 0.35,
        }
        if all(item["qualificationChecks"].values()):
            qualified.append(item)
    return models, qualified


def qualifying_executed_models(rows: list[Setup]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Audit the four base models independently of the setup-quality grade.

    This is intentionally a separate result from the A/A+ qualification. It helps distinguish
    "the base model itself is negative" from "the A-grade subset is too sparse to evaluate".
    """
    models = group_metrics(rows, ["model"])
    qualified: list[dict[str, Any]] = []
    for item in models:
        group = [row for row in rows if row.model == item["model"]]
        split = {name: metrics([row for row in group if row.split == name]) for name in ["development", "validation", "out_of_sample"]}
        item["splitMetrics"] = split
        means = [split[name]["meanNetR"] for name in split]
        counts = [split[name]["executedCount"] for name in split]
        ci = item.get("bootstrap95MeanNetR")
        item["qualificationChecks"] = {
            "executedAtLeast40": (item["executedCount"] or 0) >= 40,
            "validationAndOosAtLeast8Each": counts[1] >= 8 and counts[2] >= 8,
            "overallPositiveExpectancy": item["meanNetR"] is not None and item["meanNetR"] > 0,
            "profitFactorAbove1": item["profitFactor"] is not None and item["profitFactor"] > 1,
            "allChronologicalSplitsPositive": all(value is not None and value > 0 for value in means),
            "bootstrapLowerBoundAboveZero": isinstance(ci, list) and len(ci) == 2 and ci[0] > 0,
            "largestWinnerBelow35PctPositiveR": item["largestWinnerShareOfPositiveR"] is not None and item["largestWinnerShareOfPositiveR"] <= 0.35,
        }
        if all(item["qualificationChecks"].values()):
            qualified.append(item)
    return models, qualified


def json_clean(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: json_clean(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_clean(item) for item in value]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        value = float(value)
    if isinstance(value, float) and not math.isfinite(value):
        return "Infinity" if value > 0 else "-Infinity" if value < 0 else None
    return value


def pct(value: Any) -> str:
    return "—" if value is None else f"{float(value) * 100:.2f}%"


def num(value: Any, places: int = 3) -> str:
    if value is None:
        return "—"
    if value == "Infinity" or value == math.inf:
        return "∞"
    return f"{float(value):.{places}f}"


def markdown_table(items: list[dict[str, Any]], key: str) -> str:
    lines = ["| 分组 | 候选 | 执行 | 胜率 | 平均净R | 中位净R | PF | 平均成本R | False MSS |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for item in items:
        lines.append(
            f"| {item.get(key)} | {item['candidateCount']} | {item['executedCount']} | {pct(item['winRate'])} | {num(item['meanNetR'])} | {num(item['medianNetR'])} | {num(item['profitFactor'])} | {num(item['meanCostR'])} | {pct(item['falseMssRate'])} |"
        )
    return "\n".join(lines)


def render_report(payload: dict[str, Any], selected: list[Setup]) -> str:
    overall = payload["statistics"]["overall"]
    grade_a = payload["statistics"]["gradeA"]
    model_items = payload["statistics"]["gradeAByModel"]
    qualified = payload["conclusion"]["qualifiedGradeAModels"]
    if qualified:
        conclusion = "通过预注册稳健性门槛的 A 级正期望模型为：" + "、".join(item["model"] for item in qualified) + "。"
    else:
        conclusion = "没有任何 A 级模型同时通过样本量、总体验证、Validation、OOS 与离群值控制门槛；本轮不能宣布存在可直接实盘的 A 级正期望模型。"
    split_rows = payload["statistics"]["gradeABySplit"]
    status_counts = pd.Series([row.status for row in selected]).value_counts().to_dict()
    top_rejections = payload["candidateAudit"]["topRejectionReasons"]
    base_qualified = payload["conclusion"]["qualifiedBaseModels"]
    return f"""# XAU SMC + ICT 300 个欧美盘 Setup 历史研究

## 结论

**{conclusion}**

这是一项历史图表价格代理研究，不是实盘收益承诺。A级是规则质量评分，不代表天然盈利；正期望必须由成交后净 R、成本、时间外样本共同确认。

## 数据与方法

- 品种：XAUUSD（不是交易所统一撮合的 XAUUSDT）。
- 数据：`Andri-Supriadi/xauusd-m1-layering` 的 1 分钟 OTC/CFD 中间价代理；区间 {payload['source']['from']} 至 {payload['source']['through']}。
- 原始有效 1m 行数：{payload['source']['rows']}；中位点差约 ${payload['source']['medianSpreadUsd']:.3f}。
- 时段：纽约时间 London 02:00–05:00、New York 07:00–11:00，周末不采集。
- 样本漏斗：先扫描全部 {payload['sampling']['independentCandidatesFound']} 个独立候选，其中规则有效且实际回踩成交 {payload['sampling']['executedSetupsFound']} 个；再按固定等距位置从完整成交 Setup 时间流中系统抽取 300 个。
- 抽样不使用盈亏、评分或模型标签；只以“满足冻结规则并在 8 根 1m 内实际回踩成交”定义交易总体，避免把被否决或未成交信号混入收益统计。
- 时间切分：Development 180、Validation 60、Out-of-sample 60；不随机打乱。
- 成本：从中间价对称构造 Bid/Ask，并对每次成交增加 {SLIPPAGE_BPS_PER_FILL:.1f} bps 不利滑点；同一 1m 同时触及止损和目标时按止损优先。
- 退出：30% 在 1R，40% 在不高于 2R 的下一流动性目标，30% Runner 在 2.5R–4R；不自动移动保本，最长持有 180 分钟。
- 新闻过滤：没有可靠历史新闻日历，因此只用异常点差否决；这是研究限制，而不是把新闻风险视为不存在。

## 300 个已成交 Setup 总览

- 状态：{json.dumps(status_counts, ensure_ascii=False)}
- 执行交易：{overall['executedCount']}；胜率 {pct(overall['winRate'])}；平均净 R {num(overall['meanNetR'])}；PF {num(overall['profitFactor'])}。
- 平均毛 R {num(overall['meanGrossR'])}，平均成本拖累 {num(overall['meanCostR'])}R；bootstrap 平均净 R 95% 区间 {payload['statistics']['overallBootstrap95MeanNetR']}。
- 平均盈利 {num(overall['averageWinR'])}R，平均亏损绝对值 {num(overall['averageLossRAbs'])}R，盈亏比 {num(overall['payoffRatio'])}；按实际盈亏分布计算的盈亏平衡胜率为 {pct(overall['breakEvenWinRate'])}。
- 实际胜率仅 {pct(overall['winRate'])}，最大累计回撤 {num(overall['maximumDrawdownR'])}R，最长连续非盈利 {overall['longestNonWinningStreak']} 笔。
- False MSS 率 {pct(overall['falseMssRate'])}；平均 MFE {num(overall['meanMfeR'])}R、平均 MAE {num(overall['meanMaeR'])}R。
- A/A+ 候选：{grade_a['candidateCount']}；其中执行 {grade_a['executedCount']}；胜率 {pct(grade_a['winRate'])}；平均净 R {num(grade_a['meanNetR'])}；PF {num(grade_a['profitFactor'])}。
- A/A+ 平均毛 R {num(grade_a['meanGrossR'])}，平均成本 {num(grade_a['meanCostR'])}R，成本后平均净 R {num(grade_a['meanNetR'])}。
- A/A+ 平均 MFE {num(grade_a['meanMfeR'])}R，平均 MAE {num(grade_a['meanMaeR'])}R，False MSS 率 {pct(grade_a['falseMssRate'])}。
- A/A+ 平均净 R bootstrap 95% 区间：{payload['statistics']['gradeABootstrap95MeanNetR']}。

## 全部候选漏斗

- 全部独立候选：{payload['candidateAudit']['candidateCount']}。
- 被规则否决：{payload['candidateAudit']['rejectedCount']}。
- 规则有效但未在等待窗口成交：{payload['candidateAudit']['validUnfilledCount']}。
- 实际成交：{payload['candidateAudit']['executedCount']}。
- 数据歧义：{payload['candidateAudit']['ambiguousCount']}。
- 有效交易日：{payload['candidateAudit']['eligibleTradingDays']}；全部候选约 {num(payload['candidateAudit']['candidateSignalsPerEligibleDay'])} 个/日，规则有效信号约 {num(payload['candidateAudit']['validSignalsPerEligibleDay'])} 个/日，实际成交约 {num(payload['candidateAudit']['executedSetupsPerEligibleDay'])} 个/日。
- 产生至少一笔实际成交的日期：{payload['candidateAudit']['daysWithAtLeastOneExecutedSetup']}。当前冻结规则明显达不到“日均 5 笔成交 Setup”的频率目标。

## A级模型比较

{markdown_table(model_items, 'model')}

## A级时间外一致性

{markdown_table(split_rows, 'split')}

## 四类基础模型稳健性审计（不等同于A级）

{markdown_table(payload['statistics']['baseModelRobustness'], 'model')}

通过基础模型稳健性门槛：{json.dumps([item['model'] for item in base_qualified], ensure_ascii=False)}。基础模型只有在样本数、三段正期望、PF、bootstrap 下界及离群值控制全部通过时才视为稳健；通过基础模型不自动等同于“A级交易模型”。

## 主要否决原因

""" + "\n".join(f"- {item['reason']}: {item['count']}" for item in top_rejections) + """

## 正期望判定门槛

一个模型只有同时满足以下条件才列为“通过”：

1. A/A+ 已执行样本至少 20；
2. Validation 与 OOS 各至少 5 个已执行样本；
3. 全部 A 级样本平均净 R > 0 且 PF > 1；
4. Development、Validation、OOS 三段平均净 R 都 > 0；
5. 最大单笔赢家不超过全部正 R 的 35%。

未通过不等于模型永久无效，可能是负期望，也可能是A级成交样本不足；两者在 JSON 的 `qualificationChecks` 中分开记录。

## 当前可用结论

- 若 `qualifiedGradeAModels` 为空：不要把开发集内表现最好的组合直接提升为实盘A级模型。
- 可把平均净R为正但未通过样本门槛的模型视为探索候选，只能进入新增样本或 forward/shadow 验证。
- 下一轮优先补齐 A 级稀缺模型和 Validation/OOS 样本，而不是继续调整规则去迎合这 300 个结果。

## 文件

- `research-ict-xau-300-setups.csv`：300 行已成交 Setup 复盘数据库。
- `research-ict-xau-300-setups.json`：完整规则、统计、分组与资格判定。
- `scripts/research-ict-xau-300-setups.py`：可复现采集与分析脚本。
"""


def main() -> None:
    args = parse_args()
    source_path = Path(args.parquet)
    print(f"Loading {source_path}...", flush=True)
    df, source = load_source(source_path)
    print(f"Loaded {len(df):,} one-minute rows; building 5m/15m context...", flush=True)
    ctx = make_context(df)
    print("Scanning London/New York candidate stream with frozen rule/fill evaluation...", flush=True)
    all_candidates = collect_candidates(ctx)
    executed_candidates = [row for row in all_candidates if row.status == "EXECUTED"]
    print(
        f"Found {len(all_candidates):,} independent candidates and {len(executed_candidates):,} executed setups; "
        f"selecting {args.samples} systematically without using PnL/grade...",
        flush=True,
    )
    selected = systematic_sample(executed_candidates, args.samples)

    overall = metrics(selected)
    grade_a_rows = [row for row in selected if row.grade in {"A", "A+"}]
    grade_a = metrics(grade_a_rows)
    grade_a_models, qualified = qualifying_grade_a_models(selected)
    base_models, qualified_base_models = qualifying_executed_models(selected)
    rejection_counts: dict[str, int] = defaultdict(int)
    for row in all_candidates:
        for reason in row.rejection_reasons:
            rejection_counts[reason] += 1
    candidate_audit = metrics(all_candidates)
    eligible_trading_days = int(
        df.loc[~df["ny_weekday"].isin(["Sat", "Sun", "Saturday", "Sunday"]), "ny_date"].nunique()
    )
    valid_candidates = [row for row in all_candidates if row.status in {"VALID_UNFILLED", "EXECUTED"}]
    candidate_audit["eligibleTradingDays"] = eligible_trading_days
    candidate_audit["candidateSignalsPerEligibleDay"] = len(all_candidates) / max(1, eligible_trading_days)
    candidate_audit["validSignalsPerEligibleDay"] = len(valid_candidates) / max(1, eligible_trading_days)
    candidate_audit["executedSetupsPerEligibleDay"] = len(executed_candidates) / max(1, eligible_trading_days)
    candidate_audit["daysWithAtLeastOneExecutedSetup"] = len({row.date_new_york for row in executed_candidates})
    candidate_audit["topRejectionReasons"] = [
        {"reason": reason, "count": count}
        for reason, count in sorted(rejection_counts.items(), key=lambda item: item[1], reverse=True)[:8]
    ]
    statistics = {
        "overall": overall,
        "overallBootstrap95MeanNetR": bootstrap_mean_ci(selected),
        "gradeA": grade_a,
        "gradeABootstrap95MeanNetR": bootstrap_mean_ci(grade_a_rows),
        "byStatus": dict(pd.Series([row.status for row in selected]).value_counts()),
        "byModel": group_metrics(selected, ["model"]),
        "bySplit": group_metrics(selected, ["split"]),
        "bySession": group_metrics(selected, ["session"]),
        "byDirection": group_metrics(selected, ["direction"]),
        "byGrade": group_metrics(selected, ["grade"]),
        "byLiquidityScope": group_metrics(selected, ["liquidity_scope"]),
        "byRegime": group_metrics(selected, ["regime_15m"]),
        "byRetestNumber": group_metrics(selected, ["retest_number"]),
        "byObFvgOverlap": group_metrics(selected, ["ob_fvg_overlap"]),
        "exploratoryModelSession": group_metrics(selected, ["model", "session"]),
        "exploratoryModelDirection": group_metrics(selected, ["model", "direction"]),
        "exploratoryModelRegime": group_metrics(selected, ["model", "regime_15m"]),
        "baseModelRobustness": base_models,
        "gradeAByModel": grade_a_models,
        "gradeABySplit": group_metrics(selected, ["split"], grade_a_only=True),
        "gradeABySession": group_metrics(selected, ["session"], grade_a_only=True),
        "gradeAByDirection": group_metrics(selected, ["direction"], grade_a_only=True),
        "gradeAByLiquidityScope": group_metrics(selected, ["liquidity_scope"], grade_a_only=True),
        "gradeAByObFvgOverlap": group_metrics(selected, ["ob_fvg_overlap"], grade_a_only=True),
        "gradeAByRetestNumber": group_metrics(selected, ["retest_number"], grade_a_only=True),
        "gradeAByRegime": group_metrics(selected, ["regime_15m"], grade_a_only=True),
        "gradeAExploratoryCombinations": group_metrics(selected, ["model", "session", "regime_15m"], grade_a_only=True),
    }
    payload = {
        "study": "XAUUSD SMC/ICT 300 London/New York setups",
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "researchOnly": True,
        "automaticExecutionEligible": False,
        "source": source,
        "sampling": {
            "method": "deterministic systematic sampling over the complete chronological executed-setup stream; PnL, grade and model blind",
            "independentCandidatesFound": len(all_candidates),
            "executedSetupsFound": len(executed_candidates),
            "selectedSamples": len(selected),
            "development": sum(row.split == "development" for row in selected),
            "validation": sum(row.split == "validation" for row in selected),
            "outOfSample": sum(row.split == "out_of_sample" for row in selected),
        },
        "candidateAudit": candidate_audit,
        "frozenRules": {
            "sessionsNewYorkTime": {"london": "02:00-05:00", "new_york": "07:00-11:00"},
            "weekends": "no new setups",
            "liquidity": ["previous day high/low", "20:00-00:00 ET Asian proxy high/low", "confirmed 5m pivots/equal highs-lows"],
            "pivotConfirmation": "two bars left and two bars right; pivot becomes usable only after the second right bar closes",
            "sweep": "penetration >= max(2x spread, 0.10x R5), reclaim within 1-3 bars, no >2.5x uncontrolled extension",
            "mss": "close beyond last confirmed 1m pivot, displacement >=1.5x prior 20-body median, body/range >=60%",
            "fvg": "three-candle imbalance >=0.15x R1",
            "entry": "first conservative return to OB/FVG overlap or midpoint, maximum eight 1m bars",
            "stop": "sweep extreme plus max(2x spread, 0.25x R1), accepted only between 0.60x and 2.00x R5",
            "minimumNearestLiquidityRR": 1.5,
            "management": "30% 1R, 40% <=2R nearest-liquidity target, 30% runner 2.5R-4R, no automatic breakeven",
            "maximumHoldingMinutes": MAX_HOLD_BARS,
            "sameBarAmbiguity": "stop first",
            "additionalAdverseSlippageBpsPerFill": SLIPPAGE_BPS_PER_FILL,
            "grade": "A+/A=11-12/10, B=8-9, C<=7",
            "consecutiveLossLock": "none",
        },
        "statistics": statistics,
        "conclusion": {
            "qualifiedGradeAModels": qualified,
            "qualifiedBaseModels": qualified_base_models,
            "status": "QUALIFIED_GRADE_A_MODEL_FOUND" if qualified else "NO_GRADE_A_MODEL_PASSED_ALL_ROBUSTNESS_GATES",
            "note": "Positive development-set expectancy alone is not sufficient. Validation and OOS must also be positive with minimum sample counts.",
        },
        "samples": [asdict(row) for row in selected],
        "limitations": [
            "Community OTC/CFD midpoint chart proxy, not certified COMEX futures or broker-native Bid/Ask history.",
            "Historical macro-news calendar is unavailable; abnormal spread is the only news-volatility proxy.",
            "One-minute bars do not reveal intrabar path; same-bar stop/target is conservatively stop-first.",
            "Grade and model labels are deterministic research definitions, not discretionary chart annotations.",
        ],
    }
    clean_payload = json_clean(payload)
    Path(args.json).write_text(json.dumps(clean_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    flat_rows = []
    for row in selected:
        item = asdict(row)
        item["rejection_reasons"] = "|".join(item["rejection_reasons"])
        flat_rows.append(item)
    pd.DataFrame(flat_rows).to_csv(args.csv, index=False, encoding="utf-8")
    Path(args.report).write_text(render_report(clean_payload, selected), encoding="utf-8")
    print(json.dumps({
        "samples": len(selected),
        "allCandidates": len(all_candidates),
        "overall": json_clean(overall),
        "gradeA": json_clean(grade_a),
        "qualifiedGradeAModels": [item["model"] for item in qualified],
        "qualifiedBaseModels": [item["model"] for item in qualified_base_models],
        "outputs": [args.csv, args.json, args.report],
    }, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
