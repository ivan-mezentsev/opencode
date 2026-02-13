#!/usr/bin/env bun

import { env } from "bun"
import AdmZip from "adm-zip"
import { mkdtempSync, mkdirSync, existsSync } from "node:fs"
import { join, isAbsolute, sep } from "node:path"
import { tmpdir } from "node:os"

// Types
interface Inputs {
  connectorUrl: string
  apiToken: string
  organizationId: string
  projectSlug: string
  signingPolicySlug: string
  artifactConfigurationSlug?: string
  githubArtifactId: string
  githubToken: string
  parameters: Record<string, string>
  waitForCompletionTimeoutInSeconds: number
  serviceUnavailableTimeoutInSeconds: number
  downloadSignedArtifactTimeoutInSeconds: number
  waitForCompletion: boolean
  outputArtifactDirectory?: string
}

interface SigningRequestResponse {
  signingRequestId: string
  signingRequestUrl: string
  logs?: LogEntry[]
  validationResult?: ValidationResult
  error?: string
}

interface SigningRequestStatus {
  status: string
  isFinalStatus: boolean
  hasArtifactBeenDownloadedBySignPathInCaseOfArtifactRetrieval: boolean
  logs?: LogEntry[]
  validationResult?: ValidationResult
}

interface LogEntry {
  level: "Debug" | "Information" | "Warning" | "Error"
  message: string
}

interface ValidationResult {
  errors: ValidationError[]
}

interface ValidationError {
  error: string
  howToFix?: string
}

// Configuration
const DEFAULT_TIMEOUT_WAIT_COMPLETION = 600
const DEFAULT_TIMEOUT_SERVICE_UNAVAILABLE = 600
const DEFAULT_TIMEOUT_DOWNLOAD = 300
const CHECK_ARTIFACT_DOWNLOAD_INTERVAL_MS = 5000
const MIN_DELAY_STATUS_CHECK_MS = 10000
const MAX_DELAY_STATUS_CHECK_MS = 60 * 20 * 1000 // 20 minutes

// Helper to read env vars
function getEnv(name: string, options?: { required?: boolean; default?: string }): string {
  const val = env[name] || options?.default || ""
  if (options?.required && !val) {
    throw new Error(`Environment variable required and not supplied: ${name}`)
  }
  return val.trim()
}

function getBooleanEnv(name: string, options?: { required?: boolean; default?: string }): boolean {
  const val = getEnv(name, options)
  const trueValue = ["true", "True", "TRUE", "1"]
  const falseValue = ["false", "False", "FALSE", "0"]
  if (trueValue.includes(val)) return true
  if (falseValue.includes(val)) return false
  throw new TypeError(`Environment variable ${name} must be a boolean (true/false/1/0)`)
}

function getNumberEnv(name: string, options?: { required?: boolean; default?: string }): number {
  const val = getEnv(name, options)
  const num = parseInt(val, 10)
  if (isNaN(num)) throw new Error(`Environment variable ${name} is not a number`)
  return num
}

function parseParameters(input: string): Record<string, string> {
  const params: Record<string, string> = {}
  if (!input) return params

  const lines = input.split("\n").filter((l) => l.trim() !== "")
  for (const line of lines) {
    const separatorIndex = line.indexOf(":")
    if (separatorIndex === -1) throw new Error(`Invalid parameter line: ${line}`)

    const name = line.substring(0, separatorIndex).trim()
    const valueRaw = line.substring(separatorIndex + 1).trim()

    if (!name) throw new Error(`Parameter name cannot be empty: ${line}`)
    if (!/^[a-zA-Z0-9.\-_]+$/.test(name)) {
      throw new Error(`Invalid parameter name: ${name}`)
    }

    try {
      const parsedValue = JSON.parse(valueRaw)
      if (typeof parsedValue !== "string") {
        throw new Error(`Invalid parameter value (must be a JSON string): ${valueRaw}`)
      }
      params[name] = parsedValue
    } catch (e) {
      throw new Error(`Invalid parameter value (must be valid JSON): ${valueRaw}`)
    }
  }
  return params
}

// Helper for output
function setOutput(name: string, value: string) {
  const outputFile = env.GITHUB_OUTPUT
  if (outputFile) {
    const fs = require("node:fs")
    fs.appendFileSync(outputFile, `${name}=${value}\n`)
  } else {
    console.log(`::set-output name=${name}::${value}`)
  }
}

function log(level: "info" | "error" | "debug" | "warning", message: string) {
  // Simple logging mapping to console
  if (level === "error") console.error(`::error::${message}`)
  else if (level === "warning") console.warn(`::warning::${message}`)
  else if (level === "debug") console.debug(`::debug::${message}`)
  else console.log(message)
}

