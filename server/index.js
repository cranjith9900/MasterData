const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
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

  fs.writeFileSync(outputPath, writeCsv(outputHeaders, outputRows), "utf-8");

  return {
    rows: outputRows.length,
    columns: outputHeaders,
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
