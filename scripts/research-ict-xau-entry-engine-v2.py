#!/usr/bin/env python3
"""XAU SMC/ICT Entry Engine V2 entry-confirmation research.

Uses the frozen 300 executed XAU setups from round 1. It does not rescan or create new
trade opportunities; it annotates each original setup with entry-confirmation features and
re-simulates only alternative entry styles anchored to the same sweep/MSS event.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import random
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
BASE_SCRIPT = ROOT / "scripts" / "research-ict-xau-300-setups.py"
spec = importlib.util.spec_from_file_location("xau300", BASE_SCRIPT)
base = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
assert spec and spec.loader
sys.modules["xau300"] = base
spec.loader.exec_module(base)  # type: ignore[union-attr]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--parquet", default="research-data/xauusd-huggingface/raw/0000.parquet")
    p.add_argument("--setups", default="research-ict-xau-300-setups.csv")
    p.add_argument("--features-csv", default="research-ict-xau-entry-engine-v2-features.csv")
    p.add_argument("--variants-csv", default="research-ict-xau-entry-engine-v2-entry-variants.csv")
    p.add_argument("--json", default="research-ict-xau-entry-engine-v2.json")
    p.add_argument("--report", default="XAU_SMC_ICT_ENTRY_ENGINE_V2_REPORT.md")
    return p.parse_args()


def fnum(x: Any) -> float | None:
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except Exception:
        return None


def pct(x: Any) -> str:
    if x is None or (isinstance(x, float) and not math.isfinite(x)):
        return "—"
    return f"{100 * float(x):.2f}%"


def num(x: Any, n: int = 3) -> str:
    if x is None:
        return "—"
    if isinstance(x, float) and math.isinf(x):
        return "∞"
    if isinstance(x, float) and math.isnan(x):
        return "—"
    return f"{float(x):.{n}f}"


def metrics(df: pd.DataFrame, r_col: str = "net_r") -> dict[str, Any]:
    if df.empty or r_col not in df:
        return {
            "n": 0,
            "winRate": None,
            "meanR": None,
            "medianR": None,
            "pf": None,
            "expectancy": None,
            "totalR": 0.0,
            "maxDrawdownR": None,
            "falseMssRate": None,
            "largestWinnerShare": None,
        }
    vals = pd.to_numeric(df[r_col], errors="coerce").dropna()
    if vals.empty:
        return metrics(pd.DataFrame())
    wins = vals[vals > 0]
    losses = vals[vals < 0]
    gross_win = float(wins.sum())
    gross_loss = float(-losses.sum())
    eq = vals.cumsum()
    dd = (eq.cummax() - eq).max() if len(eq) else 0.0
    positive_sum = gross_win
    largest_winner_share = float(wins.max() / positive_sum) if positive_sum > 0 and len(wins) else None
    false_rate = None
    if "false_mss" in df:
        false_rate = pd.Series(df["false_mss"]).map(lambda v: str(v).lower() == "true").mean()
    return {
        "n": int(len(vals)),
        "winRate": float((vals > 0).mean()),
        "meanR": float(vals.mean()),
        "medianR": float(vals.median()),
        "pf": math.inf if gross_loss == 0 and gross_win > 0 else (gross_win / gross_loss if gross_loss > 0 else None),
        "expectancy": float(vals.mean()),
        "totalR": float(vals.sum()),
        "maxDrawdownR": float(dd),
        "falseMssRate": false_rate,
        "largestWinnerShare": largest_winner_share,
    }


def split_metrics(df: pd.DataFrame, r_col: str = "net_r") -> dict[str, dict[str, Any]]:
    order = ["development", "validation", "out_of_sample"]
    return {s: metrics(df[df["split"] == s], r_col) for s in order}


def bootstrap_mean_ci(vals: list[float], seed: int = 20260716, iters: int = 4000) -> list[float] | None:
    vals = [v for v in vals if math.isfinite(v)]
    if not vals:
        return None
    rng = random.Random(seed)
    means = []
    n = len(vals)
    for _ in range(iters):
        means.append(sum(vals[rng.randrange(n)] for _ in range(n)) / n)
    means.sort()
    return [means[int(0.025 * iters)], means[int(0.975 * iters)]]


def group_table(df: pd.DataFrame, field: str, order: list[str] | None = None, min_n: int = 1, r_col: str = "net_r") -> list[dict[str, Any]]:
    rows = []
    keys = order if order else list(df[field].dropna().astype(str).unique())
    for key in keys:
        sub = df[df[field].astype(str) == str(key)]
        m = metrics(sub, r_col)
        if m["n"] >= min_n:
            rows.append({"group": key, **m, "splits": split_metrics(sub, r_col)})
    return rows


def render_metric_table(rows: list[dict[str, Any]], label: str = "分组") -> str:
    if not rows:
        return "无样本。"
    lines = [f"| {label} | 样本 | 胜率 | 平均R/Expectancy | 中位R | PF | 最大回撤R | False MSS |", "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for r in rows:
        lines.append(
            f"| {r['group']} | {r['n']} | {pct(r['winRate'])} | {num(r['meanR'])} | {num(r['medianR'])} | {num(r['pf'])} | {num(r['maxDrawdownR'])} | {pct(r.get('falseMssRate'))} |"
        )
    return "\n".join(lines)


def render_split_table(rows: list[dict[str, Any]], label: str = "分组") -> str:
    if not rows:
        return "无样本。"
    lines = [f"| {label} | Dev n/PF/Exp | Val n/PF/Exp | OOS n/PF/Exp |", "|---|---:|---:|---:|"]
    for r in rows:
        cells = []
        for s in ["development", "validation", "out_of_sample"]:
            m = r["splits"][s]
            cells.append(f"{m['n']} / {num(m['pf'])} / {num(m['meanR'])}")
        lines.append(f"| {r['group']} | {cells[0]} | {cells[1]} | {cells[2]} |")
    return "\n".join(lines)


def signed_close_position(row: pd.Series, side: str) -> float:
    rng = float(row["high"] - row["low"])
    if rng <= 0:
        return 0.5
    if side == "long":
        return float((row["close"] - row["low"]) / rng)
    return float((row["high"] - row["close"]) / rng)


def consecutive_push(ctx: Any, i: int, side: str) -> int:
    count = 0
    for j in range(i, max(-1, i - 6), -1):
        row = ctx.df.iloc[j]
        same = float(row["close"]) > float(row["open"]) if side == "long" else float(row["close"]) < float(row["open"])
        if not same:
            break
        if j < i and (ctx.df.iloc[j + 1]["datetime"] - row["datetime"]).total_seconds() > 60:
            break
        count += 1
    return count


def protected_pivot(ctx: Any, signal_i: int, side: str, sweep_i: int) -> tuple[int | None, float | None]:
    # Operational definition: the last confirmed 1m swing that protected the swept leg before
    # the sweep extreme. It must be before the sweep, not a tiny pivot printed after the reclaim.
    flags = ctx.pivot_high_1m if side == "long" else ctx.pivot_low_1m
    col = "high" if side == "long" else "low"
    start = max(2, sweep_i - 60)
    end = min(signal_i - 2, sweep_i)
    if end < start:
        return None, None
    candidates = list(np.flatnonzero(flags[start : end + 1]) + start)
    if not candidates:
        return None, None
    # Prefer the closest pre-sweep protected pivot, but require that it is not the same as the
    # post-sweep micro pivot by construction. A break of this level is a stricter MSS.
    idx = int(candidates[-1])
    return idx, float(ctx.df.iloc[idx][col])


def make_sweep_from_row(ctx: Any, row: pd.Series, signal_i: int) -> Any:
    sweep_ts = pd.Timestamp(row["sweep_time_utc"])
    sweep_i = int(ctx.df.index[ctx.df["datetime"] == sweep_ts][0])
    reclaim_i = min(signal_i, sweep_i + int(row["sweep_reclaim_bars"]) - 1)
    side = str(row["direction"])
    extreme = float(ctx.df.iloc[sweep_i : reclaim_i + 1]["low"].min()) if side == "long" else float(ctx.df.iloc[sweep_i : reclaim_i + 1]["high"].max())
    return base.Sweep(
        side=side,
        sweep_index=sweep_i,
        reclaim_index=reclaim_i,
        level_type=str(row["liquidity_type"]),
        level_scope=str(row["liquidity_scope"]),
        level_price=float(row["liquidity_price"]),
        extreme=extreme,
        penetration=float(row["sweep_penetration_usd"]),
        penetration_r5=float(row["sweep_penetration_r5"]),
        reclaim_bars=int(row["sweep_reclaim_bars"]),
        spread=float(row["spread_at_signal_usd"]),
    )


def simulate_entry_variant(ctx: Any, signal_i: int, side: str, sweep: Any, zone: tuple[float, float, float] | None, start_i: int | None = None) -> dict[str, Any] | None:
    if zone is None:
        return None
    row = ctx.df.iloc[signal_i]
    r1 = fnum(row["r1"]) or 0.0
    if r1 <= 0:
        return None
    fill_start = signal_i if start_i is None else start_i
    fill = base.find_fill(ctx, fill_start, side, zone, r1)
    if fill is None:
        return None
    entry_i, entry_mid, retest_number = fill
    buffer = max(2 * float(row["spread_usd"]), 0.25 * r1)
    stop_mid = sweep.extreme - buffer if side == "long" else sweep.extreme + buffer
    if (side == "long" and stop_mid >= entry_mid) or (side == "short" and stop_mid <= entry_mid):
        return None
    k5 = max(0, int(ctx.completed5[signal_i]))
    r5 = fnum(ctx.bars5.iloc[k5]["r"]) or 0.0
    risk = abs(entry_mid - stop_mid)
    stop_r5 = risk / r5 if r5 > 0 else None
    if stop_r5 is None or stop_r5 < 0.60 or stop_r5 > 2.00:
        return None
    target_price, _target_kind = base.target_liquidity(ctx, signal_i, side, entry_mid)
    nearest_rr = abs(target_price - entry_mid) / risk if target_price is not None and risk > 0 else None
    if nearest_rr is None or nearest_rr < 1.5:
        return None
    direction = 1 if side == "long" else -1
    tp1 = entry_mid + direction * risk
    tp2_r = max(1.5, min(2.0, nearest_rr or 2.0))
    runner_r = max(2.5, min(4.0, nearest_rr or 2.5))
    sim = base.simulate(ctx, entry_i, side, entry_mid, stop_mid, entry_mid + direction * risk, entry_mid + direction * risk * tp2_r, entry_mid + direction * risk * runner_r)
    return {
        "entry_i": entry_i,
        "entry_time_utc": base.iso(ctx.df.iloc[entry_i]["datetime"]),
        "entry_mid": entry_mid,
        "stop_mid": stop_mid,
        "stop_distance_r5": stop_r5,
        "nearest_rr": nearest_rr,
        "retest_number": retest_number,
        "net_r": sim["net_r"],
        "gross_r": sim["gross_r"],
        "cost_r": sim["cost_r"],
        "mfe_r": sim["mfe_r"],
        "mae_r": sim["mae_r"],
        "false_mss": sim["false_mss"],
        "exit_reason": sim["exit_reason"],
    }


def find_second_structure_confirmation(ctx: Any, signal_i: int, side: str) -> int | None:
    # Requires a post-MSS pullback pivot and then a break of the post-MSS impulse extreme.
    max_j = min(len(ctx.df) - 1, signal_i + 20)
    if side == "long":
        pull_flags = ctx.pivot_low_1m
        impulse_extreme = float(ctx.df.iloc[signal_i]["high"])
        for j in range(signal_i + 3, max_j + 1):
            if (ctx.df.iloc[j]["datetime"] - ctx.df.iloc[j - 1]["datetime"]).total_seconds() > 60:
                return None
            if len(np.flatnonzero(pull_flags[signal_i + 1 : max(signal_i + 1, j - 1)])) == 0:
                impulse_extreme = max(impulse_extreme, float(ctx.df.iloc[j]["high"]))
                continue
            if float(ctx.df.iloc[j - 1]["close"]) <= impulse_extreme < float(ctx.df.iloc[j]["close"]):
                return j
            impulse_extreme = max(impulse_extreme, float(ctx.df.iloc[j]["high"]))
    else:
        pull_flags = ctx.pivot_high_1m
        impulse_extreme = float(ctx.df.iloc[signal_i]["low"])
        for j in range(signal_i + 3, max_j + 1):
            if (ctx.df.iloc[j]["datetime"] - ctx.df.iloc[j - 1]["datetime"]).total_seconds() > 60:
                return None
            if len(np.flatnonzero(pull_flags[signal_i + 1 : max(signal_i + 1, j - 1)])) == 0:
                impulse_extreme = min(impulse_extreme, float(ctx.df.iloc[j]["low"]))
                continue
            if float(ctx.df.iloc[j - 1]["close"]) >= impulse_extreme > float(ctx.df.iloc[j]["close"]):
                return j
            impulse_extreme = min(impulse_extreme, float(ctx.df.iloc[j]["low"]))
    return None


def run() -> dict[str, Any]:
    args = parse_args()
    df_src, source_meta = base.load_source(ROOT / args.parquet)
    # Add average body and ATR-style 1m mean range for this V2 study.
    df_src["mean_body20"] = df_src["body"].rolling(20, min_periods=20).mean().shift(1)
    df_src["atr1_20"] = df_src["range"].rolling(20, min_periods=20).mean().shift(1)
    ctx = base.make_context(df_src)
    setups = pd.read_csv(ROOT / args.setups)
    ts_to_index = {pd.Timestamp(ts): i for i, ts in enumerate(ctx.df["datetime"])}
    features: list[dict[str, Any]] = []
    variant_rows: list[dict[str, Any]] = []

    for _, setup in setups.iterrows():
        signal_ts = pd.Timestamp(setup["timestamp_utc"])
        signal_i = ts_to_index[signal_ts]
        side = str(setup["direction"])
        sweep = make_sweep_from_row(ctx, setup, signal_i)
        bar = ctx.df.iloc[signal_i]
        atr1 = fnum(bar["atr1_20"]) or (fnum(bar["r1"]) or 0.0)
        mean_body = fnum(bar["mean_body20"]) or 0.0
        close_pos = signed_close_position(bar, side)
        body_atr = float(bar["body"] / atr1) if atr1 > 0 else math.nan
        body_avg_multiple = float(bar["body"] / mean_body) if mean_body > 0 else math.nan
        pivot_price = float(setup["mss_pivot_price"])
        break_dist = (float(bar["close"]) - pivot_price) if side == "long" else (pivot_price - float(bar["close"]))
        break_dist_atr = break_dist / atr1 if atr1 > 0 else math.nan
        prot_i, prot_price = protected_pivot(ctx, signal_i, side, sweep.sweep_index)
        protected_break = False
        protected_distance_atr = math.nan
        if prot_i is not None and prot_price is not None and signal_i > 0:
            prev_close = float(ctx.df.iloc[signal_i - 1]["close"])
            protected_break = (prev_close <= prot_price < float(bar["close"])) if side == "long" else (prev_close >= prot_price > float(bar["close"]))
            protected_distance_atr = ((float(bar["close"]) - prot_price) if side == "long" else (prot_price - float(bar["close"]))) / atr1 if atr1 > 0 else math.nan
        consec = consecutive_push(ctx, signal_i, side)
        displacement_condition = bool(body_avg_multiple > 1.5 and close_pos >= 0.75)
        has_fvg = bool(setup["mss_has_fvg"])
        if body_atr >= 1.0 and close_pos >= 0.80 and consec >= 2:
            break_quality = "strong"
        elif body_atr >= 0.50 and close_pos >= 0.65:
            break_quality = "medium"
        else:
            break_quality = "weak"
        wait = signal_i - sweep.sweep_index
        if break_dist_atr < 0.2:
            break_bucket = "<0.2 ATR"
        elif break_dist_atr < 0.5:
            break_bucket = "0.2-0.5 ATR"
        elif break_dist_atr < 1.0:
            break_bucket = "0.5-1 ATR"
        else:
            break_bucket = ">1 ATR"
        if wait <= 2:
            wait_bucket = "0-2m"
        elif wait <= 5:
            wait_bucket = "3-5m"
        elif wait <= 10:
            wait_bucket = "6-10m"
        else:
            wait_bucket = ">10m"

        fvg = base.find_one_minute_fvg(ctx, signal_i, side)
        ob = base.find_order_block(ctx, signal_i, side, sweep.sweep_index)
        overlap_zone = None
        if fvg and ob:
            lo, hi = max(fvg[0], ob[0]), min(fvg[1], ob[1])
            if hi > lo:
                overlap_zone = (lo, hi, (lo + hi) / 2)
        zones = {
            "Entry A: first OB retest": ob,
            "Entry B: FVG 50% refill": fvg,
            "Entry C: OB+FVG overlap": overlap_zone,
        }
        for name, zone in zones.items():
            z = None if zone is None else (float(zone[0]), float(zone[1]), (float(zone[0]) + float(zone[1])) / 2)
            vr = simulate_entry_variant(ctx, signal_i, side, sweep, z)
            if vr:
                variant_rows.append({"sample_id": setup["sample_id"], "split": setup["split"], "entry_model": name, **vr})
        second_i = find_second_structure_confirmation(ctx, signal_i, side)
        if second_i is not None:
            fvg2 = base.find_one_minute_fvg(ctx, second_i, side)
            ob2 = base.find_order_block(ctx, second_i, side, sweep.sweep_index)
            zone2 = base.entry_zone(fvg2, ob2)
            vr = simulate_entry_variant(ctx, signal_i, side, sweep, zone2, start_i=second_i)
            if vr:
                variant_rows.append({"sample_id": setup["sample_id"], "split": setup["split"], "entry_model": "Entry D: second structure", **vr, "second_confirmation_time_utc": base.iso(ctx.df.iloc[second_i]["datetime"])})

        features.append({
            **setup.to_dict(),
            "signal_index": signal_i,
            "sweep_index": sweep.sweep_index,
            "sweep_to_mss_minutes": wait,
            "sweep_wait_bucket": wait_bucket,
            "atr1_20": atr1,
            "mss_break_distance_usd": break_dist,
            "mss_break_distance_atr": break_dist_atr,
            "mss_break_distance_bucket": break_bucket,
            "mss_body_atr": body_atr,
            "mss_body_avg20_multiple": body_avg_multiple,
            "mss_close_position_directional": close_pos,
            "mss_consecutive_push_bars": consec,
            "mss_break_quality": break_quality,
            "mss_displacement_v2": displacement_condition,
            "mss_displacement_v2_fvg": bool(displacement_condition and has_fvg),
            "protected_pivot_index": prot_i,
            "protected_pivot_price": prot_price,
            "protected_mss": protected_break,
            "protected_break_distance_atr": protected_distance_atr,
        })

    feat = pd.DataFrame(features)
    variants = pd.DataFrame(variant_rows)
    feat.to_csv(ROOT / args.features_csv, index=False, encoding="utf-8")
    variants.to_csv(ROOT / args.variants_csv, index=False, encoding="utf-8")

    baseline = metrics(feat)
    analyses: dict[str, Any] = {}
    analyses["mss_structure_level"] = group_table(feat.assign(mss_structure_level=np.where(feat["protected_mss"], "A2 Protected MSS", "A1 Ordinary / micro MSS only")), "mss_structure_level", ["A1 Ordinary / micro MSS only", "A2 Protected MSS"])
    analyses["break_distance"] = group_table(feat, "mss_break_distance_bucket", ["<0.2 ATR", "0.2-0.5 ATR", "0.5-1 ATR", ">1 ATR"])
    analyses["break_quality"] = group_table(feat, "mss_break_quality", ["weak", "medium", "strong"])
    disp_df = pd.concat([
        feat.assign(displacement_model="A MSS"),
        feat[feat["mss_displacement_v2"]].assign(displacement_model="B MSS + Displacement"),
        feat[feat["mss_displacement_v2_fvg"]].assign(displacement_model="C MSS + Displacement + FVG"),
    ], ignore_index=True)
    analyses["displacement"] = group_table(disp_df, "displacement_model", ["A MSS", "B MSS + Displacement", "C MSS + Displacement + FVG"])
    analyses["sweep_wait"] = group_table(feat, "sweep_wait_bucket", ["0-2m", "3-5m", "6-10m", ">10m"])
    if not variants.empty:
        analyses["entry_models"] = group_table(variants, "entry_model", ["Entry A: first OB retest", "Entry B: FVG 50% refill", "Entry C: OB+FVG overlap", "Entry D: second structure"])
    else:
        analyses["entry_models"] = []
    # First pullback rule on frozen baseline fills.
    feat["retest_bucket"] = feat["retest_number"].map(lambda x: "1st retest" if int(x) == 1 else "2nd retest" if int(x) == 2 else "3rd+ retest")
    analyses["retest_number"] = group_table(feat, "retest_bucket", ["1st retest", "2nd retest", "3rd+ retest"])
    analyses["session"] = group_table(feat, "session", ["london", "new_york"])

    # Candidate models inferred after feature analysis. These are filters on the same 300 baseline trades,
    # plus alternative entry variants where applicable. No thresholds are searched; they are the semantic
    # buckets requested by the research brief.
    candidate_frames: dict[str, pd.DataFrame] = {
        "Protected MSS + strong break + FVG": feat[(feat["protected_mss"]) & (feat["mss_break_quality"] == "strong") & (feat["mss_has_fvg"].astype(bool))],
        "Protected MSS + displacement + FVG": feat[(feat["protected_mss"]) & (feat["mss_displacement_v2_fvg"])],
        "Protected MSS + wait 3-10m + FVG": feat[(feat["protected_mss"]) & (feat["sweep_wait_bucket"].isin(["3-5m", "6-10m"])) & (feat["mss_has_fvg"].astype(bool))],
        "Strong break + overlap entry available": feat[(feat["mss_break_quality"] == "strong") & (feat["ob_fvg_overlap"].astype(bool))],
    }
    if not variants.empty:
        for entry_name in variants["entry_model"].dropna().unique():
            candidate_frames[f"{entry_name} (alternative execution)"] = variants[variants["entry_model"] == entry_name]

    candidates = []
    qualified = []
    for name, frame in candidate_frames.items():
        m = metrics(frame)
        sm = split_metrics(frame)
        vals = pd.to_numeric(frame["net_r"], errors="coerce").dropna().tolist() if "net_r" in frame else []
        ci = bootstrap_mean_ci(vals) if vals else None
        item = {"group": name, **m, "splits": sm, "bootstrapMeanR95": ci}
        item["passes"] = bool(
            m["n"] >= 30
            and all(sm[s]["n"] >= 5 for s in sm)
            and m["meanR"] is not None and m["meanR"] > 0
            and m["pf"] is not None and m["pf"] > 1
            and all(sm[s]["meanR"] is not None and sm[s]["meanR"] > 0 and sm[s]["pf"] is not None and sm[s]["pf"] > 1 for s in sm)
            and (m["largestWinnerShare"] is None or m["largestWinnerShare"] <= 0.35)
        )
        candidates.append(item)
        if item["passes"]:
            qualified.append(item)

    payload = {
        "study": "XAU SMC ICT Entry Engine V2 entry-confirmation research",
        "researchOnly": True,
        "source": source_meta,
        "baseSetups": str(ROOT / args.setups),
        "baseline": baseline,
        "baselineSplits": split_metrics(feat),
        "analyses": analyses,
        "candidateModels": candidates,
        "qualifiedModels": qualified,
        "outputs": [str(ROOT / args.features_csv), str(ROOT / args.variants_csv), str(ROOT / args.json), str(ROOT / args.report)],
        "methodNotes": {
            "protectedMss": "Break of the last confirmed 1m swing that protected the swept leg before the sweep; post-reclaim micro pivots do not qualify.",
            "displacementV2": "MSS candle body > prior 20-candle average body * 1.5 and directional close position >= 75%; FVG adds the original 3-candle 1m imbalance test.",
            "entryVariants": "Alternative entries are simulated only for the same original 300 sweep/MSS events; no new opportunities are scanned.",
            "qualification": "n>=30, each split n>=5, total and every split PF>1 and Expectancy>0, largest winner share <=35%.",
        },
    }
    Path(ROOT / args.json).write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    Path(ROOT / args.report).write_text(render_report(payload), encoding="utf-8")
    return payload


def render_report(payload: dict[str, Any]) -> str:
    baseline = payload["baseline"]
    candidates = payload["candidateModels"]
    qualified = payload["qualifiedModels"]
    a = payload["analyses"]
    lines = [
        "# XAU SMC ICT Entry Engine V2 入场确认优化研究",
        "",
        "## 研究结论",
        "",
    ]
    if qualified:
        lines.append(f"发现 {len(qualified)} 个候选模型满足 Development / Validation / OOS 与 PF、Expectancy 门槛。")
    else:
        lines.append("**当前数据无法证明存在正期望入场模型。**")
        lines.append("")
        lines.append("本轮只在第一轮 300 个已成交 Setup 上研究入场确认差异，没有重新寻找机会、没有改变 Liquidity Sweep、止损或止盈规则。若某些子集开发集表现较好但 Validation/OOS 样本不足或不一致，不能提升为 V2 实盘规则。")
    lines += [
        "",
        "## 1. 基准模型",
        "",
        f"- 样本：{baseline['n']} 个已成交 Setup。",
        f"- 胜率：{pct(baseline['winRate'])}。",
        f"- Profit Factor：{num(baseline['pf'])}。",
        f"- Expectancy / 平均净 R：{num(baseline['meanR'])}R。",
        f"- False MSS：{pct(baseline['falseMssRate'])}。",
        f"- 最大累计回撤：{num(baseline['maxDrawdownR'])}R。",
        "",
        "### 时间切分",
        "",
        render_split_table([{"group": "Baseline", "splits": payload["baselineSplits"]}], "模型"),
        "",
        "## 2. 每个变量影响",
        "",
        "### 变量1A：MSS 结构级别",
        "",
        render_metric_table(a["mss_structure_level"], "MSS类型"),
        "",
        render_split_table(a["mss_structure_level"], "MSS类型"),
        "",
        "### 变量1B：MSS 突破距离 / ATR(1m)",
        "",
        render_metric_table(a["break_distance"], "突破距离"),
        "",
        render_split_table(a["break_distance"], "突破距离"),
        "",
        "### 变量1C：MSS 突破K线质量",
        "",
        "强突破定义：实体/ATR>=1.0、收盘在方向性极值 80% 以内、且至少 2 根连续推动；中等突破为实体/ATR>=0.5 且收盘位置>=65%；其余为弱。",
        "",
        render_metric_table(a["break_quality"], "突破质量"),
        "",
        render_split_table(a["break_quality"], "突破质量"),
        "",
        "### 变量2：Displacement 确认",
        "",
        "Displacement V2 定义：MSS K线实体 > 过去20根平均实体 ×1.5，且按方向收盘位置 >=75%；FVG 为同一 MSS K线形成 1m 三蜡烛失衡。",
        "",
        render_metric_table(a["displacement"], "组合"),
        "",
        render_split_table(a["displacement"], "组合"),
        "",
        "### 变量3：Sweep 后等待时间",
        "",
        render_metric_table(a["sweep_wait"], "等待"),
        "",
        render_split_table(a["sweep_wait"], "等待"),
        "",
        "### 变量4：Entry 位置优化",
        "",
        "这些是同一 300 个原始 Sweep/MSS 事件上的替代执行模拟；未重新扫描新机会。",
        "",
        render_metric_table(a["entry_models"], "入场模型"),
        "",
        render_split_table(a["entry_models"], "入场模型"),
        "",
        "### 变量5：首次回踩规则",
        "",
        render_metric_table(a["retest_number"], "回踩次数"),
        "",
        render_split_table(a["retest_number"], "回踩次数"),
        "",
        "### 变量6：交易时段过滤",
        "",
        render_metric_table(a["session"], "Session"),
        "",
        render_split_table(a["session"], "Session"),
        "",
        "## 3. 最优入场模型候选审计",
        "",
        "通过门槛：总样本 n>=30；Development、Validation、OOS 各 n>=5；总体与三段 PF>1 且 Expectancy>0；最大赢家占全部正R不超过35%。",
        "",
        render_metric_table(candidates, "候选"),
        "",
        render_split_table(candidates, "候选"),
        "",
    ]
    if qualified:
        lines += ["### 通过候选", "", render_metric_table(qualified, "候选"), ""]
    else:
        lines += [
            "### 通过候选",
            "",
            "无。Development、Validation、OOS 三段没有同时证明 PF>1 与 Expectancy>0 的入场模型。",
            "",
        ]
    lines += [
        "## 4. Entry Engine V2 规则结论",
        "",
    ]
    if qualified:
        best = qualified[0]
        lines.append(f"可进入下一轮 forward/shadow 验证的候选：**{best['group']}**。仍需新增样本验证后才能进入真实交易规则。")
    else:
        lines += [
            "由于没有模型满足样本量、Development、Validation、OOS、PF 与 Expectancy 条件，本轮不发布新的可交易 V2 入场规则。",
            "",
            "当前可复盘的保守结论是：",
            "",
            "1. Protected MSS、强突破、FVG/Displacement 可以作为下一轮观察标签，但不能单独作为上线过滤器。",
            "2. Entry C（OB+FVG重叠）若样本过少，即使 PF 较高也只属于探索候选。",
            "3. 任何只在 Development 或小样本中改善的规则都必须进入新增样本或 forward/shadow 验证。",
            "",
            "### 暂不成立的 V2 规则模板",
            "",
            "市场条件 → XAU 欧美盘 1m/5m；Liquidity条件 → 沿用第一轮定义；Entry Confirmation → 暂无统计证明可替代 V1；入场规则/止损/止盈 → 不升级。",
        ]
    lines += [
        "",
        "## 文件",
        "",
        "- `research-ict-xau-entry-engine-v2-features.csv`：300 个 Setup 的 V2 特征标注。",
        "- `research-ict-xau-entry-engine-v2-entry-variants.csv`：同一300个Setup上的替代入场执行明细。",
        "- `research-ict-xau-entry-engine-v2.json`：完整统计、切分与候选审计。",
        "- `scripts/research-ict-xau-entry-engine-v2.py`：可复现脚本。",
    ]
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    out = run()
    print(json.dumps({"baseline": out["baseline"], "qualified": [q["group"] for q in out["qualifiedModels"]], "outputs": out["outputs"]}, ensure_ascii=False, indent=2, default=str))
