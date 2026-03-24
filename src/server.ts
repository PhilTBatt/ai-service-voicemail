import express from "express";

const app = express();
const PORT = 3000;

app.use(express.urlencoded({ extended: true }))
app.use(express.json());

app.post("/incoming-call", (req, res) => {
  res.type("text/xml");

  res.send(`
    <Response>
      <Say>Hello, this is your AI voicemail service.</Say>
    </Response>
  `);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});