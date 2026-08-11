import React, { useMemo, useState } from "react";
import { Bot, Check, Copy, Download, FileUp, ListChecks, Play, Plus, RotateCcw, Send, Trash2 } from "lucide-react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const API_BASE = "http://localhost:4000";

function parseCsvHeaders(text) {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim());
  if (!firstLine) return [];

  const headers = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < firstLine.length; index += 1) {
    const character = firstLine[index];
    const nextCharacter = firstLine[index + 1];

    if (character === '"' && quoted && nextCharacter === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (character === '"') {
      quoted = !quoted;
      continue;
    }

    if (character === "," && !quoted) {
      headers.push(current.trim());
      current = "";
      continue;
    }

    current += character;
  }

  headers.push(current.trim());
  return headers.filter(Boolean);
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const nextCharacter = line[index + 1];

    if (character === '"' && quoted && nextCharacter === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (character === '"') {
      quoted = !quoted;
      continue;
    }

    if (character === "," && !quoted) {
      values.push(current);
      current = "";
      continue;
    }

    current += character;
  }

  values.push(current);
  return values;
}

function getColumnMaxLengths(text, headers) {
  const maxLengths = Object.fromEntries(headers.map((header) => [header, 0]));
  const lines = text.split(/\r?\n/).filter((line) => line.trim());

  lines.slice(1).forEach((line) => {
    const values = parseCsvLine(line);
    headers.forEach((header, index) => {
      maxLengths[header] = Math.max(maxLengths[header] || 0, String(values[index] || "").length);
    });
  });

  return maxLengths;
}

function flattenJsonValue(value, prefix = "", target = {}) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      target[prefix] = "";
      return target;
    }

    value.forEach((item, index) => {
      flattenJsonValue(item, prefix ? `${prefix}.${index}` : String(index), target);
    });
    return target;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0 && prefix) {
      target[prefix] = "";
      return target;
    }

    entries.forEach(([key, child]) => {
      flattenJsonValue(child, prefix ? `${prefix}.${key}` : key, target);
    });
    return target;
  }

  target[prefix || "value"] = value === null || value === undefined ? "" : value;
  return target;
}

function buildMappedCsv(sourceRows, mappings) {
  const activeMappings = mappings
    .map((mapping) => ({
      target: String(mapping.target || "").trim(),
      source: String(mapping.source || "").trim()
    }))
    .filter((mapping) => mapping.target);

  const headers = [...new Set(activeMappings.map((mapping) => mapping.target))];
  const rows = sourceRows.map((row) => {
    const mappedRow = {};
    activeMappings.forEach((mapping) => {
      mappedRow[mapping.target] = row[mapping.source] ?? "";
    });
    return mappedRow;
  });

  const csv = [
    headers.map((header) => `"${String(header).replace(/"/g, '""')}"`).join(","),
    ...rows.map((row) =>
      headers
        .map((header) => {
          const value = row[header];
          const textValue = value === null || value === undefined ? "" : String(value);
          return /[",\r\n]/.test(textValue)
            ? `"${textValue.replace(/"/g, '""')}"`
            : textValue;
        })
        .join(",")
    )
  ].join("\n");

  return { headers, rows, csv };
}

function buildJsonWorkatoCode(mappings) {
  const activeMappings = mappings
    .map((mapping) => ({
      target: String(mapping.target || "").trim(),
      source: String(mapping.source || "").trim()
    }))
    .filter((mapping) => mapping.target && mapping.source);

  const columnMapping = Object.fromEntries(
    activeMappings.map((mapping) => [mapping.target, mapping.source])
  );

  return `import csv
import io
import json


def main(input_data):

    # Get JSON input from Workato
    raw_input = input_data.get("input", [])

    # If Workato sends JSON as a string, parse it
    if isinstance(raw_input, str):
        raw_input = json.loads(raw_input)

    # Convert single object to list
    if isinstance(raw_input, dict):
        suppliers = [raw_input]
    elif isinstance(raw_input, list):
        suppliers = raw_input
    else:
        raise ValueError("Input must be a JSON object or JSON array")

    # Final CSV columns and their source JSON fields
    column_mapping = ${JSON.stringify(columnMapping, null, 4)}

    # Create CSV
    output = io.StringIO()

    writer = csv.DictWriter(
        output,
        fieldnames=list(column_mapping.keys()),
        lineterminator="\\n"
    )

    writer.writeheader()

    # Transform suppliers
    for supplier in suppliers:

        if not isinstance(supplier, dict):
            continue

        # Skip objects such as {"count": 6}
        if "Supplier Name" not in supplier and "SM Vendor ID" not in supplier:
            continue

        row = {}

        for target_column, source_column in column_mapping.items():

            value = supplier.get(source_column, "")

            # Convert JSON null to blank
            if value is None:
                value = ""

            row[target_column] = value

        writer.writerow(row)

    csv_output = output.getvalue()
    output.close()

    return {
        "csv": csv_output
    }`;
}

function extractJsonColumns(text) {
  const parsed = JSON.parse(text);
  const sourceRows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.data)
      ? parsed.data
      : Array.isArray(parsed?.items)
        ? parsed.items
        : Array.isArray(parsed?.records)
          ? parsed.records
          : parsed && typeof parsed === "object"
            ? [parsed]
            : [];

  const flattenedRows = sourceRows.map((row) => flattenJsonValue(row));
  const sourceColumns = [...new Set(flattenedRows.flatMap((row) => Object.keys(row)))];
  return { sourceRows, flattenedRows, sourceColumns };
}

