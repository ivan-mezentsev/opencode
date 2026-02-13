#!/usr/bin/env bun

import * as fs from "fs"
import * as path from "path"
import AdmZip from "adm-zip"

// ── Version ──────────────────────────────────────────────────────────
const taskVersion = "2.0.0"

// ── Config ───────────────────────────────────────────────────────────
const MinDelayBetweenSigningRequestStatusChecksInSeconds = 10
const MaxDelayBetweenSigningRequestStatusChecksInSeconds = 60 * 20
const CheckArtifactDownloadStatusIntervalInSeconds = 5

// ── Helpers ──────────────────────────────────────────────────────────

function requiredEnv(name: string): string {
  const val = process.env[name]
  if (!val) {
    throw new Error(`Required environment variable not set: ${name}`)
  }
  return val.trim()
}

function optionalEnv(name: string, defaultValue = ""): string {
  return (process.env[name] ?? defaultValue).trim()
}

function optionalEnvNumber(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (!raw) return defaultValue
  const n = parseInt(raw, 10)
  if (isNaN(n)) throw new Error(`Environment variable ${name} is not a number`)
  return n
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = String(Math.floor(totalSec / 3600)).padStart(2, "0")
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0")
  const s = String(totalSec % 60).padStart(2, "0")
  return `${h}:${m}:${s}`
}

function humanizeDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec} seconds`
  const mins = Math.round(totalSec / 60)
  if (mins < 60) return `${mins} minute${mins !== 1 ? "s" : ""}`
  const hrs = Math.round(mins / 60)
  return `${hrs} hour${hrs !== 1 ? "s" : ""}`
}

// ── Log levels ───────────────────────────────────────────────────────
const LogLevelDebug = "Debug"
const LogLevelInformation = "Information"
const LogLevelWarning = "Warning"
const LogLevelError = "Error"

// ── Per-call options ─────────────────────────────────────────────────

export interface SignOptions {
  artifactId: string
  outputDirectory: string
}

// ── Input (from env vars) ────────────────────────────────────────────

const connectorUrl = optionalEnv("CONNECTOR_URL", "https://githubactions.connectors.signpath.io")
const apiToken = requiredEnv("API_TOKEN")
const organizationId = requiredEnv("ORGANIZATION_ID")
const projectSlug = requiredEnv("PROJECT_SLUG")
const signingPolicySlug = requiredEnv("SIGNING_POLICY_SLUG")
const artifactConfigurationSlug = optionalEnv("ARTIFACT_CONFIGURATION_SLUG")
const gitHubToken = optionalEnv("GITHUB_TOKEN")
const parametersRaw = optionalEnv("PARAMETERS")
const waitForCompletionTimeoutInSeconds = optionalEnvNumber("WAIT_FOR_COMPLETION_TIMEOUT_IN_SECONDS", 600)
const serviceUnavailableTimeoutInSeconds = optionalEnvNumber("SERVICE_UNAVAILABLE_TIMEOUT_IN_SECONDS", 600)
const downloadSignedArtifactTimeoutInSeconds = optionalEnvNumber("DOWNLOAD_SIGNED_ARTIFACT_TIMEOUT_IN_SECONDS", 300)
const waitForCompletion = optionalEnv("WAIT_FOR_COMPLETION", "true") === "true"

// ── Parse user-defined parameters ────────────────────────────────────

interface UserDefinedParameter {
  name: string
  value: string
}

function parseUserDefinedParameters(raw: string): UserDefinedParameter[] {
  if (!raw) return []
  return raw
    .split("\n")
    .map((line) => parseUserDefinedParameter(line))
    .filter((p): p is UserDefinedParameter => p !== null)
}

function parseUserDefinedParameter(line: string): UserDefinedParameter | null {
  if (!line) return null
  const sepIdx = line.indexOf(":")
  if (sepIdx === -1) throw new Error(`Invalid parameter line: ${line}`)
  const name = line.substring(0, sepIdx).trim()
  const value = line.substring(sepIdx + 1).trim()
  if (!name) throw new Error(`Parameter name cannot be empty. Line: ${line}`)
  if (!/^[a-zA-Z0-9.\-_]+$/.test(name))
    throw new Error(
      `Invalid parameter name: ${name}. Only alphanumeric characters, dots, dashes and underscores are allowed.`,
    )
  let parsedValue: unknown
  try {
    parsedValue = JSON.parse(value)
  } catch (e) {
    throw new Error(`Invalid parameter value: ${value} - ${e}. Only valid JSON strings are allowed.`)
  }
  if (typeof parsedValue !== "string")
    throw new Error(`Invalid parameter value: ${value}. Only valid JSON strings are allowed.`)
  return { name, value: parsedValue }
}

const parameters = parseUserDefinedParameters(parametersRaw)

// ── Connector URL builder ────────────────────────────────────────────

function trimSlash(text: string): string {
  return text.endsWith("/") ? text.slice(0, -1) : text
}

const apiVersion = "1.0"
const baseConnectorUrl = trimSlash(connectorUrl)
const baseSigningRequestsRoute = `${baseConnectorUrl}/${encodeURIComponent(organizationId)}/SigningRequests`

function buildSubmitSigningRequestUrl(): string {
  return `${baseSigningRequestsRoute}?api-version=${apiVersion}`
}

function buildGetSigningRequestStatusUrl(signingRequestId: string): string {
  return `${baseSigningRequestsRoute}/${encodeURIComponent(signingRequestId)}/Status?api-version=${apiVersion}`
}

function buildGetSignedArtifactUrl(signingRequestId: string): string {
  return `${baseSigningRequestsRoute}/${encodeURIComponent(signingRequestId)}/SignedArtifact?api-version=${apiVersion}`
}

// ── Fetch with retry ─────────────────────────────────────────────────

const userAgent = `SignPath.SubmitSigningRequestGitHubAction/${taskVersion}(Bun/${Bun.version}; ${process.platform} ${process.arch})`

const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504])
const MAX_RETRY_COUNT = 12

async function fetchWithRetry(url: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    Authorization: `Bearer ${apiToken}`,
    ...(init.headers as Record<string, string> | undefined),
  }

  const timeoutMs = serviceUnavailableTimeoutInSeconds * 1000
  let delayMs = 100

  for (let attempt = 0; attempt <= MAX_RETRY_COUNT; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      console.debug(`Sending request: ${(init.method ?? "GET").toUpperCase()} ${url}`)

      const response = await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      })

      clearTimeout(timer)

      console.debug(`Received response: ${response.status} ${response.statusText} from ${url}`)

      if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < MAX_RETRY_COUNT) {
        if (response.status === 429) {
          console.log("SignPath REST API encountered too many requests.")
        } else {
          console.log(`SignPath REST API is temporarily unavailable (server responded with ${response.status}).`)
        }
        // exponential back-off with 20% jitter
        const jitter = 1 + (Math.random() * 0.4 - 0.2)
        await Bun.sleep(delayMs * jitter)
        delayMs *= 2
        continue
      }

      return response
    } catch (err: any) {
      clearTimeout(timer)

      if (err.name === "AbortError") {
        throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`)
      }

      // network error – retry if attempts remain
      if (attempt < MAX_RETRY_COUNT) {
        const jitter = 1 + (Math.random() * 0.4 - 0.2)
        await Bun.sleep(delayMs * jitter)
        delayMs *= 2
        continue
      }

      throw err
    }
  }

  throw new Error(`Max retries exceeded for ${url}`)
}

// ── Helpers for HTTP error text ──────────────────────────────────────

function httpErrorResponseToText(status: number, statusText: string, body: unknown): string {
  if (body) {
    if (typeof body === "string") return body
    if (typeof body === "object") return JSON.stringify(body)
  }
  return `${status} ${statusText}`
}

