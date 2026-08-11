const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { spawn, spawnSync } = require("child_process");
const { v4: uuidv4 } = require("uuid");

const AZURE_CONFIG = {
  endpoint: "https://ororag.services.ai.azure.com/api/projects/proj-default",
  apiKey: "paste-your-api-key-here",
  deployment: "gpt-4.1-mini",
  apiVersion: "2024-02-15-preview"
};

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  const envFile = fs.readFileSync(envPath, "utf-8");
  envFile.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) return;

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

const app = express();
const PORT = process.env.PORT || 4000;
const bundledPython = path.join(
  process.env.USERPROFILE || "",
  ".cache",
  "codex-runtimes",
  "codex-primary-runtime",
  "dependencies",
  "python",
  "python.exe"
);
const PYTHON = process.env.PYTHON_PATH || (fs.existsSync(bundledPython) ? bundledPython : "python");

const uploadDir = path.join(__dirname, "uploads");
const downloadDir = path.join(__dirname, "downloads");
const runnerDir = path.join(__dirname, "runners");
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(downloadDir, { recursive: true });
fs.mkdirSync(runnerDir, { recursive: true });

const upload = multer({ dest: uploadDir });
const clientDistDir = path.join(__dirname, "..", "client", "dist");
const collectionsStore = new Map();

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
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += character;
    }
  }

  values.push(current);
  return values;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  });

  return { headers, rows };
}

