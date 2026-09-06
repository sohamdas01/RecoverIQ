"""
RecoverIQ ML Service — XGBoost Model Training Pipeline
------------------------------------------------------
Trains a binary classification model (XGBClassifier) to estimate payment recovery probability.
Strictly adheres to:
  - Single source of truth preprocessing (preprocessing.features)
  - Zero data leakage (train on train.csv, validate on val.csv, keep test.csv untouched)
  - Reproducible random seed (42)
  - Metadata preservation (version, feature names, hyperparams, training metrics)
"""

import os
import sys
import json
import argparse
from datetime import datetime
import joblib
import pandas as pd
import numpy as np
from xgboost import XGBClassifier
from sklearn.metrics import roc_auc_score, accuracy_score, log_loss

# Add parent directory to sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from preprocessing.features import preprocess_dataframe, get_feature_names

MODEL_VERSION = "v1.0.0"


def train_model(
    data_dir: str = None,
    artifacts_dir: str = None,
    random_seed: int = 42,
    n_estimators: int = 150,
    max_depth: int = 4,
    learning_rate: float = 0.08,
):
    base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    if data_dir is None:
        data_dir = os.path.join(base_dir, "data")
    if artifacts_dir is None:
        artifacts_dir = os.path.join(base_dir, "artifacts")

    os.makedirs(artifacts_dir, exist_ok=True)

    train_path = os.path.join(data_dir, "train.csv")
    val_path = os.path.join(data_dir, "val.csv")

    if not os.path.exists(train_path) or not os.path.exists(val_path):
        raise FileNotFoundError(f"Training data not found in {data_dir}. Run generate_dataset.py first.")

    print(f"[Training] Loading train ({train_path}) and val ({val_path})...")
    raw_train_df = pd.read_csv(train_path)
    raw_val_df = pd.read_csv(val_path)

    # 1. Apply single source of truth preprocessing
    print("[Training] Preprocessing dataset features...")
    X_train = preprocess_dataframe(raw_train_df)
    y_train = raw_train_df["recovery_succeeded"].values

    X_val = preprocess_dataframe(raw_val_df)
    y_val = raw_val_df["recovery_succeeded"].values

    feature_names = get_feature_names()
    print(f"[Training] Features: {len(feature_names)} features | Train samples: {len(X_train)} | Val samples: {len(X_val)}")

    # 2. Instantiate XGBoost Classifier
    xgb = XGBClassifier(
        n_estimators=n_estimators,
        max_depth=max_depth,
        learning_rate=learning_rate,
        subsample=0.85,
        colsample_bytree=0.85,
        eval_metric="logloss",
        early_stopping_rounds=15,
        random_state=random_seed,
        tree_method="hist",
    )

    # 3. Fit model
    print("[Training] Fitting XGBoost Classifier with early stopping...")
    xgb.fit(
        X_train,
        y_train,
        eval_set=[(X_train, y_train), (X_val, y_val)],
        verbose=False,
    )

    # 4. Evaluate Validation Performance
    val_preds_prob = xgb.predict_proba(X_val)[:, 1]
    val_preds = (val_preds_prob >= 0.5).astype(int)

    val_auc = float(roc_auc_score(y_val, val_preds_prob))
    val_acc = float(accuracy_score(y_val, val_preds))
    val_logloss = float(log_loss(y_val, val_preds_prob))

    print(f"\n[Training] Validation Results:")
    print(f"  - ROC-AUC  : {val_auc:.4f}")
    print(f"  - Accuracy : {val_acc:.4f}")
    print(f"  - Log-Loss : {val_logloss:.4f}")
    print(f"  - Best Iteration: {xgb.best_iteration}")

    # 5. Save Model Artifact
    model_artifact_path = os.path.join(artifacts_dir, "model.joblib")
    joblib.dump(xgb, model_artifact_path)
    print(f"\n[Training] Model artifact saved to: {model_artifact_path}")

    # 6. Save Metadata
    metadata = {
        "model_version": MODEL_VERSION,
        "algorithm": "XGBClassifier",
        "created_at": datetime.utcnow().isoformat() + "Z",
        "random_seed": random_seed,
        "feature_names": feature_names,
        "hyperparameters": {
            "n_estimators": n_estimators,
            "max_depth": max_depth,
            "learning_rate": learning_rate,
            "subsample": 0.85,
            "colsample_bytree": 0.85,
            "best_iteration": int(xgb.best_iteration),
        },
        "training_dataset": {
            "num_train_samples": int(len(X_train)),
            "num_val_samples": int(len(X_val)),
            "train_recovery_rate": float(y_train.mean()),
            "val_recovery_rate": float(y_val.mean()),
        },
        "validation_metrics": {
            "roc_auc": val_auc,
            "accuracy": val_acc,
            "log_loss": val_logloss,
        },
    }

    metadata_path = os.path.join(artifacts_dir, "metadata.json")
    with open(metadata_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)
    print(f"[Training] Metadata saved to: {metadata_path}")

    return xgb, metadata


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train RecoverIQ XGBoost recovery model")
    parser.add_argument("--data-dir", type=str, default=None)
    parser.add_argument("--artifacts-dir", type=str, default=None)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    train_model(
        data_dir=args.data_dir,
        artifacts_dir=args.artifacts_dir,
        random_seed=args.seed
    )