// ── Execute with retries (polling) ───────────────────────────────────

interface RetryResult<T> {
  retry: boolean
  result?: T
}

async function executeWithRetries<T>(
  fn: () => Promise<RetryResult<T>>,
  maxTotalWaitingTimeMs: number,
  minDelayMs: number,
  maxDelayMs: number,
): Promise<T> {
  const startTime = Date.now()
  let delayMs = minDelayMs

  while (true) {
    const result = await fn()
    if (result.retry === false) {
      return result.result as T
    }

    const totalWaitingTimeMs = Date.now() - startTime
    if (totalWaitingTimeMs > maxTotalWaitingTimeMs) {
      const waitingTime = formatDuration(totalWaitingTimeMs)
      throw new Error(`The operation has timed out after ${waitingTime}`)
    }

    console.log(`Next check in ${humanizeDuration(delayMs)}`)
    await Bun.sleep(delayMs)
    delayMs = Math.min(delayMs * 2, maxDelayMs)
  }
}

// ── Signing request status DTO ───────────────────────────────────────

interface SigningRequestStatusDto {
  status: string
  isFinalStatus: boolean
  hasArtifactBeenDownloadedBySignPathInCaseOfArtifactRetrieval: boolean
}

// ── Submit signing request response ──────────────────────────────────

interface SubmitSigningRequestResponse {
  signingRequestId: string
  signingRequestUrl: string
  validationResult?: {
    errors: Array<{ error: string; howToFix?: string }>
  }
  logs?: Array<{ level: string; message: string }>
  error?: string
}

// ── Output helpers ───────────────────────────────────────────────────
// Outputs are printed to stdout so callers can parse them.

function setOutput(name: string, value: string): void {
  console.log(`::output:: ${name}=${value}`)
}

// ── Redirect connector logs ──────────────────────────────────────────

function redirectConnectorLogsToActionLogs(logs?: Array<{ level: string; message: string }>): void {
  if (!logs || logs.length === 0) return
  for (const log of logs) {
    switch (log.level) {
      case LogLevelDebug:
        console.debug(log.message)
        break
      case LogLevelInformation:
        console.log(log.message)
        break
      case LogLevelWarning:
        console.warn(log.message)
        break
      case LogLevelError:
        console.error(log.message)
        break
      default:
        console.log(`${log.level}:${log.message}`)
        break
    }
  }
}

// ── Validation result check ──────────────────────────────────────────

function checkCiSystemValidationResult(
  artifactId: string,
  validationResult?: SubmitSigningRequestResponse["validationResult"],
): void {
  if (validationResult && validationResult.errors.length > 0) {
    console.error(
      `Build artifact with id "${artifactId}" cannot be signed because of continuous integration system setup validation errors:`,
    )
    for (const ve of validationResult.errors) {
      console.error(ve.error)
      if (ve.howToFix) console.log(ve.howToFix)
    }
    throw new Error("CI system validation failed.")
  }
}

// ── Submit signing request ───────────────────────────────────────────

