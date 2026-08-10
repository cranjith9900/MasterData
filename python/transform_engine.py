import json
import sys

import pandas as pd


def transform(input_csv_path, config_path, output_csv_path):
    with open(config_path, "r", encoding="utf-8-sig") as config_file:
        config = json.load(config_file)

    target_headers = config.get("targetHeaders") or []
    column_map = config.get("columnMap") or {}
    default_values = config.get("defaultValues") or {}
    duplicate_keys = config.get("duplicateKeys") or []
    transformations = config.get("transformations") or {}

    df = pd.read_csv(input_csv_path, dtype=str).fillna("")

    slice_config = transformations.get("sliceColumn") or {}
    slice_targets = []
    if slice_config.get("enabled"):
        column = slice_config.get("column")
        if column in df.columns:
            max_length = int(df[column].astype(str).str.len().max() or 0)
            for slice_item in slice_config.get("slices") or []:
                target = (slice_item.get("target") or "").strip()
                if not target:
                    continue

                start = int(slice_item.get("start") or 0)
                start = min(max(start, 0), max_length)
                end_value = slice_item.get("end")
                end = int(end_value) if end_value not in (None, "") else None
                if end is not None:
                    end = min(max(end, start), max_length)
                df[target] = df[column].astype(str).str.slice(start, end)
                slice_targets.append(target)

    concat_config = transformations.get("concatenate") or {}
    concat_target = ""
    if concat_config.get("enabled"):
        concat_columns = [
            column
            for column in concat_config.get("columns") or []
            if column in df.columns
        ]
        concat_target = (concat_config.get("outputColumn") or "").strip()

        if concat_columns and concat_target:
            separator = concat_config.get("separator") or ""
            prefix = concat_config.get("prefix") or ""
            suffix = concat_config.get("suffix") or ""
            combined = df[concat_columns].astype(str).agg(separator.join, axis=1)
            df[concat_target] = prefix + combined + suffix

    if not target_headers:
        target_headers = list(df.columns)
        for target in slice_targets:
            if target not in target_headers:
                target_headers.append(target)
        if concat_target and concat_target not in target_headers:
            target_headers.append(concat_target)
    else:
        for target in slice_targets:
            if target not in target_headers:
                target_headers.append(target)
        if concat_target and concat_target not in target_headers:
            target_headers.append(concat_target)

    df_mapped = pd.DataFrame()
    for target_col in target_headers:
        source_col = column_map.get(target_col, target_col)

        if source_col in df.columns:
            df_mapped[target_col] = df[source_col]
        else:
            df_mapped[target_col] = default_values.get(target_col, "")

    if duplicate_keys and all(key in df_mapped.columns for key in duplicate_keys):
        df_mapped = df_mapped.drop_duplicates(subset=duplicate_keys, keep="first")

    df_mapped.to_csv(output_csv_path, index=False)

    return {
        "rows": len(df_mapped),
        "columns": list(df_mapped.columns),
        "output": output_csv_path,
    }


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit(
            "Usage: python transform_engine.py <input_csv> <config_json> <output_csv>"
        )

    result = transform(sys.argv[1], sys.argv[2], sys.argv[3])
    print(json.dumps(result))
