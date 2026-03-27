import express from "express"
import { config, logger } from "./config.js"
import { validateTwilioSignature } from "./middleware.js"
import routes from "./routes.js"

const app = express()

app.use(express.urlencoded({ extended: true }))
app.use(express.json())

app.use("/api/incoming-call", validateTwilioSignature)
app.use("/api/recording", validateTwilioSignature)
app.use("/api/fallback", validateTwilioSignature)

app.use(routes)

app.listen(config.port, () => {
    logger.info(`Server running on port ${config.port}`)
})