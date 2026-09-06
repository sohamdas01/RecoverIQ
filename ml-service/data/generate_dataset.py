"""
RecoverIQ ML Service — Synthetic Recovery Dataset Generator
------------------------------------------------------------
Generates realistic, learnable payment recovery events with documented domain assumptions:
  1. Transient network/bank glitches have high natural recovery rates.
  2. Insufficient funds recovery is modulated by salary windows (month-end / month-start) & banking hours.
  3. Hard declines (card expired) and high risk fraud have low recovery likelihood.
  4. Strong customer payment history & past recovery successes increase recovery probability.
  5. Repeated retry attempts suffer from diminishing returns (decay).
  6. High transaction values introduce authorization friction.
  7. Stochastic noise prevents single-feature determinism.

Outputs:
  - data/dataset.csv (Full raw dataset with ground truth target)
  - data/train.csv, data/val.csv, data/test.csv (Splits)
"""

import os
import sys
import argparse
import numpy as np
import pandas as pd

# Add parent directory to sys.path for preprocessing import
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from preprocessing.features import (
    SUPPORTED_PAYMENT_METHODS,
    SUPPORTED_FAILURE_REASONS,
)


def sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def generate_synthetic_dataset(
    num_samples: int = 15000,
    random_seed: int = 42,
    output_dir: str = None
) -> pd.DataFrame:
    if output_dir is None:
        output_dir = os.path.dirname(os.path.abspath(__file__))

    os.makedirs(output_dir, exist_ok=True)
    rng = np.random.default_rng(random_seed)

    print(f"[Dataset Generator] Generating {num_samples} realistic payment recovery cases (seed={random_seed})...")

    # 1. Sample Payment Methods with realistic distribution
    payment_method_weights = [0.45, 0.35, 0.08, 0.12]  # card, upi, netbanking, subscription_mandate
    payment_methods = rng.choice(SUPPORTED_PAYMENT_METHODS, size=num_samples, p=payment_method_weights)

    # 2. Sample Failure Reasons
    failure_reason_weights = [
        0.35,  # insufficient_funds
        0.20,  # card_expired
        0.15,  # bank_outage
        0.15,  # network_timeout
        0.10,  # authentication_failed
        0.05,  # high_risk_fraud
    ]
    failure_reasons = rng.choice(SUPPORTED_FAILURE_REASONS, size=num_samples, p=failure_reason_weights)

    # 3. Sample Transaction Amounts (Log-normal distribution in INR)
    # Median ~ ₹2,500, with tail up to ₹120,000
    raw_amounts = rng.lognormal(mean=7.8, sigma=0.9, size=num_samples)
    amounts = np.clip(np.round(raw_amounts, 2), a_min=99.0, a_max=150000.0)

    # 4. Attempt Counts: 1 (60%), 2 (25%), 3 (10%), 4+ (5%)
    attempt_probs = [0.60, 0.25, 0.10, 0.04, 0.01]
    attempt_counts = rng.choice([1, 2, 3, 4, 5], size=num_samples, p=attempt_probs)

    # 5. Days Since Failure (0 to 14 days, skewed towards 0-3 days)
    days_since_failure = np.round(rng.exponential(scale=2.5, size=num_samples), 1)
    days_since_failure = np.clip(days_since_failure, 0.0, 14.0)

    # 6. Day of Month (1 to 31) & Hour of Day (0 to 23)
    day_of_month = rng.integers(1, 32, size=num_samples)
    # Peak activity around 10:00-14:00 and 18:00-21:00
    hour_probs = np.array([
        0.01, 0.01, 0.01, 0.01, 0.01, 0.01,  # 00-05
        0.02, 0.03, 0.05, 0.07, 0.09, 0.09,  # 06-11
        0.08, 0.07, 0.06, 0.06, 0.06, 0.07,  # 12-17
        0.08, 0.06, 0.05, 0.03, 0.02, 0.01   # 18-23
    ])
    hour_probs = hour_probs / hour_probs.sum()
    hour_of_day = rng.choice(np.arange(24), size=num_samples, p=hour_probs)

    # 7. Customer Historical Profile
    # Previous successful payments (0 to 40)
    prev_successes = rng.negative_binomial(n=3, p=0.3, size=num_samples)
    # Previous failed payments (0 to 8)
    prev_failures = rng.poisson(lam=0.8, size=num_samples)

    # Previous recovery success (correlated with high customer tenure)
    has_prior_recovery = (prev_successes > 3) & (rng.random(size=num_samples) < 0.65)
    previous_recovery_success = has_prior_recovery.astype(bool)

    # Subscription status
    is_sub = (payment_methods == "subscription_mandate") | (rng.random(size=num_samples) < 0.25)

    # ---------------------------------------------------------
    # Realistic Propensity Function (Log-Odds z)
    # ---------------------------------------------------------
    # Baseline propensity
    z = np.zeros(num_samples, dtype=float)

    # 1. Failure Reason Effects
    for i in range(num_samples):
        reason = failure_reasons[i]
        method = payment_methods[i]
        amt = amounts[i]
        attempts = attempt_counts[i]
        days = days_since_failure[i]
        dom = day_of_month[i]
        hod = hour_of_day[i]
        succ = prev_successes[i]
        fail = prev_failures[i]
        rec_succ = previous_recovery_success[i]
        sub = is_sub[i]

        score = 0.0

        # Base reason effects
        if reason == "bank_outage":
            score += 1.4  # High recovery after bank recovery
        elif reason == "network_timeout":
            score += 1.2  # High recovery after gateway glitch
        elif reason == "authentication_failed":
            score += 0.3  # Friction, but customer can re-auth
        elif reason == "insufficient_funds":
            score -= 0.2  # Moderate baseline, highly dependent on timing
            # Salary window boost (Indian payrolls: 28th - 5th)
            if dom in [1, 2, 3, 4, 5, 27, 28, 29, 30, 31]:
                score += 1.1
            # Working hours boost
            if 9 <= hod <= 18:
                score += 0.3
        elif reason == "card_expired":
            score -= 1.3  # Hard decline without customer action
            if sub:
                score += 0.4  # Subscription users are more motivated to update card
        elif reason == "high_risk_fraud":
            score -= 3.8  # Almost impossible / dangerous to recover

        # Attempt count decay (Diminishing returns)
        if attempts == 1:
            score += 0.35
        elif attempts == 2:
            score -= 0.20
        elif attempts >= 3:
            score -= 0.90 * (attempts - 2)

        # Time decay
        if days <= 1.0:
            score += 0.3
        elif days > 5.0:
            score -= 0.15 * (days - 5.0)

        # Customer History Effect
        total_hist = succ + fail
        hist_rate = (succ + 1.0) / (total_hist + 2.0)
        score += 2.0 * (hist_rate - 0.5)

        if rec_succ:
            score += 0.5
        if fail >= 3:
            score -= 0.6

        # Amount friction (High tickets have higher drop-off)
        if amt < 2000.0:
            score += 0.35
        elif amt > 25000.0:
            score -= 0.55
        elif amt > 60000.0:
            score -= 1.0

        # Payment method nuances
        if method == "upi":
            score += 0.25  # Fast frictionless re-try
        elif method == "subscription_mandate":
            score += 0.35  # Automated mandate re-execution

        # Add Gaussian stochastic noise (simulates unobserved real-world variability)
        noise = rng.normal(loc=0.0, scale=0.6)
        z[i] = score + noise

    # Calculate true latent recovery probability
    true_probabilities = sigmoid(z)

    # Sample binary outcome target (1 = Recovered, 0 = Failed)
    uniform_draw = rng.random(size=num_samples)
    recovery_succeeded = (uniform_draw < true_probabilities).astype(int)

    df = pd.DataFrame({
        "amount": amounts,
        "payment_method": payment_methods,
        "failure_reason": failure_reasons,
        "attempt_count": attempt_counts,
        "days_since_failure": days_since_failure,
        "day_of_month": day_of_month,
        "hour_of_day": hour_of_day,
        "previous_successes": prev_successes,
        "previous_failures": prev_failures,
        "previous_recovery_success": previous_recovery_success,
        "is_subscription": is_sub.astype(int),
        "recovery_succeeded": recovery_succeeded,
    })

    print(f"[Dataset Generator] Summary Statistics:")
    print(f"  - Total cases: {len(df):,}")
    print(f"  - Overall Recovery Success Rate: {df['recovery_succeeded'].mean():.2%}")
    print(f"  - Success rate by failure reason:")
    for reason, group in df.groupby("failure_reason"):
        print(f"      * {reason:25s}: {group['recovery_succeeded'].mean():.2%} ({len(group)} cases)")

    # Save full dataset
    dataset_path = os.path.join(output_dir, "dataset.csv")
    df.to_csv(dataset_path, index=False)
    print(f"  - Saved master dataset to {dataset_path}")

    # Create reproducible splits: 70% Train, 15% Validation, 15% Holdout Test
    shuffled_idx = rng.permutation(len(df))
    n_train = int(0.70 * len(df))
    n_val = int(0.15 * len(df))

    train_df = df.iloc[shuffled_idx[:n_train]]
    val_df = df.iloc[shuffled_idx[n_train:n_train + n_val]]
    test_df = df.iloc[shuffled_idx[n_train + n_val:]]

    train_df.to_csv(os.path.join(output_dir, "train.csv"), index=False)
    val_df.to_csv(os.path.join(output_dir, "val.csv"), index=False)
    test_df.to_csv(os.path.join(output_dir, "test.csv"), index=False)

    print(f"  - Train split: {len(train_df):,} cases ({train_df['recovery_succeeded'].mean():.2%} recovery rate)")
    print(f"  - Validation split: {len(val_df):,} cases ({val_df['recovery_succeeded'].mean():.2%} recovery rate)")
    print(f"  - Holdout Test split: {len(test_df):,} cases ({test_df['recovery_succeeded'].mean():.2%} recovery rate)")

    return df


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate synthetic payment recovery dataset")
    parser.add_argument("--samples", type=int, default=15000, help="Number of records to generate")
    parser.add_argument("--seed", type=int, default=42, help="Random seed for reproducibility")
    parser.add_argument("--output-dir", type=str, default=None, help="Output directory path")
    args = parser.parse_args()

    generate_synthetic_dataset(
        num_samples=args.samples,
        random_seed=args.seed,
        output_dir=args.output_dir
    )
