# RecoverIQ ML Service — Payment Recovery Probability & Explainability

The **RecoverIQ ML Service** is an internal prediction and explainability engine that estimates the likelihood ($0.0 \dots 1.0$) that a failed payment or subscription event can be successfully recovered, accompanied by human-readable SHAP reason codes.

---

## 🏛️ Architectural Principles (Phase 3)

1. **Prediction Only (No Autonomous Execution)**: The ML service predicts recovery propensity only. It never decides or triggers money/payment actions.
2. **Single Source of Truth Preprocessing (`preprocessing/features.py`)**: Reused identically across offline dataset generation, training, holdout evaluation, and real-time inference to guarantee **zero training-serving skew**.
3. **Offline Training vs. Online Inference**: Training is an offline batched pipeline; the live FastAPI service loads static serialized model artifacts (`model.joblib`) into memory on boot.
4. **Isolated Microservice**: Internal-only HTTP service; PostgreSQL remains owned exclusively by the backend.

---

## 📊 Dataset & Features

### Feature Schema (21 Canonical Preprocessed Features)

| Feature | Type | Source & Description |
| :--- | :--- | :--- |
| `log_amount` | Numerical | Natural log transform: $\ln(1 + \text{amount})$ |
| `attempt_count` | Numerical | Number of recovery attempts (1, 2, 3...) |
| `days_since_failure` | Numerical | Elapsed days since initial decline event |
| `previous_successes` | Numerical | Customer historical count of successful payments |
| `previous_failures` | Numerical | Customer historical count of failed payments |
| `previous_recovery_success` | Binary | Customer previously recovered a failed payment |
| `is_subscription` | Binary | Recurring mandate subscription intent |
| `total_history` | Derived | $\text{previous\_successes} + \text{previous\_failures}$ |
| `historical_success_rate` | Derived | Laplace smoothed success rate: $\frac{\text{prev\_successes} + 1}{\text{total\_history} + 2}$ |
| `is_salary_window` | Binary | Calendar day $\in [1\dots5, 27\dots31]$ (Salary disbursement cycle) |
| `is_business_hours` | Binary | Hour of day $\in [9\dots18]$ (Active banking settlement window) |
| `payment_method_*` | One-Hot | `card`, `upi`, `netbanking`, `subscription_mandate` |
| `failure_reason_*` | One-Hot | `insufficient_funds`, `card_expired`, `bank_outage`, `network_timeout`, `authentication_failed`, `high_risk_fraud` |

### Target Variable
- **`recovery_succeeded`**: `1` = Recovery succeeded, `0` = Recovery failed.

### Domain Mechanics & Assumptions
- **Transient Infrastructure Failures** (`bank_outage`, `network_timeout`): High natural recovery likelihood (~88–90%) upon immediate re-capture.
- **Insufficient Funds**: Moderate baseline, heavily modulated by **salary deposit windows** (+1.1 log-odds) and banking hours.
- **Hard Declines** (`card_expired`): Low automated retry probability (~47%); requires customer-facing self-service credentials update.
- **High-Risk Fraud**: Suppressed recovery rate (<8%); flagged for operational block.
- **Attempt Decay**: Diminishing recovery probability as automated retry attempts increase.

---

## 📈 Model Architecture & Evaluation Metrics

- **Algorithm**: `XGBClassifier` (Tree-based Gradient Boosted Trees)
- **Hyperparameters**: `n_estimators=150`, `max_depth=4`, `learning_rate=0.08`, `subsample=0.85`, `colsample_bytree=0.85`
- **Evaluation Dataset**: 2,250 untouched holdout test samples (`data/test.csv`)

### Holdout Performance
- **ROC-AUC Score**: `0.8172`
- **Accuracy**: `79.64%`
- **Precision**: `81.19%`
- **Recall**: `93.18%`
- **F1-Score**: `0.8677`
- **Brier Score Loss**: `0.1426` (monotonic probability calibration)

### ⚔️ Strategy Comparison: Naive Baseline vs. Model-Guided

| Metric | Naive Baseline ("Always Attempt") | Model-Guided Policy ($P \ge 0.50$) | Impact |
| :--- | :--- | :--- | :--- |
| **Attempts Made** | 2,250 | 1,850 | **400 futile attempts avoided** |
| **Recovered Count** | 1,612 | 1,502 | 93.2% recovery retention |
| **Attempt Precision** | 71.64% | **81.19%** | **+9.55% precision gain** |
| **Operational Fees Saved** | ₹0.00 | **₹6,000.00** | Reduced retry & gateway fees |

---

## 🧠 SHAP Explainability & Reason Codes

The service uses `shap.TreeExplainer` to map feature attributions into human-readable domain reason codes:

- **Positive Drivers**:
  - `transient_bank_outage`: Transient banking network glitch
  - `transient_network_timeout`: Gateway socket timeout
  - `strong_payment_history`: Solid customer payment track record
  - `low_retry_count`: Early retry attempt
  - `salary_window_active`: Aligned with month-end/start salary cycle
  - `frictionless_upi_channel`: UPI instant authorization rails
- **Negative Risk Drivers**:
  - `high_risk_fraud_flagged`: Fraud indicators present
  - `hard_decline_expired_card`: Expired card token
  - `retry_attempts_exhausted`: Multi-attempt failure exhaustion
  - `poor_payment_history`: Chronic customer decline history
  - `insufficient_funds_off_cycle`: Balance deficit outside salary window

---

## 🔌 API Reference

### `GET /health`
Readiness and model health check.
```json
{
  "status": "healthy",
  "service": "recoveriq-ml-service",
  "model_version": "v1.0.0",
  "model_loaded": true
}
```

### `POST /predict`
Scores recovery likelihood and outputs SHAP reason codes.

#### Request:
```json
{
  "amount": 1499.0,
  "payment_method": "card",
  "failure_reason": "insufficient_funds",
  "attempt_count": 1,
  "days_since_failure": 0.0,
  "day_of_month": 1,
  "hour_of_day": 10,
  "previous_successes": 8,
  "previous_failures": 1,
  "previous_recovery_success": true
}
```

#### Response:
```json
{
  "probability": 0.8124,
  "reason_codes": [
    "strong_payment_history",
    "salary_window_active",
    "low_retry_count"
  ],
  "model_version": "v1.0.0",
  "attributions": [
    {
      "feature": "historical_success_rate",
      "code": "strong_payment_history",
      "description": "Customer has a solid historical record of successful payments",
      "impact": "positive",
      "shap_value": 0.4512
    }
  ]
}
```

---

## 🛠️ Developer Workflow

### 1. Install Dependencies
```bash
pip install -r requirements.txt
```

### 2. Generate Synthetic Dataset
```bash
python data/generate_dataset.py --samples 15000 --seed 42
```

### 3. Train XGBoost Model
```bash
python training/train.py --seed 42
```

### 4. Evaluate Model on Holdout Set
```bash
python training/evaluate.py --threshold 0.50
```

### 5. Run Test Suite
```bash
python -m pytest tests/ -v
```

### 6. Start Live Inference Service
```bash
python main.py
# Runs on http://0.0.0.0:8000
```