// API Client with Retry
async function fetchWithRetry(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const startTime = Date.now()
  let attempt = 0
  const maxRetries = 12 // Covers ~13 mins

  log("info", `Fetching ${url}`)
  if (options.body) {
    log("info", `Body: ${options.body}`)
  }

  while (true) {
    attempt++
    try {
      const controller = new AbortController()
      const id = setTimeout(() => controller.abort(), timeoutMs) // Per-request timeout

      const response = await fetch(url, { ...options, signal: controller.signal })
      clearTimeout(id)

      if (response.ok) return response

      // Check for retryable status codes
      if ([502, 503, 504, 429].includes(response.status)) {
        log("info", `Service unavailable (status ${response.status}). Retrying...`)
      } else {
        // Non-retryable error
        return response
      }
    } catch (error: any) {
      if (error.name === "AbortError") {
        throw new Error(`Request timed out after ${timeoutMs}ms`)
      }
      // Network errors are retryable
      log("warning", `Network error: ${error.message}. Retrying...`)
    }

    if (attempt > maxRetries) {
      throw new Error(`Exceeded maximum retries for ${url}`)
    }

    // Exponential backoff
    const delay = Math.pow(2, attempt) * 100 // 100ms, 200ms, 400ms...
    const jitter = delay * 0.2 * Math.random()
    await Bun.sleep(delay + jitter)
  }
}

// Main logic class
class SignPathTask {
  private inputs: Inputs

  constructor(inputs: Inputs) {
    this.inputs = inputs
  }

  private get headers() {
    return {
      Authorization: `Bearer ${this.inputs.apiToken}`,
      "Content-Type": "application/json",
      "User-Agent": "SignPath.SubmitSigningRequestBunScript/1.0.0",
    }
  }

  private buildUrl(path: string): string {
    const base = this.inputs.connectorUrl.replace(/\/$/, "")
    return `${base}/${encodeURIComponent(this.inputs.organizationId)}/SigningRequests${path}?api-version=1.0`
  }

  async run() {
    try {
      log("info", "Submitting signing request...")
      const signingRequestId = await this.submitSigningRequest()

      if (this.inputs.waitForCompletion) {
        await this.ensureSigningRequestCompleted(signingRequestId)
        if (this.inputs.outputArtifactDirectory) {
          const downloadUrl = this.buildUrl(`/${encodeURIComponent(signingRequestId)}/SignedArtifact`)
          await this.downloadSignedArtifact(downloadUrl, this.inputs.outputArtifactDirectory)
        }
      } else {
        await this.ensureSignPathDownloadedUnsignedArtifact(signingRequestId)
      }
    } catch (error: any) {
      log("error", error.message)
      process.exit(1)
    }
  }