function escapeCsvValue(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function writeCsv(headers, rows) {
  return [
    headers.map(escapeCsvValue).join(","),
    ...rows.map((row) => headers.map((header) => escapeCsvValue(row[header])).join(","))
  ].join("\n");
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function asText(value) {
  return value === null || value === undefined ? "" : String(value);
}

function isEmptyValue(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function normalizeText(value, mode) {
  const text = asText(value);
  switch (mode) {
    case "trim":
      return text.trim();
    case "uppercase":
      return text.toUpperCase();
    case "lowercase":
      return text.toLowerCase();
    default:
      return text;
  }
}

function safeNumber(value) {
  if (isEmptyValue(value)) return null;
  const cleaned = asText(value).replace(/[$,%\s,]/g, "");
  if (cleaned === "") return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function applyLookup(row, lookup) {
  const keyValues = (lookup.matchColumns || []).map((column) => asText(row[column]));
  const key = keyValues.join("||");
  const table = lookup.table || [];
  const match = table.find((entry) => (lookup.matchColumns || []).every((column, index) => asText(entry[column]) === keyValues[index]));
  if (!match) return lookup.defaultValue ?? "";
  return match[lookup.outputColumn] ?? lookup.defaultValue ?? "";
}

function applyDerivedField(row, derived) {
  const sourceValues = (derived.sources || []).map((column) => asText(row[column]));
  switch (derived.mode) {
    case "full_name":
      return sourceValues.filter(Boolean).join(" ").trim();
    case "address_lines":
      return sourceValues.filter(Boolean).join("\n");
    case "composite_key":
      return sourceValues.filter(Boolean).join(derived.separator ?? "|");
    case "concat":
    default:
      return `${derived.prefix || ""}${sourceValues.join(derived.separator ?? "")}${derived.suffix || ""}`;
  }
}

function validateRow(row, rules) {
  const errors = [];
  (rules || []).forEach((rule) => {
    const value = row[rule.column];
    if (rule.required && isEmptyValue(value)) {
      errors.push(`${rule.column} is required`);
    }
    if (Array.isArray(rule.allowedValues) && rule.allowedValues.length > 0 && !rule.allowedValues.includes(asText(value))) {
      errors.push(`${rule.column} must be one of: ${rule.allowedValues.join(", ")}`);
    }
    if (rule.minLength !== undefined && asText(value).length < Number(rule.minLength)) {
      errors.push(`${rule.column} must be at least ${rule.minLength} characters`);
    }
    if (rule.maxLength !== undefined && asText(value).length > Number(rule.maxLength)) {
      errors.push(`${rule.column} must be at most ${rule.maxLength} characters`);
    }
    if (rule.regex) {
      const pattern = new RegExp(rule.regex);
      if (!pattern.test(asText(value))) {
        errors.push(`${rule.column} failed pattern ${rule.regex}`);
      }
    }
  });
  return errors;
}

function splitIntoChunks(text, size = 1200, overlap = 180) {
  const clean = asText(text).replace(/\r\n/g, "\n").trim();
  if (!clean) return [];

  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(clean.length, start + size);
    chunks.push(clean.slice(start, end));
    if (end === clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

function tokenize(text) {
  return asText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function buildChunkIndex(collection) {
  const allChunks = [];
  (collection.sources || []).forEach((source) => {
    (source.chunks || []).forEach((chunk, chunkIndex) => {
      const tokens = tokenize(chunk);
      const termCounts = tokens.reduce((accumulator, token) => {
        accumulator[token] = (accumulator[token] || 0) + 1;
        return accumulator;
      }, {});
      allChunks.push({
        sourceName: source.name,
        chunkIndex,
        text: chunk,
        tokens,
        termCounts
      });
    });
  });
  collection.indexedChunks = allChunks;
}

function scoreChunk(chunk, questionTokens) {
  return questionTokens.reduce((score, token) => score + (chunk.termCounts[token] || 0), 0);
}

function extractTextFromFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const baseName = path.basename(originalName);
  if (ext === ".txt" || ext === ".md" || ext === ".csv" || ext === ".json" || ext === ".log" || ext === ".xml" || ext === ".html") {
    return [{ name: baseName, text: fs.readFileSync(filePath, "utf-8") }];
  }

  if (ext !== ".zip") {
    return [];
  }

  const result = spawnSync(PYTHON, ["-c", `
import json, os, sys, tempfile, zipfile
zip_path = sys.argv[1]
allowed = {".txt", ".md", ".csv", ".json", ".log", ".xml", ".html"}
items = []
with zipfile.ZipFile(zip_path) as zf:
    for info in zf.infolist():
        if info.is_dir():
            continue
        name = info.filename
        ext = os.path.splitext(name)[1].lower()
        if ext not in allowed:
            continue
        try:
            data = zf.read(info).decode("utf-8", errors="ignore")
        except Exception:
            data = ""
        if data.strip():
            items.append({"name": name, "text": data})
print(json.dumps(items))
`, filePath], { encoding: "utf-8" });

  if (result.status !== 0) {
    return [];
  }

  try {
    return JSON.parse(result.stdout || "[]");
  } catch {
    return [];
  }
}

function summarizeRetrievedChunks(chunks, question) {
  if (!chunks.length) {
    return `I could not find a strong match in the uploaded collection for: ${question}`;
  }

  const grouped = chunks.slice(0, 4).map((chunk, index) => `Source ${index + 1} - ${chunk.sourceName}\n${chunk.text.slice(0, 900)}`);
  return [
    "Here are the most relevant snippets from the collection:",
    ...grouped,
    "",
    "Use those excerpts to answer the user's question."
  ].join("\n\n");
}

function applyAdvancedTransforms(rows, headers, advanced = {}) {
  const warnings = [];
  let nextRows = rows.map((row) => ({ ...row }));
  let nextHeaders = [...headers];

  const ensureHeader = (header) => {
    if (header && !nextHeaders.includes(header)) nextHeaders.push(header);
  };

  (advanced.textTransforms || []).forEach((transform) => {
    const target = String(transform.target || "").trim();
    if (!target) return;
    ensureHeader(target);
    nextRows = nextRows.map((row) => {
      const sourceValue = transform.source ? row[transform.source] : row[target];
      let value = sourceValue;
      switch (transform.type) {
        case "trim":
        case "uppercase":
        case "lowercase":
          value = normalizeText(sourceValue, transform.type);
          break;
        case "replace":
          value = asText(sourceValue).split(transform.find ?? "").join(transform.replace ?? "");
          break;
        case "defaultIfEmpty":
          value = isEmptyValue(sourceValue) ? transform.defaultValue ?? "" : sourceValue;
          break;
        case "nullIfEmpty":
          value = isEmptyValue(sourceValue) ? null : sourceValue;
          break;
        default:
          value = sourceValue;
      }
      return { ...row, [target]: value };
    });
  });

  (advanced.dateTransforms || []).forEach((transform) => {
    const target = String(transform.target || "").trim();
    if (!target) return;
    ensureHeader(target);
    nextRows = nextRows.map((row) => {
      const raw = asText(row[transform.source]);
      if (!raw) return { ...row, [target]: transform.defaultValue ?? "" };
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) return { ...row, [target]: transform.defaultValue ?? "" };
      if (transform.offsetDays) parsed.setDate(parsed.getDate() + Number(transform.offsetDays || 0));
      if (transform.timezone) {
        try {
          const formatter = new Intl.DateTimeFormat("en-CA", {
            timeZone: transform.timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false
          });
          const parts = Object.fromEntries(formatter.formatToParts(parsed).map((part) => [part.type, part.value]));
          const iso = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
          return { ...row, [target]: transform.format === "iso" ? iso : iso.replace("T", " ") };
        } catch {
          warnings.push(`Timezone conversion failed for ${target}`);
        }
      }
      const yyyy = parsed.getFullYear();
      const mm = String(parsed.getMonth() + 1).padStart(2, "0");
      const dd = String(parsed.getDate()).padStart(2, "0");
      const hh = String(parsed.getHours()).padStart(2, "0");
      const mi = String(parsed.getMinutes()).padStart(2, "0");
      const ss = String(parsed.getSeconds()).padStart(2, "0");
      const formatted = transform.format === "date" ? `${yyyy}-${mm}-${dd}` : `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
      return { ...row, [target]: formatted };
    });
  });

  (advanced.numberTransforms || []).forEach((transform) => {
    const target = String(transform.target || "").trim();
    if (!target) return;
    ensureHeader(target);
    nextRows = nextRows.map((row) => {
      const num = safeNumber(row[transform.source]);
      if (num === null) return { ...row, [target]: transform.defaultValue ?? "" };
      let value = num;
      if (transform.cleanup === "currency") value = num;
      if (transform.percentToDecimal) value = num / 100;
      if (transform.round !== undefined) value = Number(value.toFixed(Number(transform.round)));
      return { ...row, [target]: value };
    });
  });

  (advanced.conditionals || []).forEach((transform) => {
    const target = String(transform.target || "").trim();
    if (!target) return;
    ensureHeader(target);
    nextRows = nextRows.map((row) => {
      let value = transform.defaultValue ?? "";
      if (transform.type === "fallback") {
        value = transform.sources?.map((source) => row[source]).find((candidate) => !isEmptyValue(candidate)) ?? transform.defaultValue ?? "";
      } else if (transform.type === "equals") {
        value = asText(row[transform.source]) === asText(transform.when) ? transform.thenValue ?? "" : transform.elseValue ?? "";
      }
      return { ...row, [target]: value };
    });
  });

  (advanced.lookups || []).forEach((lookup) => {
    const target = String(lookup.target || "").trim();
    if (!target) return;
    ensureHeader(target);
    nextRows = nextRows.map((row) => ({ ...row, [target]: applyLookup(row, lookup) }));
  });

  (advanced.derivedFields || []).forEach((derived) => {
    const target = String(derived.target || "").trim();
    if (!target) return;
    ensureHeader(target);
    nextRows = nextRows.map((row) => ({ ...row, [target]: applyDerivedField(row, derived) }));
  });

  const validations = advanced.validationRules || [];
  nextRows = nextRows.filter((row) => {
    const rowErrors = validateRow(row, validations);
    if (rowErrors.length > 0) {
      warnings.push(...rowErrors);
      return !advanced.validationMode || advanced.validationMode === "keep";
    }
    return true;
  });

  return { rows: nextRows, headers: nextHeaders, warnings };
}

function transformCsvWithJs(inputPath, config, outputPath) {
  const csvText = fs.readFileSync(inputPath, "utf-8");
  const parsed = parseCsv(csvText);
  let rows = parsed.rows;
  let headers = [...parsed.headers];
  const transformations = config.transformations || {};

  const sliceConfig = transformations.sliceColumn || {};
  if (sliceConfig.enabled && sliceConfig.column) {
    const maxLength = rows.reduce(
      (max, row) => Math.max(max, String(row[sliceConfig.column] || "").length),
      0
    );

    (sliceConfig.slices || []).forEach((sliceItem) => {
      const target = String(sliceItem.target || "").trim();
      if (!target) return;

      const start = Math.min(Math.max(Number(sliceItem.start || 0), 0), maxLength);
      const rawEnd = sliceItem.end;
      const end = rawEnd === undefined || rawEnd === "" || rawEnd === null
        ? undefined
        : Math.min(Math.max(Number(rawEnd), start), maxLength);

      rows = rows.map((row) => ({
        ...row,
        [target]: String(row[sliceConfig.column] || "").slice(start, end)
      }));

      if (!headers.includes(target)) headers.push(target);
    });
  }

  const concatConfig = transformations.concatenate || {};
  if (concatConfig.enabled && concatConfig.outputColumn) {
    const concatColumns = (concatConfig.columns || []).filter((column) => headers.includes(column));
    const outputColumn = String(concatConfig.outputColumn || "").trim();

    if (concatColumns.length > 0 && outputColumn) {
      const separator = concatConfig.separator || "";
      const prefix = concatConfig.prefix || "";
      const suffix = concatConfig.suffix || "";
      rows = rows.map((row) => ({
        ...row,
        [outputColumn]: `${prefix}${concatColumns.map((column) => row[column] || "").join(separator)}${suffix}`
      }));
      if (!headers.includes(outputColumn)) headers.push(outputColumn);
    }
  }

  const targetHeaders = config.targetHeaders || [];
  const columnMap = config.columnMap || {};
  const defaultValues = config.defaultValues || {};
  let outputHeaders = targetHeaders.length > 0 ? [...targetHeaders] : [...headers];

  let outputRows = rows.map((row) => {
    if (targetHeaders.length === 0) return row;

    return Object.fromEntries(outputHeaders.map((target) => {
      const source = columnMap[target] || target;
      const value = source && Object.prototype.hasOwnProperty.call(row, source)
        ? row[source]
        : defaultValues[target] || "";
      return [target, value];
    }));
  });

  const duplicateKeys = config.duplicateKeys || [];
  if (duplicateKeys.length > 0 && duplicateKeys.every((key) => outputHeaders.includes(key))) {
    const seen = new Set();
    outputRows = outputRows.filter((row) => {
      const key = duplicateKeys.map((column) => row[column] || "").join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const advanced = config.advancedTransforms || {};
  const advancedResult = applyAdvancedTransforms(outputRows, outputHeaders, advanced);
  outputRows = advancedResult.rows;
  outputHeaders = advancedResult.headers;

  fs.writeFileSync(outputPath, writeCsv(outputHeaders, outputRows), "utf-8");

  return {
    rows: outputRows.length,
    columns: outputHeaders,
    warnings: advancedResult.warnings,
    output: outputPath
  };
}

function runPythonSnippet({ inputPath, code, outputType, outputPath }) {
  return new Promise((resolve, reject) => {
    const jobId = uuidv4();
    const codePath = path.join(runnerDir, `${jobId}_snippet.py`);
    const runnerPath = path.join(runnerDir, `${jobId}_runner.py`);
    const normalizedOutputType = outputType === "json" ? "json" : "csv";

    const runnerCode = `
import csv
import importlib.util
import io
import json
import sys

code_path, input_path, output_type, output_path = sys.argv[1:5]

spec = importlib.util.spec_from_file_location("snippet_module", code_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

if not hasattr(module, "main"):
    raise RuntimeError("Python snippet must define a main(input_data) function.")

with open(input_path, "r", encoding="utf-8-sig") as input_file:
    raw_csv = input_file.read()

result = module.main({"input": raw_csv})
if result is None:
    result = {}
if not isinstance(result, dict):
    result = {"json_output": result}

def csv_to_records(csv_text):
    reader = csv.DictReader(io.StringIO(csv_text or ""))
    return list(reader)

def records_to_csv(records):
    if not isinstance(records, list):
        records = [records]
    headers = []
    for record in records:
        if isinstance(record, dict):
            for key in record.keys():
                if key not in headers:
                    headers.append(key)
        elif "value" not in headers:
            headers.append("value")
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=headers, lineterminator="\\n")
    writer.writeheader()
    for record in records:
        writer.writerow(record if isinstance(record, dict) else {"value": record})
    return buffer.getvalue()

if output_type == "json":
    payload = result.get("json_output", result)
    if "csv_output" in result and "json_output" not in result:
        payload = csv_to_records(result.get("csv_output", ""))
    output_text = json.dumps(payload, indent=2, default=str)
else:
    if "csv_output" in result:
        output_text = result.get("csv_output", "")
    else:
        output_text = records_to_csv(result.get("json_output", result))

with open(output_path, "w", encoding="utf-8", newline="") as output_file:
    output_file.write(output_text)

print("__RUNNER_RESULT__" + json.dumps({
    "outputType": output_type,
    "preview": output_text[:5000],
    "size": len(output_text)
}), file=sys.stderr)
`;

    fs.writeFileSync(codePath, code, "utf-8");
    fs.writeFileSync(runnerPath, runnerCode.trim(), "utf-8");

    const child = spawn(PYTHON, [runnerPath, codePath, inputPath, normalizedOutputType, outputPath], {
      cwd: path.join(__dirname, ".."),
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (exitCode) => {
      fs.rmSync(codePath, { force: true });
      fs.rmSync(runnerPath, { force: true });

      const resultMarker = "__RUNNER_RESULT__";
      const resultIndex = stderr.lastIndexOf(resultMarker);
      const runnerLog = resultIndex >= 0 ? stderr.slice(0, resultIndex) : stderr;
      const runnerResult = resultIndex >= 0 ? stderr.slice(resultIndex + resultMarker.length).trim() : "";

      if (exitCode !== 0) {
        const error = new Error(runnerLog || `Python exited with code ${exitCode}.`);
        error.logs = { stdout, stderr: runnerLog };
        reject(error);
        return;
      }

      try {
        resolve({
          ...JSON.parse(runnerResult),
          logs: { stdout, stderr: runnerLog }
        });
      } catch {
        const error = new Error(runnerLog || "Python did not return a valid runner response.");
        error.logs = { stdout, stderr: runnerLog };
        reject(error);
      }
    });
  });
}

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.post("/api/improve-code", async (req, res) => {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT || AZURE_CONFIG.endpoint;
  const apiKey = process.env.AZURE_OPENAI_API_KEY || AZURE_CONFIG.apiKey;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || AZURE_CONFIG.deployment;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || AZURE_CONFIG.apiVersion;

  if (!endpoint || !apiKey || apiKey === "paste-your-api-key-here" || !deployment) {
    return res.status(400).json({
      error: "Azure OpenAI is not configured.",
      detail: "Paste your Azure API key into AZURE_CONFIG.apiKey in server/index.js, or set AZURE_OPENAI_API_KEY."
    });
  }

  const { code, instruction, config } = req.body || {};
  if (!code || !instruction) {
    return res.status(400).json({ error: "Code and instruction are required." });
  }

  const baseUrl = endpoint.replace(/\/$/, "");
  const isFoundryEndpoint = baseUrl.includes(".services.ai.azure.com");
  const foundryBaseUrl = baseUrl.endsWith("/api")
    ? baseUrl.slice(0, -4)
    : baseUrl;
  const url = isFoundryEndpoint
    ? `${foundryBaseUrl}/openai/v1/chat/completions`
    : `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  const headers = isFoundryEndpoint
    ? {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      }
    : {
        "Content-Type": "application/json",
        "api-key": apiKey
      };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: deployment,
        messages: [
          {
            role: "system",
            content: [
              "You improve Python code for Workato custom code actions.",
              "Return only the full improved Python code, no markdown fences.",
              "Preserve the main(input_data) function and the expected return shape.",
              "Do not invent secrets, endpoints, files, or unavailable dependencies."
            ].join(" ")
          },
          {
            role: "user",
            content: `Instruction:\n${instruction}\n\nCurrent config:\n${JSON.stringify(config || {}, null, 2)}\n\nCurrent code:\n${code}`
          }
        ],
        temperature: 0.2,
        max_tokens: 4000
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Azure OpenAI request failed.",
        detail: data.error?.message || JSON.stringify(data)
      });
    }

    res.json({
      code: data.choices?.[0]?.message?.content?.trim() || ""
    });
  } catch (error) {
    res.status(500).json({
      error: "Azure OpenAI request failed.",
      detail: error.message
    });
  }
});

app.post("/api/chat", async (req, res) => {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT || AZURE_CONFIG.endpoint;
  const apiKey = process.env.AZURE_OPENAI_API_KEY || AZURE_CONFIG.apiKey;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || AZURE_CONFIG.deployment;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || AZURE_CONFIG.apiVersion;

  if (!endpoint || !apiKey || apiKey === "paste-your-api-key-here" || !deployment) {
    return res.status(400).json({
      error: "Azure OpenAI is not configured.",
      detail: "Paste your Azure API key into AZURE_CONFIG.apiKey in server/index.js, or set AZURE_OPENAI_API_KEY."
    });
  }

  const { messages, code, config } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Messages are required." });
  }

  const baseUrl = endpoint.replace(/\/$/, "");
  const isFoundryEndpoint = baseUrl.includes(".services.ai.azure.com");
  const foundryBaseUrl = baseUrl.endsWith("/api")
    ? baseUrl.slice(0, -4)
    : baseUrl;
  const url = isFoundryEndpoint
    ? `${foundryBaseUrl}/openai/v1/chat/completions`
    : `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  const headers = isFoundryEndpoint
    ? {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      }
    : {
        "Content-Type": "application/json",
        "api-key": apiKey
      };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: deployment,
        messages: [
          {
            role: "system",
            content: [
              "You are an AI assistant inside a CSV transformation/code generation app.",
              "Help the user understand mappings, transformations, Workato Python code, and Azure setup.",
              "When the user asks to change or improve code, include the complete updated Python code in a fenced code block.",
              "Do not reveal secrets or ask the user to paste API keys into chat."
            ].join(" ")
          },
          {
            role: "user",
            content: `Current generated code:\n${code || ""}\n\nCurrent config:\n${JSON.stringify(config || {}, null, 2)}`
          },
          ...messages.slice(-12)
        ],
        temperature: 0.3,
        max_tokens: 4000
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Azure OpenAI chat request failed.",
        detail: data.error?.message || JSON.stringify(data)
      });
    }

    res.json({
      message: data.choices?.[0]?.message?.content?.trim() || ""
    });
  } catch (error) {
    res.status(500).json({
      error: "Azure OpenAI chat request failed.",
      detail: error.message
    });
  }
});

app.post("/api/collections/index", upload.array("files", 20), (req, res) => {
  const collectionId = uuidv4();
  const collectionName = String(req.body.collectionName || "Untitled collection").trim();
  const sources = [];

  (req.files || []).forEach((file) => {
    const extracted = extractTextFromFile(file.path, file.originalname);
    extracted.forEach((item) => {
      const chunks = splitIntoChunks(item.text);
      if (chunks.length > 0) {
        sources.push({
          name: item.name || file.originalname,
          chunks
        });
      }
    });
  });

  const collection = {
    id: collectionId,
    name: collectionName,
    createdAt: new Date().toISOString(),
    sources
  };
  buildChunkIndex(collection);
  collectionsStore.set(collectionId, collection);

  res.json({
    collection: {
      id: collection.id,
      name: collection.name,
      createdAt: collection.createdAt,
      sourceCount: collection.sources.length,
      chunkCount: collection.indexedChunks.length
    }
  });
});

app.get("/api/collections", (req, res) => {
  res.json({
    collections: Array.from(collectionsStore.values()).map((collection) => ({
      id: collection.id,
      name: collection.name,
      createdAt: collection.createdAt,
      sourceCount: collection.sources.length,
      chunkCount: collection.indexedChunks.length
    }))
  });
});

app.post("/api/collections/:collectionId/chat", async (req, res) => {
  const collection = collectionsStore.get(req.params.collectionId);
  if (!collection) {
    return res.status(404).json({ error: "Collection not found." });
  }

  const question = String(req.body.message || "").trim();
  if (!question) {
    return res.status(400).json({ error: "A question is required." });
  }

  const questionTokens = tokenize(question);
  const scored = collection.indexedChunks
    .map((chunk) => ({ ...chunk, score: scoreChunk(chunk, questionTokens) }))
    .filter((chunk) => chunk.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);

  const context = summarizeRetrievedChunks(scored, question);
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT || AZURE_CONFIG.endpoint;
  const apiKey = process.env.AZURE_OPENAI_API_KEY || AZURE_CONFIG.apiKey;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || AZURE_CONFIG.deployment;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || AZURE_CONFIG.apiVersion;

  if (!endpoint || !apiKey || apiKey === "paste-your-api-key-here" || !deployment) {
    return res.json({
      message: `${context}\n\nQuestion: ${question}\n\nReply: I found matching material in the collection, but Azure OpenAI is not configured for a generated answer.`,
      matches: scored.map((chunk) => ({
        sourceName: chunk.sourceName,
        score: chunk.score,
        preview: chunk.text.slice(0, 400)
      }))
    });
  }

  const baseUrl = endpoint.replace(/\/$/, "");
  const isFoundryEndpoint = baseUrl.includes(".services.ai.azure.com");
  const foundryBaseUrl = baseUrl.endsWith("/api") ? baseUrl.slice(0, -4) : baseUrl;
  const url = isFoundryEndpoint
    ? `${foundryBaseUrl}/openai/v1/chat/completions`
    : `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  const headers = isFoundryEndpoint
    ? { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }
    : { "Content-Type": "application/json", "api-key": apiKey };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content:
              "You answer questions using the provided collection context only. If the context is insufficient, say what is missing."
          },
          {
            role: "user",
            content: `${context}\n\nUser question: ${question}`
          }
        ],
        temperature: 0.2
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({
        error: "Collection chat request failed.",
        detail: data.error?.message || JSON.stringify(data)
      });
    }

    res.json({
      message: data.choices?.[0]?.message?.content?.trim() || "",
      matches: scored.map((chunk) => ({
        sourceName: chunk.sourceName,
        score: chunk.score,
        preview: chunk.text.slice(0, 400)
      }))
    });
  } catch (error) {
    res.status(500).json({
      error: "Collection chat failed.",
      detail: error.message,
      matches: scored.map((chunk) => ({
        sourceName: chunk.sourceName,
        score: chunk.score,
        preview: chunk.text.slice(0, 400)
      }))
    });
  }
});

