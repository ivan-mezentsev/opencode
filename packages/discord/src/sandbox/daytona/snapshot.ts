import { Daytona as DaytonaSDK } from "@daytonaio/sdk"
import { discordBotImage } from "./service"

const now = () => new Date().toISOString().slice(0, 10).replaceAll("-", "")

const apiKey = process.env["DAYTONA_API_KEY"]?.trim() ?? ""
if (apiKey.length === 0) {
  console.error("DAYTONA_API_KEY is required")
  process.exit(1)
}

const name = Bun.argv[2]?.trim() || `opencode-discord-${now()}`
const regionId = process.env["DAYTONA_REGION_ID"]?.trim() ?? ""

const run = async () => {
  const sdk = new DaytonaSDK({
    apiKey,
    _experimental: {},
  })
  const snapshot = await sdk.snapshot.create(
    regionId.length > 0
      ? {
          name,
          image: discordBotImage,
          regionId,
        }
      : {
          name,
          image: discordBotImage,
        },
    {
      onLogs: (chunk) => process.stdout.write(chunk),
    },
  )
  const active = await sdk.snapshot.activate(snapshot)
  console.log(`snapshot ready: ${active.name}`)
  console.log(`set DAYTONA_SNAPSHOT=${active.name}`)
}

void run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`snapshot creation failed: ${message}`)
  process.exit(1)
})
