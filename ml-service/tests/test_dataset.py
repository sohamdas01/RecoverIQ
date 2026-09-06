import os
import pytest
import pandas as pd
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from preprocessing.features import preprocess_dataframe, FEATURE_COLUMNS


def test_dataset_generation_and_integrity():
    data_dir = os.path.join(os.path.dirname(__file__), "..", "data")
    dataset_file = os.path.join(data_dir, "dataset.csv")
    train_file = os.path.join(data_dir, "train.csv")
    val_file = os.path.join(data_dir, "val.csv")
    test_file = os.path.join(data_dir, "test.csv")

    assert os.path.exists(dataset_file), "dataset.csv must exist"
    assert os.path.exists(train_file), "train.csv must exist"
    assert os.path.exists(val_file), "val.csv must exist"
    assert os.path.exists(test_file), "test.csv must exist"

    df = pd.read_csv(dataset_file)
    assert len(df) == 15000
    assert "recovery_succeeded" in df.columns
    assert set(df["recovery_succeeded"].unique()).issubset({0, 1})
    assert df.isnull().sum().sum() == 0, "Dataset must not contain NaN values"

    # Preprocessing test on dataset sample
    sample_df = df.head(100)
    processed_sample = preprocess_dataframe(sample_df)
    assert processed_sample.shape == (100, len(FEATURE_COLUMNS))
    assert list(processed_sample.columns) == FEATURE_COLUMNS