app.post("/api/transform", upload.single("csv"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "CSV file is required." });
  }

  let config;
  try {
    config = JSON.parse(req.body.config || "{}");
  } catch {
    return res.status(400).json({ error: "Invalid transform config JSON." });
  }

  const jobId = uuidv4();
  const outputPath = path.join(downloadDir, `${jobId}.csv`);

  try {
    const result = transformCsvWithJs(req.file.path, config, outputPath);
    res.json({
      message: "Transformation complete.",
      downloadUrl: `/api/download/${jobId}`,
      engineOutput: JSON.stringify(result)
    });
  } catch (error) {
    res.status(500).json({
      error: "CSV transformation failed.",
      detail: error.message
    });
  }
});

app.post("/api/run-python", upload.single("csv"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "CSV file is required." });
  }

  const code = String(req.body.code || "").trim();
  const outputType = req.body.outputType === "json" ? "json" : "csv";

  if (!code) {
    return res.status(400).json({ error: "Python code is required." });
  }

  const jobId = uuidv4();
  const extension = outputType === "json" ? "json" : "csv";
  const outputPath = path.join(downloadDir, `${jobId}.${extension}`);

  try {
    const result = await runPythonSnippet({
      inputPath: req.file.path,
      code,
      outputType,
      outputPath
    });

    res.json({
      message: "Python code executed.",
      outputType,
      preview: result.preview,
      size: result.size,
      logs: result.logs,
      downloadUrl: `/api/download-output/${jobId}.${extension}`
    });
  } catch (error) {
    res.status(500).json({
      error: "Python execution failed.",
      detail: error.message,
      logs: error.logs || { stdout: "", stderr: error.message }
    });
  }
});

app.get("/api/download/:jobId", (req, res) => {
  const outputPath = path.join(downloadDir, `${req.params.jobId}.csv`);

  if (!fs.existsSync(outputPath)) {
    return res.status(404).json({ error: "Transformed CSV not found." });
  }

  res.download(outputPath, "transformed.csv");
});

app.get("/api/download-output/:fileName", (req, res) => {
  const fileName = path.basename(req.params.fileName);
  const outputPath = path.join(downloadDir, fileName);

  if (!/^[a-f0-9-]+\.(csv|json)$/.test(fileName) || !fs.existsSync(outputPath)) {
    return res.status(404).json({ error: "Output file not found." });
  }

  res.download(outputPath, `python-output.${path.extname(fileName).slice(1)}`);
});

if (fs.existsSync(clientDistDir)) {
  app.use(express.static(clientDistDir));
  app.get("*", (req, res) => {
    res.sendFile(path.join(clientDistDir, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`Express API running at http://localhost:${PORT}`);
});