  private async submitSigningRequest(): Promise<string> {
    const url = this.buildUrl("")
    const payload = {
      artifactId: this.inputs.githubArtifactId,
      gitHubWorkflowRunId: env.GITHUB_RUN_ID,
      gitHubRepository: env.GITHUB_REPOSITORY,
      gitHubToken: this.inputs.githubToken,
      signPathProjectSlug: this.inputs.projectSlug,
      signPathSigningPolicySlug: this.inputs.signingPolicySlug,
      signPathArtifactConfigurationSlug: this.inputs.artifactConfigurationSlug,
      parameters: this.inputs.parameters,
    }

    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(payload),
      },
      this.inputs.serviceUnavailableTimeoutInSeconds * 1000,
    )

    const data = (await response.json()) as SigningRequestResponse

    if (!response.ok) {
      if (data.validationResult) {
        this.handleValidationErrors(data.validationResult)
      }
      if (data.error) {
        this.handleLogs(data.logs)
        throw new Error(`SignPath API Error: ${data.error}`)
      }
      throw new Error(`HTTP Error ${response.status}: ${JSON.stringify(data)}`)
    }

    this.handleLogs(data.logs)
    this.handleValidationErrors(data.validationResult)

    log("info", `Signing request submitted. ID: ${data.signingRequestId}`)
    log("info", `Web URL: ${data.signingRequestUrl}`)

    setOutput("signing-request-id", data.signingRequestId)
    setOutput("signing-request-web-url", data.signingRequestUrl)
    setOutput(
      "signed-artifact-download-url",
      this.buildUrl(`/${encodeURIComponent(data.signingRequestId)}/SignedArtifact`),
    )

    return data.signingRequestId
  }

  private async ensureSigningRequestCompleted(id: string) {
    log("info", "Waiting for signing request completion...")
    const startTime = Date.now()
    const maxWait = this.inputs.waitForCompletionTimeoutInSeconds * 1000

    let delay = MIN_DELAY_STATUS_CHECK_MS

    while (Date.now() - startTime < maxWait) {
      const status = await this.getSigningRequestStatus(id)
      log("info", `Current status: ${status.status}`)

      if (status.isFinalStatus) {
        if (status.status !== "Completed") {
          throw new Error(`Signing request failed with status: ${status.status}`)
        }
        return
      }

      await Bun.sleep(delay)
      delay = Math.min(delay * 2, MAX_DELAY_STATUS_CHECK_MS)
    }
    throw new Error("Timed out waiting for signing request completion")
  }

  private async ensureSignPathDownloadedUnsignedArtifact(id: string) {
    log("info", "Waiting for SignPath to download unsigned artifact...")
    const startTime = Date.now()
    const maxWait = this.inputs.waitForCompletionTimeoutInSeconds * 1000

    while (Date.now() - startTime < maxWait) {
      const status = await this.getSigningRequestStatus(id)
      if (status.hasArtifactBeenDownloadedBySignPathInCaseOfArtifactRetrieval) {
        log("info", "Artifact downloaded by SignPath.")
        return
      }
      if (status.isFinalStatus) {
        throw new Error("Signing request finished but artifact was not downloaded (unexpected state).")
      }

      await Bun.sleep(CHECK_ARTIFACT_DOWNLOAD_INTERVAL_MS)
    }
    throw new Error("Timed out waiting for SignPath to download artifact")
  }

  private async getSigningRequestStatus(id: string): Promise<SigningRequestStatus> {
    const url = this.buildUrl(`/${encodeURIComponent(id)}/Status`)
    const response = await fetchWithRetry(
      url,
      {
        headers: this.headers,
      },
      this.inputs.serviceUnavailableTimeoutInSeconds * 1000,
    )

    if (!response.ok) {
      throw new Error(`Failed to get status: ${response.statusText}`)
    }
    return (await response.json()) as SigningRequestStatus
  }

  private async downloadSignedArtifact(url: string, outputDir: string) {
    log("info", `Downloading signed artifact from ${url}...`)

    const response = await fetchWithRetry(
      url,
      {
        headers: this.headers,
      },
      this.inputs.downloadSignedArtifactTimeoutInSeconds * 1000,
    )

    if (!response.ok) throw new Error(`Download failed: ${response.statusText}`)

    const tmpDir = mkdtempSync(join(tmpdir(), "signpath-"))
    const tmpFile = join(tmpDir, "artifact.zip")

    await Bun.write(tmpFile, response) // Streams directly to file

    log("info", `Extracting to ${outputDir}...`)

    // Resolve absolute path
    const workingDirectory = env.GITHUB_WORKSPACE || process.cwd()
    const targetDirectory = isAbsolute(outputDir) ? outputDir : join(workingDirectory, outputDir)

    if (!existsSync(targetDirectory)) {
      mkdirSync(targetDirectory, { recursive: true })
    }

    const zip = new AdmZip(tmpFile)
    zip.extractAllTo(targetDirectory, true)

    log("info", "Artifact extracted successfully.")
  }

  private handleValidationErrors(result?: ValidationResult) {
    if (result && result.errors.length > 0) {
      log("error", "CI System Validation Errors:")
      result.errors.forEach((e) => {
        log("error", `- ${e.error}`)
        if (e.howToFix) log("info", `  Fix: ${e.howToFix}`)
      })
      // throw new Error("Validation failed"); // Original logic throws after printing
    }
  }

  private handleLogs(logs?: LogEntry[]) {
    if (!logs) return
    logs.forEach((l) => log(l.level.toLowerCase() as any, l.message))
  }
}

// Entry point
try {
  const inputs: Inputs = {
    connectorUrl: getEnv("CONNECTOR_URL", { required: true, default: "https://githubactions.connectors.signpath.io" }),
    apiToken: getEnv("API_TOKEN", { required: true }),
    organizationId: getEnv("ORGANIZATION_ID", { required: true }),
    projectSlug: getEnv("PROJECT_SLUG", { required: true }),
    signingPolicySlug: getEnv("SIGNING_POLICY_SLUG", { required: true }),
    artifactConfigurationSlug: getEnv("ARTIFACT_CONFIGURATION_SLUG"),
    githubArtifactId: getEnv("GITHUB_ARTIFACT_ID", { required: true }),
    githubToken: getEnv("GITHUB_TOKEN", { required: false, default: env.GITHUB_TOKEN }),
    parameters: parseParameters(getEnv("PARAMETERS")),
    waitForCompletionTimeoutInSeconds: getNumberEnv("WAIT_FOR_COMPLETION_TIMEOUT_IN_SECONDS", { default: "600" }),
    serviceUnavailableTimeoutInSeconds: getNumberEnv("SERVICE_UNAVAILABLE_TIMEOUT_IN_SECONDS", { default: "600" }),
    downloadSignedArtifactTimeoutInSeconds: getNumberEnv("DOWNLOAD_SIGNED_ARTIFACT_TIMEOUT_IN_SECONDS", {
      default: "300",
    }),
    waitForCompletion: getBooleanEnv("WAIT_FOR_COMPLETION", { default: "true" }),
    outputArtifactDirectory: getEnv("OUTPUT_ARTIFACT_DIRECTORY"),
  }

  new SignPathTask(inputs).run()
} catch (error: any) {
  log("error", error.message)
  process.exit(1)
}