async function submitSigningRequest(artifactId: string): Promise<string> {
  const submitUrl = buildSubmitSigningRequestUrl()
  console.log("Submitting the signing request to SignPath GitHub Actions connector...")

  const payload = {
    artifactId,
    gitHubWorkflowRunId: process.env.GITHUB_RUN_ID,
    gitHubRepository: process.env.GITHUB_REPOSITORY,
    gitHubToken: gitHubToken,
    signPathProjectSlug: projectSlug,
    signPathSigningPolicySlug: signingPolicySlug,
    signPathArtifactConfigurationSlug: artifactConfigurationSlug || undefined,
    parameters: parameters.length > 0 ? parameters : undefined,
  }

  const resp = await fetchWithRetry(submitUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })

  const body = (await resp.json()) as SubmitSigningRequestResponse

  if (!resp.ok) {
    if (body.error) {
      redirectConnectorLogsToActionLogs(body.logs)
      checkCiSystemValidationResult(artifactId, body.validationResult)
      throw new Error(body.error)
    }

    // If the response has validationResult, it's a connector validation response (not a hard error)
    if (!body.validationResult && !body.signingRequestId) {
      throw new Error(httpErrorResponseToText(resp.status, resp.statusText, body))
    }
  }

  // Check response structure
  if (!body.validationResult && !body.signingRequestId) {
    console.error(`Unexpected response from the SignPath connector: ${JSON.stringify(body)}`)
    throw new Error(
      "SignPath signing request was not created. Please make sure that connector-url is pointing to the SignPath GitHub Actions connector endpoint.",
    )
  }

  redirectConnectorLogsToActionLogs(body.logs)
  checkCiSystemValidationResult(artifactId, body.validationResult)

  console.log("SignPath signing request has been successfully submitted")
  console.log(`The signing request id is ${body.signingRequestId}`)
  console.log(`You can view the signing request here: ${body.signingRequestUrl}`)

  setOutput("signing-request-id", body.signingRequestId)
  setOutput("signing-request-web-url", body.signingRequestUrl)
  setOutput("signed-artifact-download-url", buildGetSignedArtifactUrl(body.signingRequestId))

  return body.signingRequestId
}

// ── Get signing request status ───────────────────────────────────────

async function getSigningRequestStatus(signingRequestId: string): Promise<SigningRequestStatusDto> {
  const statusUrl = buildGetSigningRequestStatusUrl(signingRequestId)

  const resp = await fetchWithRetry(statusUrl)

  if (!resp.ok) {
    const bodyText = await resp.text()
    console.error(`SignPath API call error: ${resp.status} ${resp.statusText}`)
    console.error(`Signing request details API URL is: ${statusUrl}`)
    throw new Error(httpErrorResponseToText(resp.status, resp.statusText, bodyText))
  }

  return (await resp.json()) as SigningRequestStatusDto
}

// ── Ensure SignPath downloaded unsigned artifact ──────────────────────

async function ensureSignPathDownloadedUnsignedArtifact(signingRequestId: string): Promise<void> {
  console.log("Waiting until SignPath downloaded the unsigned artifact...")

  const requestData = await executeWithRetries(
    async () => {
      const data = await getSigningRequestStatus(signingRequestId)
      if (!data.hasArtifactBeenDownloadedBySignPathInCaseOfArtifactRetrieval && !data.isFinalStatus) {
        console.log("Checking the download status: not yet complete")
        return { retry: true }
      }
      return { retry: false, result: data }
    },
    waitForCompletionTimeoutInSeconds * 1000,
    CheckArtifactDownloadStatusIntervalInSeconds * 1000,
    CheckArtifactDownloadStatusIntervalInSeconds * 1000,
  )

  if (!requestData.hasArtifactBeenDownloadedBySignPathInCaseOfArtifactRetrieval) {
    if (!requestData.isFinalStatus) {
      const maxWaitingTime = formatDuration(waitForCompletionTimeoutInSeconds * 1000)
      console.error(
        `We have exceeded the maximum waiting time, which is ${maxWaitingTime}, and the GitHub artifact is still not downloaded by SignPath`,
      )
    } else {
      console.error(
        "The signing request is in its final state, but the GitHub artifact has not been downloaded by SignPath.",
      )
    }
    throw new Error("The GitHub artifact is not downloaded by SignPath")
  } else {
    console.log("The unsigned GitHub artifact has been successfully downloaded by SignPath")
  }
}

// ── Ensure signing request completed ─────────────────────────────────

