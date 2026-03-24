import express from "express";

const app = express();
const PORT = 3000;

app.use(express.urlencoded({ extended: true }))
app.use(express.json());

app.get("/api", (req, res) => {
    res.json({ success: true });
});

app.post("/incoming-call", (req, res) => {
    res.type("text/xml");

    res.send(`
        <Response>
            <Say>
                Hello, this is your AI voicemail service.
                Please state your name and issue please after the beep.
            </Say>

            <Record action="/recording" maxLength="30" playBeep="true" />
        </Response>
    `);
});

app.post("/recording", (req, res) => {
    console.log("Recording URL:", req.body.RecordingUrl);
    console.log("From:", req.body.From);

    res.type("text/xml");

    res.send(`
        <Response>
            <Say> Thank you. Goodbye. </Say>
        </Response>
    `);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});