function jsonToCsv(text) {
  const parsed = JSON.parse(text);
  const sourceRows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.data)
      ? parsed.data
      : Array.isArray(parsed?.items)
        ? parsed.items
        : Array.isArray(parsed?.records)
          ? parsed.records
          : parsed && typeof parsed === "object"
            ? [parsed]
            : [];

  const flattenedRows = sourceRows.map((row) => flattenJsonValue(row));
  const headers = [...new Set(flattenedRows.flatMap((row) => Object.keys(row)))];

  if (!headers.length) {
    return { headers: [], rows: [], csv: "" };
  }

  const csv = [
    headers.map((header) => `"${String(header).replace(/"/g, '""')}"`).join(","),
    ...flattenedRows.map((row) =>
      headers
        .map((header) => {
          const value = row[header];
          const textValue = value === null || value === undefined ? "" : String(value);
          return /[",\r\n]/.test(textValue)
            ? `"${textValue.replace(/"/g, '""')}"`
            : textValue;
        })
        .join(",")
    )
  ].join("\n");

  return { headers, rows: flattenedRows, csv };
}

function buildWorkatoCode(config) {
  const hasExplicitMapping = config.targetHeaders.some((target) => {
    const source = config.columnMap[target] || "";
    return source && source !== target;
  });

  if (!hasExplicitMapping) {
    return `import pandas as pd
import io

def main(input_data):
    raw_csv = input_data["input"]
    df = pd.read_csv(
        io.StringIO(raw_csv),
        sep=",",
        quotechar='"',
        dtype=str
    )

    columns_to_check_for_missing_data = ${JSON.stringify(config.duplicateKeys.length ? config.duplicateKeys : config.targetHeaders.slice(0, 2), null, 4)}
    lookup_keys = ${JSON.stringify(config.duplicateKeys, null, 4)}

    errors = []

    # Step 1: Check missing columns
    missing_columns = [
        col for col in columns_to_check_for_missing_data
        if col not in df.columns
    ]
    if missing_columns:
        errors.append(f"Missing required column(s): {', '.join(missing_columns)}")

    # Step 2: Check missing values
    missing_data = {}
    for col in columns_to_check_for_missing_data:
        if col in df.columns:
            missing_rows = df[df[col].isna()].index.tolist()
            if missing_rows:
                missing_data[col] = [row + 1 for row in missing_rows]

    transformations = ${JSON.stringify(config.transformations, null, 4)}

    slice_config = transformations.get("sliceColumn", {})
    if slice_config.get("enabled"):
        source_col = slice_config.get("column", "")
        if source_col in df.columns:
            max_length = int(df[source_col].astype(str).str.len().max() or 0)
            for slice_item in slice_config.get("slices", []):
                target_col = str(slice_item.get("target", "")).strip()
                if not target_col:
                    continue
                start = min(max(int(slice_item.get("start") or 0), 0), max_length)
                end_value = slice_item.get("end")
                end = int(end_value) if end_value not in (None, "") else None
                if end is not None:
                    end = min(max(end, start), max_length)
                df[target_col] = df[source_col].astype(str).str.slice(start, end)

    concat_config = transformations.get("concatenate", {})
    if concat_config.get("enabled"):
        concat_cols = [col for col in concat_config.get("columns", []) if col in df.columns]
        output_col = str(concat_config.get("outputColumn", "")).strip()
        if concat_cols and output_col:
            separator = concat_config.get("separator", "") or ""
            prefix = concat_config.get("prefix", "") or ""
            suffix = concat_config.get("suffix", "") or ""
            combined = df[concat_cols].astype(str).agg(separator.join, axis=1)
            df[output_col] = prefix + combined + suffix

    # Step 4: Remove duplicates
    if lookup_keys and all(key in df.columns for key in lookup_keys):
        df["composite_key"] = df[lookup_keys].astype(str).agg("-".join, axis=1)
        duplicate_rows = df[df.duplicated("composite_key", keep="first")].index.tolist()
        duplicate_rows = [row + 1 for row in duplicate_rows]
        df = df.drop_duplicates(subset="composite_key", keep="first")
        df.drop(columns=["composite_key"], inplace=True)
    else:
        duplicate_rows = []

    # Step 8: CSV output
    csv_output = df.to_csv(index=False)

    # Step 9: Collect errors
    if missing_data:
        for col, rows in missing_data.items():
            errors.append(
                f"Column '{col}' has missing values in rows: {', '.join(map(str, rows))}"
            )

    if duplicate_rows:
        errors.append(
            f"Removed {len(duplicate_rows)} duplicate row(s) at rows: "
            f"{', '.join(map(str, duplicate_rows))} based on column(s): "
            f"{', '.join(lookup_keys)}"
        )

    return {
        "status": "error" if errors else "success",
        "errors": "\\n".join(errors),
        "csv_output": csv_output,
    }`;
  }

  return `import pandas as pd
import csv
import io
import json
from datetime import datetime

# Target headers for the final output
targetHeaders = ${JSON.stringify(config.targetHeaders, null, 4)}

# Mapping from source to target columns
column_map = ${JSON.stringify(config.columnMap, null, 4)}

# Default values for target columns
default_values = ${JSON.stringify(config.defaultValues, null, 4)}

# Duplicate check columns
duplicate_keys = ${JSON.stringify(config.duplicateKeys, null, 4)}

# Optional transformations selected in the UI
transformations = ${JSON.stringify(config.transformations, null, 4)}

def apply_transformations(df):
    slice_config = transformations.get("sliceColumn", {})
    if slice_config.get("enabled"):
        source_col = slice_config.get("column", "")
        if source_col in df.columns:
            max_length = int(df[source_col].astype(str).str.len().max() or 0)
            for slice_item in slice_config.get("slices", []):
                target_col = str(slice_item.get("target", "")).strip()
                if not target_col:
                    continue
                start = min(max(int(slice_item.get("start") or 0), 0), max_length)
                end_value = slice_item.get("end")
                end = int(end_value) if end_value not in (None, "") else None
                if end is not None:
                    end = min(max(end, start), max_length)
                df[target_col] = df[source_col].astype(str).str.slice(start, end)

    concat_config = transformations.get("concatenate", {})
    if concat_config.get("enabled"):
        concat_cols = [col for col in concat_config.get("columns", []) if col in df.columns]
        output_col = str(concat_config.get("outputColumn", "")).strip()
        if concat_cols and output_col:
            separator = concat_config.get("separator", "") or ""
            prefix = concat_config.get("prefix", "") or ""
            suffix = concat_config.get("suffix", "") or ""
            combined = df[concat_cols].astype(str).agg(separator.join, axis=1)
            df[output_col] = prefix + combined + suffix

    return df

def main(input_data):
    csv_file = input_data["input"]
    df = pd.read_csv(io.StringIO(csv_file), sep=",", dtype=str).fillna("")
    df = apply_transformations(df)

    df_mapped = pd.DataFrame()

    # Map columns from source to target
    for target_col in targetHeaders:
        if target_col in column_map and column_map[target_col] in df.columns:
            df_mapped[target_col] = df[column_map[target_col]]
        elif target_col in df.columns:
            df_mapped[target_col] = df[target_col]
        else:
            df_mapped[target_col] = default_values.get(target_col, "")

    df_mapped = df_mapped.fillna("")

    if duplicate_keys and all(key in df_mapped.columns for key in duplicate_keys):
        df_mapped = df_mapped.drop_duplicates(subset=duplicate_keys, keep="first")

    current_timestamp = datetime.now().isoformat()
    if "updated_at" in df_mapped.columns:
        df_mapped["updated_at"] = current_timestamp

    records = df_mapped.to_dict(orient="records")
    return {"json_output": records}`;
}