async function ensureSigningRequestCompleted(signingRequestId: string): Promise<SigningRequestStatusDto> {
  console.log("Checking the signing request status...")

  const requestData = await executeWithRetries(
    async () => {
      const data = await getSigningRequestStatus(signingRequestId)
      if (data && !data.isFinalStatus) {
        console.log(
          `The signing request status is ${data.status}, which is not a final status; after a delay, we will check again...`,
        )
        return { retry: true }
      }
      return { retry: false, result: data }
    },
    waitForCompletionTimeoutInSeconds * 1000,
    MinDelayBetweenSigningRequestStatusChecksInSeconds * 1000,
    MaxDelayBetweenSigningRequestStatusChecksInSeconds * 1000,
  )

  console.log(`Signing request status is ${requestData.status}`)

  if (!requestData.isFinalStatus) {
    const maxWaitingTime = formatDuration(waitForCompletionTimeoutInSeconds * 1000)
    console.error(
      `We have exceeded the maximum waiting time, which is ${maxWaitingTime}, and the signing request is still not in a final state`,
    )
    throw new Error(`The signing request is not completed. The current status is "${requestData.status}"`)
  } else if (requestData.status !== "Completed") {
    throw new Error(`The signing request is not completed. The final status is "${requestData.status}"`)
  }

  return requestData
}

// ── Download signed artifact ─────────────────────────────────────────

async function downloadSignedArtifact(artifactDownloadUrl: string, outputDirectory: string): Promise<void> {
  console.log(`Signed artifact url ${artifactDownloadUrl}`)

  const timeoutMs = downloadSignedArtifactTimeoutInSeconds * 1000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let resp: Response
  try {
    resp = await fetch(artifactDownloadUrl, {
      headers: {
        "User-Agent": userAgent,
        Authorization: `Bearer ${apiToken}`,
      },
      signal: controller.signal,
    })
  } catch (err: any) {
    clearTimeout(timer)
    if (err.name === "AbortError") {
      throw new Error(`Timeout of ${timeoutMs}ms exceeded while downloading the signed artifact from SignPath`)
    }
    throw err
  }

  if (!resp.ok) {
    clearTimeout(timer)
    const bodyText = await resp.text()
    throw new Error(httpErrorResponseToText(resp.status, resp.statusText, bodyText))
  }

  const targetDirectory = resolveOrCreateDirectory(outputDirectory)
  console.log(`The signed artifact is being downloaded from SignPath and will be saved to ${targetDirectory}`)

  const arrayBuffer = await resp.arrayBuffer()
  clearTimeout(timer)
  const buffer = Buffer.from(arrayBuffer)

  console.debug(`Downloaded ${buffer.length} bytes`)

  // Extract zip to target directory
  const zip = new AdmZip(buffer)
  zip.extractAllTo(targetDirectory, true)

  console.log(`The signed artifact has been successfully downloaded from SignPath and extracted to ${targetDirectory}`)
}

function resolveOrCreateDirectory(directoryPath: string): string {
  const workingDirectory = process.cwd()
  const absolutePath = path.isAbsolute(directoryPath) ? directoryPath : path.join(workingDirectory, directoryPath)

  if (!fs.existsSync(absolutePath)) {
    console.log(`Directory "${absolutePath}" does not exist and will be created`)
    fs.mkdirSync(absolutePath, { recursive: true })
  }

  return absolutePath
}

// ── Main ─────────────────────────────────────────────────────────────

export async function sign(options: SignOptions) {
  const signingRequestId = await submitSigningRequest(options.artifactId)

  if (waitForCompletion) {
    await ensureSigningRequestCompleted(signingRequestId)
    if (options.outputDirectory) {
      await downloadSignedArtifact(buildGetSignedArtifactUrl(signingRequestId), options.outputDirectory)
    }
  } else {
    await ensureSignPathDownloadedUnsignedArtifact(signingRequestId)
  }
}

// ── CLI entry point ──────────────────────────────────────────────────

if (import.meta.main) {
  sign({
    artifactId: requiredEnv("GITHUB_ARTIFACT_ID"),
    outputDirectory: optionalEnv("OUTPUT_ARTIFACT_DIRECTORY"),
  }).catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
