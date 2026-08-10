# CSV Transformation Desktop

One-folder project:

```text
React UI
  -> Express API
  -> Upload CSV
  -> Python Transformation Engine
  -> Transformed CSV
  -> Download CSV
```

## Run In VS Code

Open this folder:

```powershell
code C:\Users\cranj\Documents\Codex\2026-07-14\ex\outputs\csv-transformation-desktop
```

Install dependencies:

```powershell
npm run install:all
```

Start both React and Express:

```powershell
npm run dev
```

Open:

```text
http://127.0.0.1:5173
```

## Test Flow

Use `sample-input.csv`.

Example mapping:

```text
Target header: code
Source column: Source Column A

Target header: name
Source column: Source Column B

Target header: active
Source column:
Default value: true
```

Optional duplicate keys:

```text
code,name
```

Then click `Transform CSV` and `Download CSV`.

## Python

The Express server uses `PYTHON_PATH` if set. If not, it tries the bundled Codex Python path on this machine, then falls back to `python`.

## Azure OpenAI Code Assistant

Set these environment variables before `npm run dev`:

```powershell
$env:AZURE_OPENAI_ENDPOINT="https://YOUR-RESOURCE.openai.azure.com"
$env:AZURE_OPENAI_API_KEY="YOUR-KEY"
$env:AZURE_OPENAI_DEPLOYMENT="YOUR-DEPLOYMENT-NAME"
$env:AZURE_OPENAI_API_VERSION="2024-02-15-preview"
npm run dev
```

The key stays on the Express server. The browser only calls `/api/improve-code`.
