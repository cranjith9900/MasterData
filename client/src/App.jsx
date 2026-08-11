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

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function highlightPython(code) {
  return escapeHtml(code)
    .replace(/(^|\s)(#.*)$/gm, '$1<span class="py-comment">$2</span>')
    .replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, '<span class="py-string">$1</span>')
    .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="py-number">$1</span>')
    .replace(/\b(def|return|if|elif|else|for|while|in|import|from|as|with|try|except|finally|class|lambda|True|False|None|and|or|not|break|continue|pass|raise|yield|async|await)\b/g, '<span class="py-keyword">$1</span>');
}

function buildWorkatoCode(config) {
  return `import csv
import io
import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

CONFIG = ${JSON.stringify(config, null, 2)}

def text(value):
    return "" if value is None else str(value)

def empty(value):
    return value is None or text(value).strip() == ""

def number(value):
    cleaned = text(value).replace("$", "").replace("%", "").replace(",", "").strip()
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None

def apply_text(row, transform):
    target = transform.get("target", "").strip()
    source = transform.get("source") or target
    value = row.get(source, "")
    kind = transform.get("type")
    if kind == "trim":
        value = text(value).strip()
    elif kind == "uppercase":
        value = text(value).upper()
    elif kind == "lowercase":
        value = text(value).lower()
    elif kind == "replace":
        value = text(value).replace(text(transform.get("find", "")), text(transform.get("replace", "")))
    elif kind == "defaultIfEmpty":
        value = transform.get("defaultValue", "") if empty(value) else value
    elif kind == "nullIfEmpty":
        value = None if empty(value) else value
    row[target] = value

def apply_date(row, transform):
    target = transform.get("target", "").strip()
    source = transform.get("source")
    raw = text(row.get(source, ""))
    if not raw:
        row[target] = transform.get("defaultValue", "")
        return
    fmt = transform.get("inputFormat")
    dt = datetime.strptime(raw, fmt) if fmt else datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if transform.get("offsetDays"):
        dt = dt + timedelta(days=int(transform.get("offsetDays", 0)))
    timezone = transform.get("timezone")
    if timezone:
        dt = dt.astimezone(ZoneInfo(timezone))
    output = transform.get("outputFormat", "iso")
    if output == "date":
        row[target] = dt.strftime("%Y-%m-%d")
    elif output == "datetime":
        row[target] = dt.strftime("%Y-%m-%d %H:%M:%S")
    else:
        row[target] = dt.isoformat()

def apply_number(row, transform):
    target = transform.get("target", "").strip()
    source = transform.get("source")
    value = number(row.get(source, ""))
    if value is None:
        row[target] = transform.get("defaultValue", "")
        return
    if transform.get("percentToDecimal"):
        value = value / 100.0
    if transform.get("round") is not None:
        value = round(value, int(transform.get("round", 0)))
    row[target] = value

def apply_conditional(row, transform):
    target = transform.get("target", "").strip()
    kind = transform.get("type")
    if kind == "fallback":
        for source in transform.get("sources", []):
            value = row.get(source, "")
            if not empty(value):
                row[target] = value
                return
        row[target] = transform.get("defaultValue", "")
    elif kind == "equals":
        row[target] = transform.get("thenValue", "") if text(row.get(transform.get("source"), "")) == text(transform.get("when", "")) else transform.get("elseValue", "")

def apply_lookup(row, lookup):
    key = tuple(text(row.get(column, "")) for column in lookup.get("matchColumns", []))
    for entry in lookup.get("table", []):
        if key == tuple(text(entry.get(column, "")) for column in lookup.get("matchColumns", [])):
            return entry.get(lookup.get("outputColumn", ""), lookup.get("defaultValue", ""))
    return lookup.get("defaultValue", "")

def apply_derived(row, transform):
    target = transform.get("target", "").strip()
    sources = [text(row.get(column, "")) for column in transform.get("sources", [])]
    mode = transform.get("mode", "concat")
    if mode == "full_name":
        row[target] = " ".join(part for part in sources if part).strip()
    elif mode == "address_lines":
        row[target] = "\\n".join(part for part in sources if part)
    elif mode == "composite_key":
        row[target] = (transform.get("separator", "|")).join(part for part in sources if part)
    else:
        row[target] = f"{transform.get('prefix', '')}{(transform.get('separator', '')).join(sources)}{transform.get('suffix', '')}"

def validate(row, rules):
    errors = []
    for rule in rules:
        value = row.get(rule.get("column"), "")
        if rule.get("required") and empty(value):
            errors.append(f"{rule.get('column')} is required")
        allowed = rule.get("allowedValues") or []
        if allowed and text(value) not in allowed:
            errors.append(f"{rule.get('column')} must be one of: {', '.join(allowed)}")
        if rule.get("minLength") is not None and len(text(value)) < int(rule.get("minLength", 0)):
            errors.append(f"{rule.get('column')} is too short")
        if rule.get("maxLength") is not None and len(text(value)) > int(rule.get("maxLength", 0)):
            errors.append(f"{rule.get('column')} is too long")
        if rule.get("regex"):
            import re
            if not re.search(rule.get("regex"), text(value)):
                errors.append(f"{rule.get('column')} failed validation")
    return errors

def main(input_data):
    rows = list(csv.DictReader(io.StringIO(input_data["input"])))
    headers = list(rows[0].keys()) if rows else []
    warnings = []

    for transform in CONFIG.get("advancedTransforms", {}).get("textTransforms", []):
        for row in rows:
            apply_text(row, transform)
        if transform.get("target") and transform.get("target") not in headers:
            headers.append(transform.get("target"))
    for transform in CONFIG.get("advancedTransforms", {}).get("dateTransforms", []):
        for row in rows:
            apply_date(row, transform)
        if transform.get("target") and transform.get("target") not in headers:
            headers.append(transform.get("target"))
    for transform in CONFIG.get("advancedTransforms", {}).get("numberTransforms", []):
        for row in rows:
            apply_number(row, transform)
        if transform.get("target") and transform.get("target") not in headers:
            headers.append(transform.get("target"))
    for transform in CONFIG.get("advancedTransforms", {}).get("conditionals", []):
        for row in rows:
            apply_conditional(row, transform)
        if transform.get("target") and transform.get("target") not in headers:
            headers.append(transform.get("target"))
    for lookup in CONFIG.get("advancedTransforms", {}).get("lookups", []):
        for row in rows:
            row[lookup.get("target", "")] = apply_lookup(row, lookup)
        if lookup.get("target") and lookup.get("target") not in headers:
            headers.append(lookup.get("target"))
    for transform in CONFIG.get("advancedTransforms", {}).get("derivedFields", []):
        for row in rows:
            apply_derived(row, transform)
        if transform.get("target") and transform.get("target") not in headers:
            headers.append(transform.get("target"))
    validation_rules = CONFIG.get("advancedTransforms", {}).get("validationRules", [])
    if validation_rules:
        filtered = []
        for row in rows:
            row_errors = validate(row, validation_rules)
            if row_errors:
                warnings.extend(row_errors)
                if CONFIG.get("advancedTransforms", {}).get("validationMode") == "drop":
                    continue
            filtered.append(row)
        rows = filtered

    output_mode = CONFIG.get("outputMode", "json")
    if output_mode == "csv":
        buffer = io.StringIO()
        writer = csv.DictWriter(buffer, fieldnames=headers, lineterminator="\\n")
        writer.writeheader()
        for row in rows:
            writer.writerow({header: row.get(header, "") for header in headers})
        csv_output = buffer.getvalue()
        return {"csv_output": csv_output, "warnings": warnings}

    return {"json_output": rows, "warnings": warnings}`;
}

function App() {
  const [workspaceTab, setWorkspaceTab] = useState("transform");
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
  const [advancedTransformsText, setAdvancedTransformsText] = useState(JSON.stringify({
    textTransforms: [
      { type: "trim", source: "name", target: "name_trimmed" },
      { type: "uppercase", source: "code", target: "code_upper" },
      { type: "defaultIfEmpty", source: "active", target: "active_clean", defaultValue: "true" }
    ],
    dateTransforms: [
      { source: "created_at", target: "created_date", inputFormat: "yyyy-MM-dd", outputFormat: "date", offsetDays: 0, timezone: "UTC" }
    ],
    numberTransforms: [
      { source: "amount", target: "amount_rounded", round: 2 },
      { source: "percent", target: "percent_decimal", percentToDecimal: true }
    ],
    conditionals: [
      { type: "fallback", sources: ["source_a", "source_b"], target: "preferred_source" }
    ],
    lookups: [
      { target: "status_label", matchColumns: ["status"], outputColumn: "label", defaultValue: "", table: [{ status: "A", label: "Active" }] }
    ],
    derivedFields: [
      { mode: "full_name", sources: ["first_name", "last_name"], target: "full_name" }
    ],
    validationRules: [
      { column: "code", required: true, minLength: 1, regex: "^[A-Z0-9_-]+$" }
    ],
    validationMode: "keep"
  }, null, 2));
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const [downloads, setDownloads] = useState([]);
  const [copied, setCopied] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiStatus, setAiStatus] = useState("idle");
  const [aiMessage, setAiMessage] = useState("");
  const [improvedCode, setImprovedCode] = useState("");
  const [editedCode, setEditedCode] = useState("");
  const [isCodeRemoved, setIsCodeRemoved] = useState(false);
  const [advancedToggles, setAdvancedToggles] = useState({
    textTransforms: false,
    dateTransforms: false,
    numberTransforms: false,
    conditionals: false,
    lookups: false,
    derivedFields: false,
    validationRules: false
  });
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
  const [collections, setCollections] = useState([]);
  const [collectionFiles, setCollectionFiles] = useState([]);
  const [collectionName, setCollectionName] = useState("Workato knowledge base");
  const [selectedCollectionId, setSelectedCollectionId] = useState("");
  const [collectionStatus, setCollectionStatus] = useState("idle");
  const [collectionMessage, setCollectionMessage] = useState("");
  const [collectionChatInput, setCollectionChatInput] = useState("");
  const [collectionChatMessages, setCollectionChatMessages] = useState([
    {
      role: "assistant",
      content: "Upload a .zip or text files, build a collection, then ask questions against the indexed content."
    }
  ]);

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
  const selectedCollection = collections.find((collection) => collection.id === selectedCollectionId) || null;

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
      transformations,
      advancedTransforms: (() => {
        try {
          const parsed = JSON.parse(advancedTransformsText);
          return Object.fromEntries(
            Object.entries(parsed).filter(([key]) => advancedToggles[key] !== false)
          );
        } catch {
          return {};
        }
      })(),
      outputMode: runOutputType
    };
  }, [rows, duplicateKeys, transformations, generatedSliceHeaders, generatedConcatHeaders, enableMapping, advancedTransformsText, runOutputType, advancedToggles]);

  const workatoCode = useMemo(() => buildWorkatoCode(config), [config]);
  const displayedCode = isCodeRemoved ? "" : editedCode || improvedCode || workatoCode;
  const workatoConfig = useMemo(() => JSON.stringify(config, null, 2), [config]);

  async function copyWorkatoCode() {
    if (!displayedCode) return;

    await navigator.clipboard.writeText(displayedCode);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  function removeCodeSnippet() {
    setImprovedCode("");
    setEditedCode("");
    setIsCodeRemoved(true);
    setCopied(false);
    setAiStatus("idle");
    setAiMessage("");
  }

  function restoreCodeSnippet() {
    setIsCodeRemoved(false);
  }

  function updateAdvancedTransforms(value) {
    setAdvancedTransformsText(value);
  }

  function toggleAdvancedToggle(key) {
    setAdvancedToggles((current) => ({
      ...current,
      [key]: !current[key]
    }));
  }

  function updateEditorCode(value) {
    setEditedCode(value);
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
      setEditedCode(data.code);
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
        setEditedCode(returnedCode);
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

  async function buildCollection() {
    if (!collectionFiles.length) {
      setCollectionStatus("error");
      setCollectionMessage("Choose one or more .zip or text files first.");
      return;
    }

    const formData = new FormData();
    formData.append("collectionName", collectionName);
    collectionFiles.forEach((file) => formData.append("files", file));

    setCollectionStatus("loading");
    setCollectionMessage("Indexing files...");

    try {
      const response = await fetch(`${API_BASE}/api/collections/index`, {
        method: "POST",
        body: formData
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || data.error || "Unable to build collection.");
      }

      setCollections((current) => [data.collection, ...current.filter((item) => item.id !== data.collection.id)]);
      setSelectedCollectionId(data.collection.id);
      setCollectionStatus("success");
      setCollectionMessage(`Built "${data.collection.name}" with ${data.collection.chunkCount} indexed chunks.`);
    } catch (error) {
      setCollectionStatus("error");
      setCollectionMessage(error.message);
    }
  }

  async function sendCollectionChatMessage() {
    if (!selectedCollectionId) {
      setCollectionStatus("error");
      setCollectionMessage("Build or choose a collection first.");
      return;
    }

    const content = collectionChatInput.trim();
    if (!content) return;

    const nextMessages = [...collectionChatMessages, { role: "user", content }];
    setCollectionChatMessages(nextMessages);
    setCollectionChatInput("");
    setCollectionStatus("loading");
    setCollectionMessage("");

    try {
      const response = await fetch(`${API_BASE}/api/collections/${selectedCollectionId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: content })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || data.error || "Unable to query the collection.");
      }

      setCollectionChatMessages((current) => [...current, { role: "assistant", content: data.message || "" }]);
      setCollectionStatus("success");
      setCollectionMessage(`Matched ${data.matches?.length || 0} snippets.`);
    } catch (error) {
      setCollectionStatus("error");
      setCollectionMessage(error.message);
      setCollectionChatMessages((current) => [...current, { role: "assistant", content: error.message }]);
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

  return (
    <main className="app-shell">
      <section className="workspace">
        <header className="topbar">
          <div className="title-block">
            <span className="eyebrow">ORO workflow builder</span>
            <h1>Master Data Orchestration Studio</h1>
            <p>Transform CSVs into clean supplier and procurement data flows, then generate Workato-ready Python with AI guidance.</p>
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

        <div className="workspace-tabs">
          <button type="button" className={workspaceTab === "transform" ? "workspace-tab active" : "workspace-tab"} onClick={() => setWorkspaceTab("transform")}>Transform Studio</button>
          <button type="button" className={workspaceTab === "collections" ? "workspace-tab active" : "workspace-tab"} onClick={() => setWorkspaceTab("collections")}>Collections</button>
        </div>

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

                <div className="advanced-checkbox-group">
                  <div className="mapping-header advanced-group-header">
                    <div>
                      <h2>Advanced transforms</h2>
                      <p>Turn on the transform families you want to configure.</p>
                    </div>
                  </div>
                  <div className="advanced-checkboxes">
                    <label className="transform-card">
                      <input
                        type="checkbox"
                        checked={advancedToggles.textTransforms}
                        onChange={() => toggleAdvancedToggle("textTransforms")}
                      />
                      <span>Text transforms</span>
                    </label>
                    <label className="transform-card">
                      <input
                        type="checkbox"
                        checked={advancedToggles.dateTransforms}
                        onChange={() => toggleAdvancedToggle("dateTransforms")}
                      />
                      <span>Date transforms</span>
                    </label>
                    <label className="transform-card">
                      <input
                        type="checkbox"
                        checked={advancedToggles.numberTransforms}
                        onChange={() => toggleAdvancedToggle("numberTransforms")}
                      />
                      <span>Number transforms</span>
                    </label>
                    <label className="transform-card">
                      <input
                        type="checkbox"
                        checked={advancedToggles.conditionals}
                        onChange={() => toggleAdvancedToggle("conditionals")}
                      />
                      <span>Conditional transforms</span>
                    </label>
                    <label className="transform-card">
                      <input
                        type="checkbox"
                        checked={advancedToggles.lookups}
                        onChange={() => toggleAdvancedToggle("lookups")}
                      />
                      <span>Lookup joins</span>
                    </label>
                    <label className="transform-card">
                      <input
                        type="checkbox"
                        checked={advancedToggles.derivedFields}
                        onChange={() => toggleAdvancedToggle("derivedFields")}
                      />
                      <span>Derived fields</span>
                    </label>
                    <label className="transform-card">
                      <input
                        type="checkbox"
                        checked={advancedToggles.validationRules}
                        onChange={() => toggleAdvancedToggle("validationRules")}
                      />
                      <span>Validation rules</span>
                    </label>
                  </div>
                </div>
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

            <div className="code-editor-shell">
              <div className="code-editor-header">
                <div>
                  <h2>Python Code</h2>
                  <p>Edit the generated snippet before you run it.</p>
                </div>
              </div>
              <div className="code-editor">
                <div className="code-gutter" aria-hidden="true">
                  {(displayedCode || " ").split("\n").map((_, index) => (
                    <span key={index}>{index + 1}</span>
                  ))}
                </div>
                <div className="code-stage">
                  <pre className={`code-block code-highlight${displayedCode ? "" : " empty"}`} aria-hidden="true">
                    <code dangerouslySetInnerHTML={{ __html: displayedCode ? highlightPython(displayedCode) : "Code snippet removed." }} />
                  </pre>
                  <textarea
                    className="code-editor-input"
                    value={displayedCode}
                    spellCheck="false"
                    onChange={(event) => updateEditorCode(event.target.value)}
                    placeholder="Edit the generated Python code..."
                  />
                </div>
              </div>
            </div>

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
        ) : (
        <div className="collections-full-tab">
          <div className="collections-panel">
            <div className="mapping-header">
              <div>
                <h2>Collection Builder</h2>
                <p>Upload a .zip, .txt, .md, .csv, or .json file, index it, then chat against the uploaded knowledge.</p>
              </div>
            </div>

            <label className="upload-zone">
              <FileUp size={24} />
              <span>{collectionFiles.length ? `${collectionFiles.length} file(s) selected` : "Choose files or a .zip for collection training"}</span>
              <input
                type="file"
                accept=".zip,.txt,.md,.csv,.json,.log,.xml,.html"
                multiple
                onChange={(event) => setCollectionFiles(Array.from(event.target.files || []))}
              />
            </label>

            {collectionFiles.length > 0 && (
              <div className="file-list">
                {collectionFiles.map((file) => (
                  <span key={`${file.name}-${file.lastModified}`}>{file.name}</span>
                ))}
              </div>
            )}

            <div className="transform-controls two collection-controls">
              <input value={collectionName} onChange={(event) => setCollectionName(event.target.value)} placeholder="Collection name" />
              <button type="button" className="secondary-button" onClick={buildCollection} disabled={collectionStatus === "loading"}>
                {collectionStatus === "loading" ? "Indexing..." : "Build collection"}
              </button>
            </div>

            <div className="collection-summary">
              <div>
                <strong>{collections.length}</strong>
                <span>collections ready</span>
              </div>
              <div>
                <strong>{selectedCollection ? selectedCollection.chunkCount : 0}</strong>
                <span>indexed chunks</span>
              </div>
            </div>

            <div className="collection-picker">
              {collections.length > 0 ? collections.map((collection) => (
                <button
                  type="button"
                  key={collection.id}
                  className={selectedCollectionId === collection.id ? "collection-chip active" : "collection-chip"}
                  onClick={() => setSelectedCollectionId(collection.id)}
                >
                  <span>{collection.name}</span>
                  <small>{collection.chunkCount} chunks</small>
                </button>
              )) : <p className="empty-note">No collections yet. Build one from your uploaded files.</p>}
            </div>

            <div className="collection-chat">
              <div className="chat-window">
                {collectionChatMessages.map((message, index) => (
                  <div className={`chat-message ${message.role}`} key={index}>{message.content}</div>
                ))}
              </div>
              <textarea
                value={collectionChatInput}
                onChange={(event) => setCollectionChatInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    sendCollectionChatMessage();
                  }
                }}
                placeholder={selectedCollectionId ? "Ask about the uploaded collection..." : "Build a collection first"}
              />
              <div className="ai-actions">
                <button type="button" onClick={sendCollectionChatMessage} disabled={collectionStatus === "loading"}>
                  <Send size={16} />
                  {collectionStatus === "loading" ? "Thinking..." : "Ask collection"}
                </button>
              </div>
              {collectionMessage && <p className={`message ${collectionStatus}`}>{collectionMessage}</p>}
            </div>
          </div>
        </div>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
