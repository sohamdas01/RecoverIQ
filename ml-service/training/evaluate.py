"""
RecoverIQ ML Service — Model Evaluation & Naive Baseline Comparison
-------------------------------------------------------------------
Evaluates the trained model on the untouched holdout test set (test.csv).

Reports:
  1. Standard Classification Metrics (Precision, Recall, F1, ROC-AUC, Accuracy)
  2. Confusion Matrix
  3. Probability Calibration (Brier Score + Decile Calibration Table)
  4. Naive Baseline Comparison ("Always Attempt Recovery" vs "Model-Guided Recovery")
     - Recovery success rate
     - Total recovered revenue (INR)
     - Gate efficiency & fee savings
"""

import os
import sys
import json
import argparse
import joblib
import pandas as pd
import numpy as np
from sklearn.metrics import (
    precision_score,
    recall_score,
    f1_score,
    roc_auc_score,
    accuracy_score,
    confusion_matrix,
    brier_score_loss,
)

# Set stdout encoding for cross-platform compatibility
if sys.stdout.encoding != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

# Add parent directory to sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from preprocessing.features import preprocess_dataframe


def evaluate_model(
    data_dir: str = None,
    artifacts_dir: str = None,
    threshold: float = 0.50,
    cost_per_attempt_inr: float = 15.0,  # Gateway & notification overhead per retry attempt
):
    base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    if data_dir is None:
        data_dir = os.path.join(base_dir, "data")
    if artifacts_dir is None:
        artifacts_dir = os.path.join(base_dir, "artifacts")

    model_path = os.path.join(artifacts_dir, "model.joblib")
    test_path = os.path.join(data_dir, "test.csv")

    if not os.path.exists(model_path):
        raise FileNotFoundError(f"Model not found at {model_path}. Run train.py first.")
    if not os.path.exists(test_path):
        raise FileNotFoundError(f"Test dataset not found at {test_path}. Run generate_dataset.py first.")

    print(f"[Evaluation] Loading model from {model_path}...")
    model = joblib.load(model_path)

    print(f"[Evaluation] Loading holdout test set from {test_path}...")
    raw_test_df = pd.read_csv(test_path)
    y_test = raw_test_df["recovery_succeeded"].values
    amounts = raw_test_df["amount"].values

    # Preprocess holdout test features using single source of truth
    X_test = preprocess_dataframe(raw_test_df)

    # 1. Model Inference
    y_prob = model.predict_proba(X_test)[:, 1]
    y_pred = (y_prob >= threshold).astype(int)

    # 2. Standard Classification Metrics
    prec = float(precision_score(y_test, y_pred))
    rec = float(recall_score(y_test, y_pred))
    f1 = float(f1_score(y_test, y_pred))
    auc = float(roc_auc_score(y_test, y_prob))
    acc = float(accuracy_score(y_test, y_pred))
    cm = confusion_matrix(y_test, y_pred)
    tn, fp, fn, tp = [int(x) for x in cm.ravel()]

    # 3. Probability Calibration & Brier Score
    brier = float(brier_score_loss(y_test, y_prob))

    # Calibration deciles
    calibration_deciles = []
    bins = np.linspace(0.0, 1.0, 11)
    for i in range(len(bins) - 1):
        low, high = bins[i], bins[i + 1]
        mask = (y_prob >= low) & (y_prob < high if i < len(bins) - 2 else y_prob <= high)
        n_bin = int(mask.sum())
        if n_bin > 0:
            mean_pred = float(y_prob[mask].mean())
            fraction_pos = float(y_test[mask].mean())
            calibration_deciles.append({
                "bin_range": f"{low:.1f}-{high:.1f}",
                "count": n_bin,
                "mean_predicted_prob": round(mean_pred, 4),
                "actual_positive_rate": round(fraction_pos, 4),
                "calibration_gap": round(abs(mean_pred - fraction_pos), 4),
            })

    # 4. Naive Baseline vs Model-Guided Policy Comparison
    total_cases = len(y_test)

    # Naive Strategy: "Always attempt immediate recovery for all failed cases"
    naive_attempts = total_cases
    naive_recoveries = int(y_test.sum())
    naive_success_rate = float(naive_recoveries / naive_attempts)
    naive_recovered_revenue = float(amounts[y_test == 1].sum())
    naive_total_retry_cost = float(naive_attempts * cost_per_attempt_inr)
    naive_net_revenue = float(naive_recovered_revenue - naive_total_retry_cost)

    # Model-Guided Strategy: "Attempt recovery only if predicted recovery probability >= threshold"
    gated_attempts_mask = (y_prob >= threshold)
    model_attempts = int(gated_attempts_mask.sum())
    model_recoveries = int((gated_attempts_mask & (y_test == 1)).sum())
    model_success_rate = float(model_recoveries / model_attempts) if model_attempts > 0 else 0.0
    model_recovered_revenue = float(amounts[gated_attempts_mask & (y_test == 1)].sum())
    model_total_retry_cost = float(model_attempts * cost_per_attempt_inr)
    model_net_revenue = float(model_recovered_revenue - model_total_retry_cost)
    unnecessary_attempts_avoided = int(naive_attempts - model_attempts)
    cost_saved_inr = float(unnecessary_attempts_avoided * cost_per_attempt_inr)

    # ---------------------------------------------------------
    # Pretty Print Evaluation Summary (ASCII Safe)
    # ---------------------------------------------------------
    print("\n" + "=" * 65)
    print("       RECOVERIQ ML MODEL EVALUATION REPORT (HOLDOUT TEST SET)")
    print("=" * 65)
    print(f"Total Holdout Cases : {total_cases:,}")
    print(f"Decision Threshold  : {threshold:.2f}\n")
    
    print("[1] CLASSIFICATION METRICS:")
    print(f"  - ROC-AUC Score   : {auc:.4f}")
    print(f"  - Accuracy        : {acc:.4f} ({acc*100:.2f}%)")
    print(f"  - Precision       : {prec:.4f}")
    print(f"  - Recall          : {rec:.4f}")
    print(f"  - F1-Score        : {f1:.4f}")
    print(f"  - Brier Score Loss: {brier:.4f} (lower is better, 0 = perfect calibration)\n")

    print("[2] CONFUSION MATRIX:")
    print(f"  +---------------------+---------------------+")
    print(f"  |  True Negative: {tn:4d}| False Positive: {fp:4d}|")
    print(f"  +---------------------+---------------------+")
    print(f"  | False Negative: {fn:4d}|  True Positive: {tp:4d}|")
    print(f"  +---------------------+---------------------+\n")

    print("[3] PROBABILITY CALIBRATION DECILES:")
    print(f"  {'Range':10s} | {'Count':6s} | {'Mean Pred Prob':15s} | {'Actual Win Rate':16s} | {'Gap':8s}")
    print("  " + "-" * 62)
    for dec in calibration_deciles:
        print(f"  {dec['bin_range']:10s} | {dec['count']:6d} | {dec['mean_predicted_prob']:15.4f} | {dec['actual_positive_rate']:16.4f} | {dec['calibration_gap']:8.4f}")

    print("\n[4] STRATEGY COMPARISON (NAIVE BASELINE vs MODEL-GUIDED):")
    print(f"  {'Metric':32s} | {'Naive Baseline':18s} | {'Model-Guided':18s}")
    print("  " + "-" * 74)
    print(f"  {'Recovery Attempts Made':32s} | {naive_attempts:18,d} | {model_attempts:18,d}")
    print(f"  {'Successful Recoveries':32s} | {naive_recoveries:18,d} | {model_recoveries:18,d}")
    print(f"  {'Attempt Precision Rate':32s} | {naive_success_rate:18.2%} | {model_success_rate:18.2%}")
    print(f"  {'Recovered Revenue':32s} | INR {naive_recovered_revenue:14,.2f} | INR {model_recovered_revenue:14,.2f}")
    print(f"  {'Operational Retry Cost':32s} | INR {naive_total_retry_cost:14,.2f} | INR {model_total_retry_cost:14,.2f}")
    print(f"  {'Net Recovered Value':32s} | INR {naive_net_revenue:14,.2f} | INR {model_net_revenue:14,.2f}")
    print(f"  {'Unproductive Retries Avoided':32s} | {'0':18s} | {unnecessary_attempts_avoided:18,d}")
    print(f"  {'Direct Cost Savings':32s} | {'INR 0.00':18s} | INR {cost_saved_inr:14,.2f}")
    print("=" * 65 + "\n")

    report = {
        "dataset_size": total_cases,
        "classification_metrics": {
            "roc_auc": auc,
            "accuracy": acc,
            "precision": prec,
            "recall": rec,
            "f1_score": f1,
            "brier_score_loss": brier,
        },
        "confusion_matrix": {
            "true_negative": tn,
            "false_positive": fp,
            "false_negative": fn,
            "true_positive": tp,
        },
        "calibration_deciles": calibration_deciles,
        "comparison_vs_naive_baseline": {
            "naive_baseline": {
                "attempts": naive_attempts,
                "recoveries": naive_recoveries,
                "success_rate": naive_success_rate,
                "recovered_revenue_inr": naive_recovered_revenue,
                "operational_cost_inr": naive_total_retry_cost,
                "net_recovered_value_inr": naive_net_revenue,
            },
            "model_guided": {
                "threshold": threshold,
                "attempts": model_attempts,
                "recoveries": model_recoveries,
                "success_rate": model_success_rate,
                "recovered_revenue_inr": model_recovered_revenue,
                "operational_cost_inr": model_total_retry_cost,
                "net_recovered_value_inr": model_net_revenue,
                "futile_attempts_avoided": unnecessary_attempts_avoided,
                "operational_savings_inr": cost_saved_inr,
            }
        }
    }

    report_path = os.path.join(artifacts_dir, "evaluation_report.json")
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(f"[Evaluation] Detailed evaluation report saved to: {report_path}")

    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Evaluate RecoverIQ ML Model")
    parser.add_argument("--data-dir", type=str, default=None)
    parser.add_argument("--artifacts-dir", type=str, default=None)
    parser.add_argument("--threshold", type=float, default=0.50)
    args = parser.parse_args()

    evaluate_model(
        data_dir=args.data_dir,
        artifacts_dir=args.artifacts_dir,
        threshold=args.threshold
    )