function App() {
  const [workspaceTab, setWorkspaceTab] = useState("home");
  const [csvFiles, setCsvFiles] = useState([]);
  const [headers, setHeaders] = useState([]);
  const [columnMaxLengths, setColumnMaxLengths] = useState({});
  const [rows, setRows] = useState([
    { target: "code", source: "Source Column A", defaultValue: "" },
    { target: "name", source: "Source Column B", defaultValue: "" },
    { target: "active", source: "", defaultValue: "true" }
  ]);
  const [enableMapping, setEnableMapping] = useState(false);
  const [duplicateKeys, setDuplicateKeys] = useState([]);
  const [transformations, setTransformations] = useState({
    sliceColumn: {
      enabled: false,
      column: "",
      slices: [{ target: "", start: "0", end: "" }]
    },
    dedupe: { enabled: false },
    concatenate: {
      enabled: false,
      columns: [],
      separator: "",
      prefix: "",
      suffix: "",
      outputMode: "new",
      outputColumn: ""
    }
  });
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const [downloads, setDownloads] = useState([]);
  const [copied, setCopied] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiStatus, setAiStatus] = useState("idle");
  const [aiMessage, setAiMessage] = useState("");
  const [improvedCode, setImprovedCode] = useState("");
  const [isCodeRemoved, setIsCodeRemoved] = useState(false);
  const [runOutputType, setRunOutputType] = useState("csv");
  const [runStatus, setRunStatus] = useState("idle");
  const [runMessage, setRunMessage] = useState("");
  const [runResult, setRunResult] = useState(null);
  const [runLogs, setRunLogs] = useState({ stdout: "", stderr: "" });
  const [chatMessages, setChatMessages] = useState([
    {
      role: "assistant",
      content: "Ask me about the generated Workato Python code, mappings, transformations, or how to change the output."
    }
  ]);
  const [jsonFile, setJsonFile] = useState(null);
  const [jsonSourceText, setJsonSourceText] = useState("");
  const [jsonPreviewHeaders, setJsonPreviewHeaders] = useState([]);
  const [jsonPreviewRows, setJsonPreviewRows] = useState([]);
  const [jsonStatus, setJsonStatus] = useState("idle");
  const [jsonMessage, setJsonMessage] = useState("");
  const [jsonFileName, setJsonFileName] = useState("");
  const [jsonMappings, setJsonMappings] = useState([
    { source: "code", target: "ORO Code" },
    { source: "name", target: "ORO Name" }
  ]);
  const [jsonExportCsv, setJsonExportCsv] = useState("");
  const jsonWorkatoCode = useMemo(() => buildJsonWorkatoCode(jsonMappings), [jsonMappings]);

  const selectedFileNames = csvFiles.map((file) => file.name).join(", ");
  const generatedSliceHeaders = transformations.sliceColumn.slices
    .map((slice) => slice.target.trim())
    .filter(Boolean);
  const generatedConcatHeaders =
    transformations.concatenate.enabled &&
    transformations.concatenate.outputMode === "new" &&
    transformations.concatenate.outputColumn.trim()
      ? [transformations.concatenate.outputColumn.trim()]
      : [];
  const availableHeaders = [...new Set([...headers, ...generatedSliceHeaders, ...generatedConcatHeaders])];
  const selectedSliceMaxLength = columnMaxLengths[transformations.sliceColumn.column] || "";

  const config = useMemo(() => {
    const mappedTargetHeaders = enableMapping
      ? rows.map((row) => row.target.trim()).filter(Boolean)
      : [];
    const targetHeaders = [...new Set([...mappedTargetHeaders, ...generatedSliceHeaders, ...generatedConcatHeaders])];
    const columnMap = {};
    const defaultValues = {};

    if (enableMapping) {
      rows.forEach((row) => {
        if (!row.target.trim()) return;
        columnMap[row.target.trim()] = row.source.trim();
        if (row.defaultValue !== "") {
          defaultValues[row.target.trim()] = row.defaultValue;
        }
      });
    }

    return {
      targetHeaders,
      columnMap,
      defaultValues,
      duplicateKeys: transformations.dedupe.enabled ? duplicateKeys : [],
      transformations
    };
  }, [rows, duplicateKeys, transformations, generatedSliceHeaders, generatedConcatHeaders, enableMapping]);

  const workatoCode = useMemo(() => buildWorkatoCode(config), [config]);
  const displayedCode = isCodeRemoved ? "" : improvedCode || workatoCode;
  const workatoConfig = useMemo(() => JSON.stringify(config, null, 2), [config]);

  async function copyWorkatoCode() {
    if (!displayedCode) return;

    await navigator.clipboard.writeText(displayedCode);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  function removeCodeSnippet() {
    setImprovedCode("");
    setIsCodeRemoved(true);
    setCopied(false);
    setAiStatus("idle");
    setAiMessage("");
  }

  function restoreCodeSnippet() {
    setIsCodeRemoved(false);
  }

  async function improveWorkatoCode() {
    if (!aiInstruction.trim()) {
      setAiStatus("error");
      setAiMessage("Tell the assistant what to improve.");
      return;
    }

    if (!displayedCode) {
      setAiStatus("error");
      setAiMessage("Restore the code snippet before improving it.");
      return;
    }

    setAiStatus("loading");
    setAiMessage("");

    try {
      const response = await fetch(`${API_BASE}/api/improve-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: displayedCode,
          instruction: aiInstruction,
          config
        })
      });
      const responseText = await response.text();
      const data = responseText ? JSON.parse(responseText) : {};

      if (!response.ok) {
        throw new Error(data.detail || data.error || "Unable to improve code.");
      }

      setImprovedCode(data.code);
      setIsCodeRemoved(false);
      setAiStatus("success");
      setAiMessage("Code improved.");
    } catch (error) {
      setAiStatus("error");
      setAiMessage(error.message);
    }
  }

  function extractCodeBlock(content) {
    const match = content.match(/```(?:python)?\s*([\s\S]*?)```/i);
    return match ? match[1].trim() : "";
  }

  async function sendChatMessage() {
    const content = aiInstruction.trim();
    if (!content) return;

    const nextMessages = [...chatMessages, { role: "user", content }];
    setChatMessages(nextMessages);
    setAiInstruction("");
    setAiStatus("loading");
    setAiMessage("");

    try {
      const response = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages.map((message) => ({
            role: message.role,
            content: message.content
          })),
          code: displayedCode,
          config
        })
      });
      const responseText = await response.text();
      let data;
      try {
        data = responseText ? JSON.parse(responseText) : {};
      } catch {
        throw new Error("Chat API returned HTML instead of JSON. Restart npm run dev so Express loads the latest /api/chat route.");
      }

      if (!response.ok) {
        throw new Error(data.detail || data.error || "Unable to chat with Azure AI.");
      }

      const assistantMessage = data.message || "";
      setChatMessages((current) => [...current, { role: "assistant", content: assistantMessage }]);

      const returnedCode = extractCodeBlock(assistantMessage);
      if (returnedCode) {
        setImprovedCode(returnedCode);
        setIsCodeRemoved(false);
        setAiMessage("Updated code detected and applied to the code panel.");
      }

      setAiStatus("success");
    } catch (error) {
      setAiStatus("error");
      setAiMessage(error.message);
      setChatMessages((current) => [...current, { role: "assistant", content: error.message }]);
    }
  }

  async function runPythonCode() {
    setRunStatus("loading");
    setRunMessage("");
    setRunResult(null);
    setRunLogs({ stdout: "Running Python...", stderr: "" });

    if (!csvFiles[0]) {
      setRunStatus("error");
      setRunMessage("Choose a CSV file before running Python.");
      return;
    }

    if (!displayedCode) {
      setRunStatus("error");
      setRunMessage("Restore the code snippet before running Python.");
      return;
    }

    try {
      const formData = new FormData();
      formData.append("csv", csvFiles[0]);
      formData.append("code", displayedCode);
      formData.append("outputType", runOutputType);

      const response = await fetch(`${API_BASE}/api/run-python`, {
        method: "POST",
        body: formData
      });
      const data = await response.json();

      if (!response.ok) {
        setRunLogs(data.logs || { stdout: "", stderr: data.detail || data.error || "" });
        throw new Error(data.detail || data.error || "Unable to run Python.");
      }

      setRunResult({
        ...data,
        downloadUrl: `${API_BASE}${data.downloadUrl}`
      });
      setRunLogs(data.logs || { stdout: "", stderr: "" });
      setRunStatus("success");
      setRunMessage(`Python generated ${runOutputType.toUpperCase()} output.`);
    } catch (error) {
      setRunStatus("error");
      setRunMessage(error.message);
    }
  }

  async function handleFilesChange(event) {
    const nextFiles = Array.from(event.target.files || []);
    setCsvFiles(nextFiles);
    setDownloads([]);
    setMessage("");

    if (nextFiles.length === 0) {
      setHeaders([]);
      setColumnMaxLengths({});
      return;
    }

    await extractHeaders(nextFiles[0]);
  }

  async function extractHeaders(file = csvFiles[0]) {
    if (!file) {
      setStatus("error");
      setMessage("Choose a CSV file before extracting headers.");
      return;
    }

    try {
      const text = await file.text();
      const nextHeaders = parseCsvHeaders(text);

      if (nextHeaders.length === 0) {
        throw new Error("No headers found in the selected CSV.");
      }

      setHeaders(nextHeaders);
      setColumnMaxLengths(getColumnMaxLengths(text, nextHeaders));
      if (enableMapping) {
        setRows(nextHeaders.map((header) => ({ target: header, source: header, defaultValue: "" })));
      }
      setStatus("success");
      setMessage(`Extracted ${nextHeaders.length} header column${nextHeaders.length === 1 ? "" : "s"} from ${file.name}.`);
    } catch (error) {
      setStatus("error");
      setMessage(error.message);
    }
  }

  function updateRow(index, field, value) {
    setRows((current) =>
      current.map((row, rowIndex) =>
        rowIndex === index ? { ...row, [field]: value } : row
      )
    );
  }

  function addRow() {
    setRows((current) => [...current, { target: "", source: "", defaultValue: "" }]);
  }

  function removeRow(index) {
    setRows((current) => current.filter((_, rowIndex) => rowIndex !== index));
  }

  function updateTransformation(name, field, value) {
    setTransformations((current) => ({
      ...current,
      [name]: {
        ...current[name],
        [field]: value
      }
    }));
  }

  function toggleTransformation(name) {
    setTransformations((current) => ({
      ...current,
      [name]: {
        ...current[name],
        enabled: !current[name].enabled
      }
    }));
  }

  function toggleMapping() {
    setEnableMapping((current) => {
      const next = !current;
      if (next && headers.length > 0) {
        setRows(headers.map((header) => ({ target: header, source: header, defaultValue: "" })));
      }
      return next;
    });
  }

  function toggleDuplicateKey(column) {
    setDuplicateKeys((current) =>
      current.includes(column)
        ? current.filter((key) => key !== column)
        : [...current, column]
    );
  }

  function toggleConcatColumn(column) {
    setTransformations((current) => {
      const columns = current.concatenate.columns.includes(column)
        ? current.concatenate.columns.filter((key) => key !== column)
        : [...current.concatenate.columns, column];

      return {
        ...current,
        concatenate: {
          ...current.concatenate,
          columns
        }
      };
    });
  }

  function updateSlice(index, field, value) {
    const nextValue =
      field === "end" && selectedSliceMaxLength
        ? String(Math.min(Number(value || 0), selectedSliceMaxLength))
        : value;

    setTransformations((current) => ({
      ...current,
      sliceColumn: {
        ...current.sliceColumn,
        slices: current.sliceColumn.slices.map((slice, sliceIndex) =>
          sliceIndex === index ? { ...slice, [field]: nextValue } : slice
        )
      }
    }));
  }

  function addSlice() {
    setTransformations((current) => ({
      ...current,
      sliceColumn: {
        ...current.sliceColumn,
        slices: [...current.sliceColumn.slices, { target: "", start: "0", end: "" }]
      }
    }));
  }

  function removeSlice(index) {
    setTransformations((current) => ({
      ...current,
      sliceColumn: {
        ...current.sliceColumn,
        slices: current.sliceColumn.slices.filter((_, sliceIndex) => sliceIndex !== index)
      }
    }));
  }

  async function transformCsv(event) {
    event.preventDefault();
    setStatus("loading");
    setMessage("");
    setDownloads([]);

    if (csvFiles.length === 0) {
      setStatus("error");
      setMessage("Choose one or more CSV files first.");
      return;
    }

    try {
      const nextDownloads = [];

      for (const csvFile of csvFiles) {
        const formData = new FormData();
        formData.append("csv", csvFile);
        formData.append("config", JSON.stringify(config));

        const response = await fetch(`${API_BASE}/api/transform`, {
          method: "POST",
          body: formData
        });
        const data = await response.json();

        if (!response.ok) {
          throw new Error(`${csvFile.name}: ${data.detail || data.error || "Transformation failed."}`);
        }

        nextDownloads.push({
          fileName: csvFile.name,
          url: `${API_BASE}${data.downloadUrl}`
        });
      }

      setStatus("success");
      setMessage(`Transformation complete for ${nextDownloads.length} CSV file${nextDownloads.length === 1 ? "" : "s"}.`);
      setDownloads(nextDownloads);
    } catch (error) {
      setStatus("error");
      setMessage(error.message);
    }
  }

  async function handleJsonFileChange(event) {
    const file = (event.target.files || [])[0] || null;
      setJsonFile(file);
      setJsonStatus("idle");
      setJsonMessage("");
      setJsonPreviewHeaders([]);
      setJsonPreviewRows([]);
      setJsonFileName(file ? file.name : "");
      setJsonExportCsv("");

    if (!file) return;

    try {
      const text = await file.text();
      setJsonSourceText(text);
      const { sourceRows, flattenedRows, sourceColumns } = extractJsonColumns(text);
      setJsonMappings((current) => {
        const existingTargets = current.map((mapping) => mapping.target || "");
        return sourceColumns.map((source, index) => ({
          source,
          target: existingTargets[index] || source
        }));
      });
      setJsonPreviewHeaders(sourceColumns);
      setJsonPreviewRows(flattenedRows.slice(0, 5));
      setJsonStatus("success");
      setJsonMessage(`Extracted ${sourceColumns.length} source column${sourceColumns.length === 1 ? "" : "s"} from ${file.name}.`);
    } catch (error) {
      setJsonStatus("error");
      setJsonMessage(error.message || "Invalid JSON file.");
      setJsonExportCsv("");
    }
  }

  function downloadJsonCsv(csvText, fileName = "converted.csv") {
    const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function updateJsonMapping(index, field, value) {
    setJsonMappings((current) =>
      current.map((mapping, mappingIndex) =>
        mappingIndex === index ? { ...mapping, [field]: value } : mapping
      )
    );
  }

  function addJsonMapping() {
    setJsonMappings((current) => [...current, { source: "", target: "" }]);
  }

  function removeJsonMapping(index) {
    setJsonMappings((current) => current.filter((_, mappingIndex) => mappingIndex !== index));
  }

  function convertJsonToCsv() {
    if (!jsonSourceText.trim()) {
      setJsonStatus("error");
      setJsonMessage("Choose a JSON file first.");
      return;
    }

    try {
      const parsed = JSON.parse(jsonSourceText);
      const sourceRows = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.data)
          ? parsed.data
          : Array.isArray(parsed?.items)
            ? parsed.items
            : Array.isArray(parsed?.records)
              ? parsed.records
              : parsed && typeof parsed === "object"
                ? [parsed]
                : [];
      const flattenedRows = sourceRows.map((row) => flattenJsonValue(row));
      const { headers, rows, csv } = jsonMappings.some((mapping) => String(mapping.target || "").trim())
        ? buildMappedCsv(flattenedRows, jsonMappings)
        : jsonToCsv(jsonSourceText);
      setJsonPreviewHeaders(headers);
      setJsonPreviewRows(rows.slice(0, 5));
      setJsonExportCsv(csv);
      setJsonStatus("success");
      setJsonMessage(`Converted ${rows.length} row${rows.length === 1 ? "" : "s"} to CSV.`);
    } catch (error) {
      setJsonStatus("error");
      setJsonMessage(error.message || "Unable to convert JSON to CSV.");
      setJsonExportCsv("");
    }
  }

  return (
    <main className="app-shell">
      <section className="workspace">
        <header className="topbar">
          <div className="title-block">
            <span className="eyebrow">ORO workflow builder</span>
            <h1>Master Data Orchestration Studio</h1>
            <p>Choose a workflow from the home page, then open a dedicated page for that file type.</p>
          </div>
          <div className="pipeline-graphic" aria-hidden="true">
            <div className="pipeline-node input-node">
              <span>CSV</span>
              <i></i>
              <i></i>
              <i></i>
            </div>
            <div className="pipeline-line"></div>
            <div className="pipeline-node rules-node">
              <span>Flow</span>
              <b></b>
              <b></b>
            </div>
            <div className="pipeline-line"></div>
            <div className="pipeline-node ai-node">
              <span>AI</span>
              <strong></strong>
            </div>
          </div>
        </header>

        {workspaceTab === "home" && (
          <div className="home-launcher">
            <button type="button" className="launcher-card" onClick={() => setWorkspaceTab("transform")}>
              <span className="launcher-kicker">CSV workflow</span>
              <strong>Open CSV Transform</strong>
              <p>Slice columns, map headers, dedupe, concatenate, and run Python output.</p>
            </button>
            <button type="button" className="launcher-card" onClick={() => setWorkspaceTab("json")}>
              <span className="launcher-kicker">JSON workflow</span>
              <strong>Open JSON to CSV</strong>
              <p>Upload JSON, flatten nested fields, preview the data, and download CSV.</p>
            </button>
          </div>
        )}

        {workspaceTab !== "home" && (
          <div className="workspace-tabs">
            <button
              type="button"
              className={workspaceTab === "transform" ? "workspace-tab active" : "workspace-tab"}
              onClick={() => setWorkspaceTab("transform")}
            >
              CSV Transform
            </button>
            <button
              type="button"
              className={workspaceTab === "json" ? "workspace-tab active" : "workspace-tab"}
              onClick={() => setWorkspaceTab("json")}
            >
              JSON to CSV
            </button>
            <button
              type="button"
              className="workspace-tab"
              onClick={() => setWorkspaceTab("home")}
            >
              Home
            </button>
          </div>
        )}

        {workspaceTab === "transform" ? (
        <div className="tool-layout">
          <form className="tool" onSubmit={transformCsv}>
            <label className="upload-zone">
              <FileUp size={24} />
              <span>{selectedFileNames || "Choose one or more input CSVs"}</span>
              <input
                type="file"
                accept=".csv,text/csv"
                multiple
                onChange={handleFilesChange}
              />
            </label>

            {csvFiles.length > 0 && (
              <div className="file-list">
                {csvFiles.map((file) => (
                  <span key={`${file.name}-${file.lastModified}`}>{file.name}</span>
                ))}
              </div>
            )}

            <div className="transform-section">
              <div className="mapping-header">
                <div>
                  <h2>Transformations</h2>
                  <p>Select the common transformations to apply.</p>
                </div>
              </div>

              <div className="transform-list">
                <label className="transform-card">
                  <input
                    type="checkbox"
                    checked={transformations.sliceColumn.enabled}
                    onChange={() => toggleTransformation("sliceColumn")}
                  />
                  <span>Slice column value</span>
                </label>
                {transformations.sliceColumn.enabled && (
                  <div className="slice-builder">
                    <label className="field compact-field">
                      <span>Source column to split</span>
                      <input
                        value={transformations.sliceColumn.column}
                        list="csv-headers"
                        onChange={(event) => updateTransformation("sliceColumn", "column", event.target.value)}
                        placeholder="Source column"
                      />
                    </label>

                    <div className="slice-header">
                      <span>New column</span>
                      <span>Start index</span>
                      <span>End index</span>
                      <span></span>
                    </div>

                    {transformations.sliceColumn.slices.map((slice, index) => (
                      <div className="slice-row" key={index}>
                        <input
                          value={slice.target}
                          onChange={(event) => updateSlice(index, "target", event.target.value)}
                          placeholder="New target column"
                        />
                        <input
                          type="number"
                          min="0"
                          value={slice.start}
                          onChange={(event) => updateSlice(index, "start", event.target.value)}
                          placeholder="0"
                        />
                        <input
                          type="number"
                          min="1"
                          max={selectedSliceMaxLength || undefined}
                          value={slice.end}
                          onChange={(event) => updateSlice(index, "end", event.target.value)}
                          placeholder={selectedSliceMaxLength ? `Max ${selectedSliceMaxLength}` : "End"}
                        />
                        <button
                          type="button"
                          className="icon-button danger"
                          onClick={() => removeSlice(index)}
                          title="Remove slice"
                        >
                          <Trash2 size={18} />
                        </button>
                      </div>
                    ))}

                    <button type="button" className="small-button" onClick={addSlice}>
                      <Plus size={16} />
                      Add slice
                    </button>
                  </div>
                )}

                <label className="transform-card">
                  <input
                    type="checkbox"
                    checked={transformations.dedupe.enabled}
                    onChange={() => toggleTransformation("dedupe")}
                  />
                  <span>Remove duplicates</span>
                </label>
                {transformations.dedupe.enabled && (
                  <div className="duplicate-picker">
                    {availableHeaders.length > 0 ? (
                      availableHeaders.map((header) => (
                        <label className="column-chip" key={header}>
                          <input
                            type="checkbox"
                            checked={duplicateKeys.includes(header)}
                            onChange={() => toggleDuplicateKey(header)}
                          />
                          <span>{header}</span>
                        </label>
                      ))
                    ) : (
                      <p className="empty-note">Extract headers first.</p>
                    )}
                  </div>
                )}

                <label className="transform-card">
                  <input
                    type="checkbox"
                    checked={transformations.concatenate.enabled}
                    onChange={() => toggleTransformation("concatenate")}
                  />
                  <span>Concatenate columns</span>
                </label>
                {transformations.concatenate.enabled && (
                  <div className="concat-builder">
                    <div className="duplicate-picker">
                      {availableHeaders.length > 0 ? (
                        availableHeaders.map((header) => (
                          <label className="column-chip" key={header}>
                            <input
                              type="checkbox"
                              checked={transformations.concatenate.columns.includes(header)}
                              onChange={() => toggleConcatColumn(header)}
                            />
                            <span>{header}</span>
                          </label>
                        ))
                      ) : (
                        <p className="empty-note">Extract headers first.</p>
                      )}
                    </div>

                    <div className="transform-controls three">
                      <input
                        value={transformations.concatenate.prefix}
                        onChange={(event) => updateTransformation("concatenate", "prefix", event.target.value)}
                        placeholder="Prefix"
                      />
                      <input
                        value={transformations.concatenate.separator}
                        onChange={(event) => updateTransformation("concatenate", "separator", event.target.value)}
                        placeholder="Separator"
                      />
                      <input
                        value={transformations.concatenate.suffix}
                        onChange={(event) => updateTransformation("concatenate", "suffix", event.target.value)}
                        placeholder="Suffix"
                      />
                    </div>

                    <div className="transform-controls two">
                      <select
                        value={transformations.concatenate.outputMode}
                        onChange={(event) => updateTransformation("concatenate", "outputMode", event.target.value)}
                      >
                        <option value="new">Output to new column</option>
                        <option value="same">Output to selected column</option>
                      </select>
                      {transformations.concatenate.outputMode === "same" ? (
                        <input
                          value={transformations.concatenate.outputColumn}
                          list="csv-headers"
                          onChange={(event) => updateTransformation("concatenate", "outputColumn", event.target.value)}
                          placeholder="Column to overwrite"
                        />
                      ) : (
                        <input
                          value={transformations.concatenate.outputColumn}
                          onChange={(event) => updateTransformation("concatenate", "outputColumn", event.target.value)}
                          placeholder="New output column"
                        />
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="mapping-header">
              <div>
                <h2>Column Mapping</h2>
                {headers.length > 0 && <p>{headers.length} extracted source columns available.</p>}
              </div>
              <div className="mapping-actions">
                <button type="button" className="icon-button" onClick={() => extractHeaders()} title="Extract headers">
                  <ListChecks size={18} />
                </button>
                {enableMapping && (
                  <button type="button" className="icon-button" onClick={addRow} title="Add row">
                    <Plus size={18} />
                  </button>
                )}
              </div>
            </div>

            <label className="transform-card mapping-toggle">
              <input
                type="checkbox"
                checked={enableMapping}
                onChange={toggleMapping}
              />
              <span>Enable target header mapping</span>
            </label>

            <datalist id="csv-headers">
              {availableHeaders.map((header) => (
                <option value={header} key={header} />
              ))}
            </datalist>

            {enableMapping ? (
              <div className="mapping-grid">
                <div className="grid-label">Target header</div>
                <div className="grid-label">Source column</div>
                <div className="grid-label">Default value</div>
                <div className="grid-label"></div>

                {rows.map((row, index) => (
                  <React.Fragment key={index}>
                    <input
                      value={row.target}
                      onChange={(event) => updateRow(index, "target", event.target.value)}
                      placeholder="code"
                    />
                    <input
                      value={row.source}
                      list="csv-headers"
                      onChange={(event) => updateRow(index, "source", event.target.value)}
                      placeholder={headers[0] || "Source Column A"}
                    />
                    <input
                      value={row.defaultValue}
                      onChange={(event) => updateRow(index, "defaultValue", event.target.value)}
                      placeholder="Optional"
                    />
                    <button
                      type="button"
                      className="icon-button danger"
                      onClick={() => removeRow(index)}
                      title="Remove row"
                    >
                      <Trash2 size={18} />
                    </button>
                  </React.Fragment>
                ))}
              </div>
            ) : (
              <p className="mapping-note">Target mapping is off. Output will keep the source CSV columns and append generated transform columns.</p>
            )}

            <div className="actions">
              <button type="submit" disabled={status === "loading"}>
                {status === "loading" ? "Transforming..." : "Transform CSV"}
              </button>
            </div>

            {downloads.length > 0 && (
              <div className="download-list">
                {downloads.map((download) => (
                  <a className="download-button" href={download.url} key={download.url}>
                    <Download size={18} />
                    {download.fileName}
                  </a>
                ))}
              </div>
            )}

            {message && <p className={`message ${status}`}>{message}</p>}
          </form>

          <aside className="workato-panel">
            <div className="workato-header">
              <div>
                <h2>Workato Code</h2>
                <p>Copy this into a Python code action.</p>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={copyWorkatoCode}
                title="Copy Workato code"
                disabled={!displayedCode}
              >
                {copied ? <Check size={18} /> : <Copy size={18} />}
              </button>
            </div>

            <div className="ai-panel">
              <div className="chat-window">
                {chatMessages.map((message, index) => (
                  <div className={`chat-message ${message.role}`} key={index}>
                    {message.content}
                  </div>
                ))}
              </div>

              <textarea
                value={aiInstruction}
                onChange={(event) => setAiInstruction(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    sendChatMessage();
                  }
                }}
                placeholder="Chat with GPT about this code..."
              />
              <div className="ai-actions">
                <button type="button" onClick={sendChatMessage} disabled={aiStatus === "loading"}>
                  <Send size={16} />
                  {aiStatus === "loading" ? "Sending..." : "Send"}
                </button>
                <button type="button" className="secondary-button" onClick={improveWorkatoCode} disabled={aiStatus === "loading"}>
                  <Bot size={16} />
                  {aiStatus === "loading" ? "Improving..." : "Improve code"}
                </button>
                {improvedCode && (
                  <button type="button" className="secondary-button" onClick={() => setImprovedCode("")}>
                    <RotateCcw size={16} />
                    Reset
                  </button>
                )}
                {displayedCode ? (
                  <button type="button" className="secondary-button danger-button" onClick={removeCodeSnippet}>
                    <Trash2 size={16} />
                    Remove code
                  </button>
                ) : (
                  <button type="button" className="secondary-button" onClick={restoreCodeSnippet}>
                    <RotateCcw size={16} />
                    Restore code
                  </button>
                )}
              </div>
              {aiMessage && <p className={`message ${aiStatus}`}>{aiMessage}</p>}
            </div>

            <pre className={`code-block${displayedCode ? "" : " empty"}`}>
              <code>{displayedCode || "Code snippet removed."}</code>
            </pre>

            <div className="runner-panel">
              <div className="runner-controls">
                <select
                  value={runOutputType}
                  onChange={(event) => setRunOutputType(event.target.value)}
                  title="Choose Python output format"
                >
                  <option value="csv">CSV output</option>
                  <option value="json">JSON output</option>
                </select>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={runPythonCode}
                  disabled={runStatus === "loading"}
                >
                  <Play size={16} />
                  {runStatus === "loading" ? "Running..." : "Run Python"}
                </button>
              </div>

              {runMessage && <p className={`message ${runStatus}`}>{runMessage}</p>}

              {runResult && (
                <>
                  <a className="download-button runner-download" href={runResult.downloadUrl}>
                    <Download size={18} />
                    Download {runResult.outputType.toUpperCase()}
                  </a>
                  <pre className="code-block compact runner-preview"><code>{runResult.preview}</code></pre>
                </>
              )}

              {(runLogs.stdout || runLogs.stderr) && (
                <div className="runner-logs">
                  <h2>Run Logs</h2>
                  <pre className="code-block compact runner-log">
                    <code>
                      {[
                        runLogs.stdout && `STDOUT\n${runLogs.stdout.trimEnd()}`,
                        runLogs.stderr && `STDERR\n${runLogs.stderr.trimEnd()}`
                      ].filter(Boolean).join("\n\n")}
                    </code>
                  </pre>
                </div>
              )}
            </div>

            <h2 className="config-title">Config JSON</h2>
            <pre className="code-block compact"><code>{workatoConfig}</code></pre>
          </aside>
        </div>
        ) : workspaceTab === "json" ? (
        <div className="json-layout">
          <section className="tool json-panel">
            <div className="mapping-header">
              <div>
                <h2>JSON to CSV Converter</h2>
                <p>Upload a JSON file, preview the rows, and export it as CSV.</p>
              </div>
            </div>

            <div className="mapping-header">
              <div>
                <h2>Header Mapping</h2>
                <p>Map source JSON fields to ORO target columns before exporting.</p>
              </div>
              <button type="button" className="icon-button" onClick={addJsonMapping} title="Add mapping">
                <Plus size={18} />
              </button>
            </div>

            <div className="mapping-grid json-mapping-grid">
              <div className="grid-label">Source column</div>
              <div className="grid-label">Target column</div>
              <div className="grid-label"></div>
              {jsonMappings.map((mapping, index) => (
                <div className="json-mapping-row" key={index}>
                  <input
                    value={mapping.source}
                    onChange={(event) => updateJsonMapping(index, "source", event.target.value)}
                    placeholder="source field"
                  />
                  <input
                    value={mapping.target}
                    onChange={(event) => updateJsonMapping(index, "target", event.target.value)}
                    placeholder="ORO target column"
                  />
                  <button
                    type="button"
                    className="icon-button danger"
                    onClick={() => removeJsonMapping(index)}
                    title="Remove mapping"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              ))}
            </div>

            <label className="upload-zone">
              <FileUp size={24} />
              <span>{jsonFile ? jsonFile.name : "Choose a JSON file"}</span>
              <input
                type="file"
                accept=".json,application/json"
                onChange={handleJsonFileChange}
              />
            </label>

            <div className="json-actions">
              <button type="button" onClick={convertJsonToCsv} disabled={!jsonSourceText.trim()}>
                <Download size={16} />
                Convert to CSV
              </button>
              {jsonExportCsv && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => downloadJsonCsv(jsonExportCsv, jsonFileName ? jsonFileName.replace(/\.json$/i, ".csv") : "converted.csv")}
                >
                  <Download size={16} />
                  Download CSV
                </button>
              )}
            </div>

            {jsonMessage && <p className={`message ${jsonStatus}`}>{jsonMessage}</p>}

            <div className="json-preview">
              {jsonPreviewHeaders.length > 0 ? (
                <table>
                  <thead>
                    <tr>
                      {jsonPreviewHeaders.map((header) => (
                        <th key={header}>{header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {jsonPreviewRows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {jsonPreviewHeaders.map((header) => (
                          <td key={header}>{String(row[header] ?? "")}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="mapping-note">Your converted CSV preview will appear here.</p>
              )}
            </div>

            <div className="code-preview-shell">
              <div className="mapping-header">
                <div>
                  <h2>Generated Python</h2>
                  <p>This keeps the same Workato-style structure and only updates the mapping block.</p>
                </div>
              </div>
              <pre className="code-block compact"><code>{jsonWorkatoCode}</code></pre>
            </div>
          </section>
        </div>
        ) : null}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
